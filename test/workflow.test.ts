import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEEN_URLS_CHUNK_SIZE, startRun, writeRunCandidates } from '../src/lib/d1';
import { loadFeeds } from '../src/lib/feeds';
import { InvalidDraftError } from '../src/lib/mdx';
import type { ArticleSummary, Candidate, Draft, Env, GatherParams, Topic } from '../src/lib/types';
import {
  createGatherChildren,
  DUPLICATE_TOKEN_THRESHOLD,
  isGrounded,
  openPullRequest,
  pollGatherChildren,
  proposeTopic,
  selectTopic,
  SHORTLIST_MAX_CANDIDATES,
  SHORTLIST_TOP_N,
  shortlistCandidates,
  summarizeArticle,
  synthesizeDraft,
  TOPIC_CLAIM_TTL_HOURS,
} from '../src/workflow';
import { applySchema } from './schema';

const rawEnv = testEnv as unknown as Env;
const env: Env = {
  ...rawEnv,
  BLOG_FEED_URL: 'https://blog.test.example/rss.xml',
  BLOG_REPO: 'nimeshjm/nimeshjm.com',
  GITHUB_API_BASE: 'https://api.test.example',
  GITHUB_TOKEN: 'test-token',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

async function resetSchema(): Promise<void> {
  for (const table of ['drafts', 'runs', 'run_candidates', 'seen_urls', 'topics']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

// Schema setup lives in ./schema.ts, shared with test/d1.test.ts.
beforeEach(async () => {
  await applySchema(env.DB);
  await resetSchema();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function rssFeed(items: Array<{ title: string; url: string; pubDate?: string }>): string {
  const itemXml = items
    .map(
      (i) => `<item>
<title>${i.title}</title>
<link>${i.url}</link>
<guid isPermaLink="false">not-a-url-guid</guid>
${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ''}
</item>`,
    )
    .join('\n');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${itemXml}</channel></rss>`;
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    url: 'https://example.com/x',
    title: 'x',
    publishedAt: '2026-08-27T00:00:00Z',
    publishedMs: null,
    sourceName: 'Test Source',
    ...overrides,
  };
}

function topic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 1,
    title: 'Agentic code review practices',
    angle: 'What actually catches bugs',
    status: 'in_progress',
    origin: 'human',
    createdAt: '2026-08-27T00:00:00Z',
    ...overrides,
  };
}

/**
 * A stateful fake of the `GATHER_WORKFLOW` binding surface `createGatherChildren`
 * and `pollGatherChildren` touch - `createBatch` (create-time) and `get` (poll-time).
 * `createBatch` throws when *any* supplied id already exists, matching
 * `index.d.ts`'s documented behaviour (`WorkflowInstanceCreateOptions` /
 * `Workflow.createBatch`) - not plan.md's "skips existing ids outright",
 * which this fake deliberately does NOT implement, so a test against it
 * would fail if `createGatherChildren` ever came to rely on that wrong
 * premise instead of verifying via `get`.
 */
function fakeGatherWorkflow(): {
  binding: Env['GATHER_WORKFLOW'];
  created: Map<string, GatherParams>;
  setStatus: (id: string, status: InstanceStatus) => void;
} {
  const created = new Map<string, GatherParams>();
  const statuses = new Map<string, InstanceStatus>();

  const binding = {
    createBatch: async (options: WorkflowInstanceCreateOptions<GatherParams>[]) => {
      for (const o of options) {
        if (o.id !== undefined && created.has(o.id)) {
          throw new Error(`Workflow instance ${o.id} already exists`);
        }
      }
      for (const o of options) {
        if (o.id === undefined) continue;
        created.set(o.id, o.params as GatherParams);
        if (!statuses.has(o.id)) statuses.set(o.id, { status: 'complete', output: 0 });
      }
      return options.map((o) => ({ id: o.id }) as unknown as WorkflowInstance);
    },
    get: async (id: string) => {
      if (!created.has(id)) throw new Error(`Workflow instance ${id} does not exist`);
      return { id, status: async () => statuses.get(id) ?? { status: 'complete', output: 0 } } as unknown as WorkflowInstance;
    },
  } as unknown as Env['GATHER_WORKFLOW'];

  return { binding, created, setStatus: (id, status) => statuses.set(id, status) };
}

describe('createGatherChildren()', () => {
  it('chunks sources into GATHER_FEEDS_PER_CHILD-sized groups with deterministic ids', async () => {
    const fake = fakeGatherWorkflow();
    const gatherEnv: Env = { ...env, GATHER_WORKFLOW: fake.binding, GATHER_FEEDS_PER_CHILD: '3' };
    const sources = Array.from({ length: 7 }, (_, i) => ({ name: `Feed ${i}`, feedUrl: `https://feed.test.example/${i}.xml` }));

    const ids = await createGatherChildren(gatherEnv, 'parent-1', sources);

    expect(ids).toEqual(['parent-1-g0', 'parent-1-g1', 'parent-1-g2']);
    expect(fake.created.get('parent-1-g0')?.sources).toHaveLength(3);
    expect(fake.created.get('parent-1-g1')?.sources).toHaveLength(3);
    expect(fake.created.get('parent-1-g2')?.sources).toHaveLength(1);
    // runId on every child is the PARENT's instance id, not a child-specific one.
    expect(fake.created.get('parent-1-g0')?.runId).toBe('parent-1');
    expect(fake.created.get('parent-1-g2')?.index).toBe(2);
  });

  it('is idempotent on replay: a second call against an already-created id set does not throw and returns the same ids', async () => {
    const fake = fakeGatherWorkflow();
    const gatherEnv: Env = { ...env, GATHER_WORKFLOW: fake.binding, GATHER_FEEDS_PER_CHILD: '3' };
    const sources = Array.from({ length: 4 }, (_, i) => ({ name: `Feed ${i}`, feedUrl: `https://feed.test.example/${i}.xml` }));

    const first = await createGatherChildren(gatherEnv, 'parent-replay', sources);
    // createBatch would throw here for real (index.d.ts: "if a provided id
    // exists, an error will be thrown") - this proves that is recovered
    // rather than propagated.
    const second = await createGatherChildren(gatherEnv, 'parent-replay', sources);

    expect(second).toEqual(first);
    expect(fake.created.size).toBe(2); // not doubled
  });

  it('a genuine creation failure (not a duplicate id) still throws', async () => {
    const failing: Env['GATHER_WORKFLOW'] = {
      createBatch: async () => {
        throw new Error('quota exceeded');
      },
      get: async () => {
        throw new Error('Workflow instance does not exist');
      },
    } as unknown as Env['GATHER_WORKFLOW'];
    const gatherEnv: Env = { ...env, GATHER_WORKFLOW: failing, GATHER_FEEDS_PER_CHILD: '10' };

    await expect(createGatherChildren(gatherEnv, 'parent-fail', [{ name: 'F', feedUrl: 'https://feed.test.example/f.xml' }])).rejects.toThrow(
      'quota exceeded',
    );
  });
});

describe('pollGatherChildren()', () => {
  async function createChildren(
    count: number,
  ): Promise<{ fake: ReturnType<typeof fakeGatherWorkflow>; gatherEnv: Env; ids: string[] }> {
    const fake = fakeGatherWorkflow();
    const gatherEnv: Env = { ...env, GATHER_WORKFLOW: fake.binding, GATHER_FEEDS_PER_CHILD: '1' };
    const sources = Array.from({ length: count }, (_, i) => ({ name: `Feed ${i}`, feedUrl: `https://feed.test.example/${i}.xml` }));
    const ids = await createGatherChildren(gatherEnv, 'parent-poll', sources);
    return { fake, gatherEnv, ids };
  }

  it('sums each complete child output once every child is complete', async () => {
    const { fake, gatherEnv, ids } = await createChildren(2);
    fake.setStatus(ids[0]!, { status: 'complete', output: 3 });
    fake.setStatus(ids[1]!, { status: 'complete', output: 4 });

    const result = await pollGatherChildren(gatherEnv, ids, 0);

    expect(result).toEqual({ done: true, total: 7 });
  });

  it('returns done: false while any child has not reached complete', async () => {
    const { fake, gatherEnv, ids } = await createChildren(2);
    fake.setStatus(ids[0]!, { status: 'complete', output: 3 });
    fake.setStatus(ids[1]!, { status: 'running' });

    const result = await pollGatherChildren(gatherEnv, ids, 0);

    expect(result).toEqual({ done: false, total: 0 });
  });

  it('fails (visibly) the moment a child is errored, rather than contributing zero silently', async () => {
    const { fake, gatherEnv, ids } = await createChildren(2);
    fake.setStatus(ids[0]!, { status: 'errored', error: { name: 'Error', message: 'boom' } });
    fake.setStatus(ids[1]!, { status: 'complete', output: 1 });

    await expect(pollGatherChildren(gatherEnv, ids, 0)).rejects.toThrow(/errored/);
  });

  it('fails when a child is terminated', async () => {
    const { fake, gatherEnv, ids } = await createChildren(1);
    fake.setStatus(ids[0]!, { status: 'terminated' });

    await expect(pollGatherChildren(gatherEnv, ids, 0)).rejects.toThrow(/terminated/);
  });

  it('fails rather than hangs once the poll round cap is reached', async () => {
    const { fake, gatherEnv, ids } = await createChildren(1);
    fake.setStatus(ids[0]!, { status: 'running' });

    await expect(pollGatherChildren(gatherEnv, ids, 1000)).rejects.toThrow(/still not complete/);
  });

  // Pins the cap's arithmetic (GATHER_POLL_SUBREQUEST_BUDGET / children) at a
  // concrete child count, the way test/workflow.test.ts's STALE_AGE_HOURS /
  // LIVE_AGE_HOURS pin TOPIC_CLAIM_TTL_HOURS - not the round number above,
  // which only proves "a large round eventually fails" and would stay green
  // even if the derivation inverted.
  it('at 5 children (GATHER_FEEDS_PER_CHILD default), the derived cap is round 6, not a fixed round count', async () => {
    const { fake, gatherEnv, ids } = await createChildren(5);
    for (const id of ids) fake.setStatus(id, { status: 'running' });

    await expect(pollGatherChildren(gatherEnv, ids, 5)).resolves.toEqual({ done: false, total: 0 });
    await expect(pollGatherChildren(gatherEnv, ids, 6)).rejects.toThrow(/still not complete after 6 polls/);
  });

  it('validates a complete child\'s output rather than casting it - a non-count output fails the step', async () => {
    const { fake, gatherEnv, ids } = await createChildren(1);
    fake.setStatus(ids[0]!, { status: 'complete', output: 'not-a-count' });

    await expect(pollGatherChildren(gatherEnv, ids, 0)).rejects.toThrow(/non-count/);
  });
});

describe('shortlistCandidates()', () => {
  it('caps at SHORTLIST_MAX_CANDIDATES in SQL, before the seen_urls dedupe', async () => {
    const runId = 'run-shortlist-cap';
    const items = Array.from({ length: SHORTLIST_MAX_CANDIDATES + 742 }, (_, i) => ({
      url: `https://example.com/article-${i}`,
      title: `Article ${i}`,
      publishedAt: new Date(Date.now() - i * 1000).toISOString(), // strictly newest-first
      publishedMs: Date.now() - i * 1000,
    }));
    await writeRunCandidates(env.DB, runId, 'Source', items);

    let queryCount = 0;
    const countingEnv: Env = {
      ...env,
      DB: {
        prepare: (sql: string) => {
          queryCount++;
          return env.DB.prepare(sql);
        },
      } as D1Database,
    };

    const result = await shortlistCandidates(countingEnv, runId, topic());

    // One query reads the capped, ordered set (readRunCandidates), then the
    // chunked seen_urls dedupe runs over exactly SHORTLIST_MAX_CANDIDATES
    // rows - not the 4,742 written - proving the cap is applied in SQL
    // before the dedupe, not after.
    expect(queryCount).toBe(1 + SHORTLIST_MAX_CANDIDATES / SEEN_URLS_CHUNK_SIZE);
    expect(result.length).toBeLessThanOrEqual(SHORTLIST_TOP_N);
  });

  it('excludes candidates already present in seen_urls', async () => {
    await env.DB.prepare(`INSERT INTO seen_urls (url, source) VALUES (?, 'test')`).bind('https://example.com/seen').run();

    const runId = 'run-shortlist-seen';
    await writeRunCandidates(env.DB, runId, 'Source', [
      candidate({ url: 'https://example.com/seen', title: 'Seen' }),
      candidate({ url: 'https://example.com/new', title: 'New' }),
    ]);

    const result = await shortlistCandidates(env, runId, topic());

    expect(result.map((c) => c.url)).toEqual(['https://example.com/new']);
  });

  it('caps the final ranked list at SHORTLIST_TOP_N', async () => {
    const runId = 'run-shortlist-topn';
    const items = Array.from({ length: SHORTLIST_TOP_N + 10 }, (_, i) =>
      candidate({ url: `https://example.com/r-${i}`, title: `Agentic code review practice paper ${i}` }),
    );
    await writeRunCandidates(env.DB, runId, 'Source', items);

    const result = await shortlistCandidates(env, runId, topic());
    expect(result).toHaveLength(SHORTLIST_TOP_N);
  });

  it('ranks a title carrying an attributable-practice signal above pure commentary with equal topic overlap', async () => {
    const t = topic({ title: 'agentic code review', angle: null });
    const runId = 'run-shortlist-rank';
    await writeRunCandidates(env.DB, runId, 'Source', [
      candidate({ url: 'https://example.com/commentary', title: 'Some thoughts on agentic code review' }),
      candidate({ url: 'https://example.com/study', title: 'A study of agentic code review practice' }),
    ]);

    const result = await shortlistCandidates(env, runId, t);
    expect(result[0]?.url).toBe('https://example.com/study');
  });

  // ---------------------------------------------------------------------
  // Acceptance criterion 7: "The shortlist produced from `run_candidates`
  // is identical to the shortlist the in-memory array produces for the
  // same inputs." The in-memory implementation this replaced is deleted
  // from src/workflow.ts, so it is reconstructed here, deliberately as a
  // standalone copy rather than a call into shortlistCandidates or any of
  // its private helpers - the point of the criterion is that the D1-backed
  // path and the old in-memory path agree, which a shared implementation
  // could not prove.
  // ---------------------------------------------------------------------
  describe('shortlist parity (acceptance criterion 7)', () => {
    const REF_STOPWORDS = new Set([
      'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are',
      'with', 'how', 'why', 'what', 'this', 'that', 'from', 'at', 'by', 'as',
      'it', 'its', 'be', 'we', 'you', 'your', 'new', 'v1', 'vs',
    ]);
    function refTokenize(text: string): string[] {
      return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !REF_STOPWORDS.has(w));
    }
    const REF_PRACTICE_SIGNAL_RE =
      /\b(paper|study|studies|research|benchmark|arxiv|survey|dataset|evaluation|evaluat\w*|results?|findings?|we (built|found|measured|shipped)|case study)\b/i;
    const REF_COMMENTARY_SIGNAL_RE = /\b(opinion|thoughts on|roundup|newsletter|weekly|digest|why i think|announcing)\b/i;
    function refRelevanceScore(c: Candidate, t: Topic): number {
      const topicWords = new Set([...refTokenize(t.title), ...refTokenize(t.angle ?? '')]);
      const candidateWords = refTokenize(c.title);
      let overlap = 0;
      for (const word of candidateWords) if (topicWords.has(word)) overlap++;
      let score = overlap;
      if (REF_PRACTICE_SIGNAL_RE.test(c.title)) score += 2;
      if (REF_COMMENTARY_SIGNAL_RE.test(c.title)) score -= 1;
      return score;
    }
    /** Undated items sort last - the same rule readRunCandidates's `ORDER BY published_ms IS NULL, published_ms DESC` now applies in SQL. */
    function refDateKey(publishedAt: string | null): number {
      if (publishedAt === null) return Number.NEGATIVE_INFINITY;
      const parsed = Date.parse(publishedAt);
      return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    }
    function referenceShortlist(candidates: Candidate[], seenUrls: Set<string>, t: Topic): Candidate[] {
      const capped = [...candidates]
        .sort((a, b) => refDateKey(b.publishedAt) - refDateKey(a.publishedAt))
        .slice(0, SHORTLIST_MAX_CANDIDATES);
      const unseen = capped.filter((c) => !seenUrls.has(c.url));
      return unseen
        .map((c) => ({ candidate: c, score: refRelevanceScore(c, t) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, SHORTLIST_TOP_N)
        .map((r) => r.candidate);
    }

    it('the D1-backed shortlist matches the reference in-memory shortlist over a mixed fixture', async () => {
      const now = Date.now();
      const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString();

      const fixture: Candidate[] = [
        candidate({
          url: 'https://example.com/newest',
          title: 'Agentic code review: a case study of catching bugs',
          publishedAt: minutesAgo(0),
          publishedMs: now,
        }),
        candidate({
          url: 'https://example.com/seen-item',
          title: 'Agentic code review benchmark results',
          publishedAt: minutesAgo(1),
          publishedMs: now - 1 * 60_000,
        }),
        candidate({
          url: 'https://example.com/mid',
          title: 'A study of agentic code review practice',
          publishedAt: minutesAgo(2),
          publishedMs: now - 2 * 60_000,
        }),
        // A deliberate score tie: neither shares a word with the topic nor
        // carries a practice or commentary signal, so both score 0.
        candidate({
          url: 'https://example.com/tie-a',
          title: 'Weekend cooking notes',
          publishedAt: minutesAgo(3),
          publishedMs: now - 3 * 60_000,
        }),
        candidate({
          url: 'https://example.com/tie-b',
          title: 'Garden maintenance log',
          publishedAt: minutesAgo(4),
          publishedMs: now - 4 * 60_000,
        }),
        candidate({
          url: 'https://example.com/commentary',
          title: 'Some thoughts on agentic code review',
          publishedAt: minutesAgo(5),
          publishedMs: now - 5 * 60_000,
        }),
        candidate({
          url: 'https://example.com/undated',
          title: 'A general benchmark discussion',
          publishedAt: null,
          publishedMs: null,
        }),
      ];

      const runId = 'run-shortlist-parity';
      await writeRunCandidates(env.DB, runId, 'Source', fixture);
      await env.DB.prepare(`INSERT INTO seen_urls (url, source) VALUES (?, 'test')`).bind('https://example.com/seen-item').run();

      const t = topic({ title: 'agentic code review', angle: 'catching bugs' });

      const actual = await shortlistCandidates(env, runId, t);
      const expected = referenceShortlist(fixture, new Set(['https://example.com/seen-item']), t);

      expect(actual.map((c) => c.url)).toEqual(expected.map((c) => c.url));
    });
  });
});

describe('selectTopic()', () => {
  it('claims a specific topic by id when topicId is set', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('targeted', NULL, 'queued', 'human') RETURNING id`,
    ).first<{ id: number }>();
    const result = await selectTopic(env, 'run-targeted', insert?.id as number);
    expect(result?.title).toBe('targeted');
    expect(result?.status).toBe('in_progress');
  });

  it('drains the queue before proposing', async () => {
    await env.DB.prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('queued one', NULL, 'queued', 'human')`).run();
    const result = await selectTopic(env, 'run-drain', undefined);
    expect(result?.title).toBe('queued one');
  });

  it('with an empty queue, proposes and persists a topic idempotently on replay', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([{ title: 'Already covered post', url: 'https://blog.test.example/already-covered' }]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          return new Response(
            rssFeed([{ title: 'Brand New Unrelated Topic Nobody Has Written About', url: 'https://seed.example/new-thing' }]),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const first = await selectTopic(env, 'run-replay', undefined);
    expect(first?.title).toBe('Brand New Unrelated Topic Nobody Has Written About');
    expect(first?.origin).toBe('agent');
    expect(first?.status).toBe('in_progress');

    // Replay: a retried select-topic step must recover the same row, not insert a second one.
    const second = await selectTopic(env, 'run-replay', undefined);
    expect(second?.id).toBe(first?.id);

    const rows = await env.DB.prepare(`SELECT COUNT(*) as n FROM topics WHERE origin = 'agent'`).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('returns null (falls through to record-no-topic) when the seed feed only offers already-covered material', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) {
          return new Response(rssFeed([{ title: 'Observability for agents in production', url: 'https://blog.test.example/observability' }]));
        }
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          return new Response(rssFeed([{ title: 'Observability for agents in production', url: 'https://seed.example/dup' }]));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await selectTopic(env, 'run-covered', undefined);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Acceptance criterion 10: a runs row exists after start-run, with a
  // non-success status, and the queue-draining path sets topic_id on it.
  // startRun's own replay safety is covered in test/d1.test.ts; this proves
  // the wiring through selectTopic.
  // -------------------------------------------------------------------------
  it('a runs row started before selectTopic gets its topic_id attached on the queue-draining path (acceptance criterion 10)', async () => {
    await env.DB.prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('queued one', NULL, 'queued', 'human')`).run();

    await startRun(env.DB, 'run-attach');
    const beforeSelect = await env.DB.prepare('SELECT status, topic_id FROM runs WHERE instance_id = ?').bind('run-attach').first<{
      status: string;
      topic_id: number | null;
    }>();
    expect(beforeSelect?.status).toBe('running'); // not a success status - acceptance criterion 10
    expect(beforeSelect?.topic_id).toBeNull();

    const result = await selectTopic(env, 'run-attach', undefined);

    const afterSelect = await env.DB.prepare('SELECT topic_id FROM runs WHERE instance_id = ?').bind('run-attach').first<{
      topic_id: number | null;
    }>();
    expect(afterSelect?.topic_id).toBe(result?.id);
  });

  // -------------------------------------------------------------------------
  // Acceptance criterion 9: a stale in_progress topic is reachable again by
  // the scheduled path, and a live one is not stolen from it.
  //
  // The two ages below are *fixed* hours that bracket TOPIC_CLAIM_TTL_HOURS
  // (7 above it, 1 below), not `TOPIC_CLAIM_TTL_HOURS ± 1`. Written relatively,
  // changing the constant moves both the fixture and the threshold together and
  // the pair cannot see it - the constant's magnitude, which requirement 9 is
  // specifically about, would be unpinned. Written this way, raising the TTL
  // past 7 hours or dropping it below 1 fails a test.
  // -------------------------------------------------------------------------
  const STALE_AGE_HOURS = 7;
  const LIVE_AGE_HOURS = 1;

  it(`a topic left in_progress ${STALE_AGE_HOURS}h ago, past TOPIC_CLAIM_TTL_HOURS, is selectable again by a plain scheduled call`, async () => {
    expect(TOPIC_CLAIM_TTL_HOURS).toBeLessThan(STALE_AGE_HOURS);
    const insert = await env.DB
      .prepare(
        `INSERT INTO topics (title, angle, status, origin, claimed_at)
         VALUES ('stranded', NULL, 'in_progress', 'human', datetime('now', '-' || ? || ' hours')) RETURNING id`,
      )
      .bind(STALE_AGE_HOURS)
      .first<{ id: number }>();

    const result = await selectTopic(env, 'run-reclaim', undefined);

    expect(result?.id).toBe(insert?.id);
    expect(result?.status).toBe('in_progress');
  });

  it(`a topic claimed ${LIVE_AGE_HOURS}h ago, within TOPIC_CLAIM_TTL_HOURS, is not returned to a second scheduled selectTopic (a live run is not stolen from)`, async () => {
    expect(TOPIC_CLAIM_TTL_HOURS).toBeGreaterThan(LIVE_AGE_HOURS);
    await env.DB
      .prepare(
        `INSERT INTO topics (title, angle, status, origin, claimed_at)
         VALUES ('live-run-topic', NULL, 'in_progress', 'human', datetime('now', '-' || ? || ' hours'))`,
      )
      .bind(LIVE_AGE_HOURS)
      .run();
    // A second queued row so the second call has somewhere to land other
    // than the live one, proving the live topic specifically was skipped.
    await env.DB.prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('other queued', NULL, 'queued', 'human')`).run();

    const result = await selectTopic(env, 'run-no-steal', undefined);

    expect(result?.title).toBe('other queued');
  });

  // -------------------------------------------------------------------------
  // The reclaim runs only on the scheduled path - a run naming a topicId
  // must not widen its blast radius to other runs' stranded topics.
  // -------------------------------------------------------------------------
  it('a call naming a topicId does not reclaim another topic that is in_progress past its TTL', async () => {
    const stranded = await env.DB
      .prepare(
        `INSERT INTO topics (title, angle, status, origin, claimed_at)
         VALUES ('stranded-elsewhere', NULL, 'in_progress', 'human', datetime('now', '-' || ? || ' hours')) RETURNING id`,
      )
      .bind(STALE_AGE_HOURS)
      .first<{ id: number }>();
    const named = await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('named', NULL, 'queued', 'human') RETURNING id`,
    ).first<{ id: number }>();

    const result = await selectTopic(env, 'run-named', named?.id as number);

    expect(result?.id).toBe(named?.id);
    const strandedRow = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(stranded?.id).first<{
      status: string;
    }>();
    expect(strandedRow?.status).toBe('in_progress'); // untouched - reclaim did not run on this path
  });
});

describe('proposeTopic()', () => {
  it('checks against BOTH the blog feed (published) and repo directory listing (drafted)', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');

    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([{ title: 'Published post title', url: 'https://blog.test.example/p' }]));
        if (url.startsWith(env.GITHUB_API_BASE)) {
          return jsonResponse(200, [{ name: 'drafted-only-slug', type: 'dir' }]);
        }
        if (url === seed.feedUrl) {
          return new Response(
            rssFeed([
              { title: 'Drafted Only Slug', url: 'https://seed.example/drafted' },
              { title: 'Genuinely Novel Idea', url: 'https://seed.example/novel' },
            ]),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await proposeTopic(env);

    expect(calls).toContain(env.BLOG_FEED_URL);
    expect(calls.some((c) => c.startsWith(env.GITHUB_API_BASE))).toBe(true);
    // "Drafted Only Slug" collides with the repo-only slug and is skipped;
    // the first genuinely uncovered item is proposed instead.
    expect(result?.title).toBe('Genuinely Novel Idea');
  });

  it(`treats fewer than ${DUPLICATE_TOKEN_THRESHOLD} shared words as not a duplicate`, async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([{ title: 'agentic pull request review', url: 'https://blog.test.example/p' }]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          // Shares only one meaningful word ("agentic") with the published title.
          return new Response(rssFeed([{ title: 'agentic infrastructure provisioning', url: 'https://seed.example/one-word' }]));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await proposeTopic(env);
    expect(result?.title).toBe('agentic infrastructure provisioning');
  });

  it('returns null when the blog feed cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await proposeTopic(env);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// summarizeArticle() / synthesizeDraft() / isGrounded() / openPullRequest()
// ---------------------------------------------------------------------------

/**
 * `env.AI` with a stub `run` - the same approach `test/llm.test.ts` uses.
 * `[ai]` is stripped from the pool's wrangler config (see vitest.config.ts's
 * comment), so `env.AI` is otherwise undefined; `createLlm()` never calls
 * `env.AI.run` outside `src/lib/llm.ts`, so stubbing it here still leaves
 * `ai-run-only-in-llm` meaning something.
 */
function envWithAi(fixture: unknown): Env {
  return {
    ...env,
    AI: { run: async () => fixture } as unknown as Env['AI'],
  };
}

function chatFixture(content: string, finishReason = 'stop'): unknown {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

function articleResponse(bodyHtml: string): Response {
  return new Response(`<html><body>${bodyHtml}</body></html>`, { headers: { 'content-type': 'text/html' } });
}

/** Trimmed copy of the real src/content.config.ts - see test/mdx.test.ts's copy for provenance. */
const REAL_CONTENT_CONFIG = `const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      date: z.coerce.date(),
      order: z.number().optional(),
      image: image().optional(),
      tags: z.array(z.string()).optional(),
      authors: z.array(z.string()).optional(),
      draft: z.boolean().optional(),
    }),
})`;

function summary(overrides: Partial<ArticleSummary> = {}): ArticleSummary {
  return {
    url: 'https://example.com/a',
    title: 'Article A',
    summary: 'A summary.',
    relevance: 0.8,
    claims: ['claim one'],
    attributablePractice: 'Some practice',
    ...overrides,
  };
}

describe('summarizeArticle()', () => {
  it('fetches, extracts, and parses a well-formed map response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => articleResponse('<p>Real article prose about agentic code review.</p>')),
    );
    const aiEnv = envWithAi(
      chatFixture(JSON.stringify({ summary: 'It works.', relevance: 0.7, claims: ['c1'], attributablePractice: 'Practice X' })),
    );

    const result = await summarizeArticle(aiEnv, candidate({ url: 'https://example.com/a', title: 'Article A' }), topic());

    expect(result.summary).toEqual({
      url: 'https://example.com/a',
      title: 'Article A',
      summary: 'It works.',
      relevance: 0.7,
      claims: ['c1'],
      attributablePractice: 'Practice X',
    });
    expect(result.neurons).toBeGreaterThan(0);
  });

  it('returns skipReason: fetch-threw (with a truncated error message) when the fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const result = await summarizeArticle(envWithAi(chatFixture('{}')), candidate(), topic());
    expect(result.summary).toBeNull();
    expect(result.neurons).toBe(0);
    expect(result.skipReason).toBe('fetch-threw');
    expect(result.errorMessage).toBe('network down');
    expect(result.status).toBeUndefined();
  });

  it('caps errorMessage at 100 chars for a fetch throw with a long message', async () => {
    const longMessage = 'x'.repeat(200);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(longMessage);
      }),
    );
    const result = await summarizeArticle(envWithAi(chatFixture('{}')), candidate(), topic());
    expect(result.skipReason).toBe('fetch-threw');
    expect(result.errorMessage).toHaveLength(100);
    expect(result.errorMessage).toBe(longMessage.slice(0, 100));
  });

  it('returns skipReason: http-error (with the status) on a non-2xx fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const result = await summarizeArticle(envWithAi(chatFixture('{}')), candidate(), topic());
    expect(result.summary).toBeNull();
    expect(result.neurons).toBe(0);
    expect(result.skipReason).toBe('http-error');
    expect(result.status).toBe(404);
    expect(result.errorMessage).toBeUndefined();
  });

  it('returns skipReason: empty-extract when the article body extracts to nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => articleResponse('<script>only script content</script>')));
    const result = await summarizeArticle(envWithAi(chatFixture('{}')), candidate(), topic());
    expect(result.summary).toBeNull();
    expect(result.neurons).toBe(0);
    expect(result.skipReason).toBe('empty-extract');
    expect(result.status).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
  });

  it('returns skipReason: unparseable (but still reports spent neurons) when the model response is not parseable JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => articleResponse('<p>Article prose.</p>')));
    const aiEnv = envWithAi(chatFixture('I think the article is about... (reasoning-fallback prose, not JSON)'));

    const result = await summarizeArticle(aiEnv, candidate(), topic());

    expect(result.summary).toBeNull();
    expect(result.neurons).toBeGreaterThan(0);
    expect(result.skipReason).toBe('unparseable');
  });

  it('returns skipReason: truncated when the completion was truncated (finish_reason: length)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => articleResponse('<p>Article prose.</p>')));
    const aiEnv = envWithAi(chatFixture('{"summary": "cut off h', 'length'));

    const result = await summarizeArticle(aiEnv, candidate(), topic());
    expect(result.summary).toBeNull();
    expect(result.skipReason).toBe('truncated');
  });

  it('distinguishes truncated from unparseable - both skip before a summary but for different reasons', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => articleResponse('<p>Article prose.</p>')));

    const truncated = await summarizeArticle(envWithAi(chatFixture('{"summary": "cut off h', 'length')), candidate(), topic());
    const unparseable = await summarizeArticle(envWithAi(chatFixture('not json at all')), candidate(), topic());

    expect(truncated.skipReason).toBe('truncated');
    expect(unparseable.skipReason).toBe('unparseable');
    expect(truncated.skipReason).not.toBe(unparseable.skipReason);
  });
});

describe('synthesizeDraft()', () => {
  const summaries = [summary({ url: 'https://example.com/a' }), summary({ url: 'https://example.com/b', title: 'Article B' })];

  it('builds a Draft from a well-formed reduce response, computing slug/date/authors/draft itself', async () => {
    const aiEnv = envWithAi(
      chatFixture(
        JSON.stringify({
          title: 'Why Agentic Review Catches More Bugs',
          description: 'A tension worth stating.',
          tags: ['ai', 'engineering-leadership'],
          body: '## The practice\n\nSome prose citing [Article A](https://example.com/a).',
        }),
      ),
    );

    const { draft, neurons } = await synthesizeDraft(aiEnv, topic(), summaries);

    expect(draft.slug).toBe('why-agentic-review-catches-more-bugs');
    expect(draft.title).toBe('Why Agentic Review Catches More Bugs');
    expect(draft.description).toBe('A tension worth stating.');
    expect(draft.tags).toEqual(['ai', 'engineering-leadership']);
    expect(draft.body).toContain('Some prose citing');
    expect(draft.draft).toBe(true);
    expect(draft.authors).toEqual(['nimeshjm']);
    expect(draft.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(draft.sources).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(neurons).toBeGreaterThan(0);
  });

  it('the brief links every source, never trusting the model to compose the source list', async () => {
    const aiEnv = envWithAi(
      chatFixture(JSON.stringify({ title: 'A Title', description: 'd', tags: [], body: 'body' })),
    );

    const { draft } = await synthesizeDraft(aiEnv, topic(), summaries);

    expect(draft.brief).toContain('https://example.com/a');
    expect(draft.brief).toContain('https://example.com/b');
    expect(draft.brief).toContain('Article A');
    expect(draft.brief).toContain('Article B');
  });

  it('falls back to a topic-id slug when the title has no usable characters', async () => {
    const aiEnv = envWithAi(chatFixture(JSON.stringify({ title: '!!!', description: 'd', tags: [], body: 'b' })));
    const { draft } = await synthesizeDraft(aiEnv, topic({ id: 42 }), summaries);
    expect(draft.slug).toBe('research-topic-42');
  });

  it('throws when the completion was truncated (finish_reason: length) rather than committing a truncated draft', async () => {
    const aiEnv = envWithAi(chatFixture('{"title": "cut off h', 'length'));
    await expect(synthesizeDraft(aiEnv, topic(), summaries)).rejects.toThrow(/truncat/i);
  });

  it('throws when the model response is not valid JSON in the expected shape', async () => {
    const aiEnv = envWithAi(chatFixture('not json at all'));
    await expect(synthesizeDraft(aiEnv, topic(), summaries)).rejects.toThrow();
  });

  it('names the specific parse failure reason and response length, and never the response text itself', async () => {
    const secretDescription = 'THIS SHOULD NEVER APPEAR IN AN ERROR MESSAGE';
    const responseText = JSON.stringify({ title: 't', description: secretDescription, tags: [], body: '   ' });
    const aiEnv = envWithAi(chatFixture(responseText));

    let caught: Error | undefined;
    try {
      await synthesizeDraft(aiEnv, topic(), summaries);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain('reason=body-invalid');
    expect(caught?.message).toContain(`length=${responseText.length}`);
    expect(caught?.message).toContain('keys=[title,description,tags,body]');
    expect(caught?.message).not.toContain(secretDescription);
  });
});

describe('isGrounded()', () => {
  it('requires at least MIN_SOURCES summaries with at least one attributable practice', () => {
    expect(isGrounded([summary({ attributablePractice: 'X' }), summary({ attributablePractice: null })])).toBe(true);
  });

  it('rejects a single source even if it carries an attributable practice (spec.md criterion 6)', () => {
    expect(isGrounded([summary({ attributablePractice: 'X' })])).toBe(false);
  });

  it('rejects two or more sources when none carries an attributable practice', () => {
    expect(isGrounded([summary({ attributablePractice: null }), summary({ attributablePractice: null })])).toBe(false);
  });
});

describe('openPullRequest()', () => {
  /**
   * A stateful fake of the whole GitHub surface `openPullRequest` touches -
   * `test/github.test.ts` already proves each primitive (`createBranch`,
   * `putFile`, `openPullRequest`) in isolation; this proves the
   * *composition* stays idempotent end to end, per plan.md's step-5
   * verification row: "openPullRequest run twice against a fixture produces
   * one PR."
   */
  function fakeGithub(schemaSource: string) {
    const repo = env.BLOG_REPO;
    const branches = new Set<string>();
    const files = new Map<string, { content: string; sha: string }>();
    let openPrUrl: string | null = null;
    let prPostCount = 0;
    let branchPostCount = 0;
    let fileShaCounter = 0;
    const putBranches: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const path = url.pathname;
      const contentsPrefix = `/repos/${repo}/contents/`;

      if (path === `${contentsPrefix}src/content.config.ts` && method === 'GET') {
        return jsonResponse(200, { content: btoa(schemaSource), encoding: 'base64' });
      }
      if (path === `/repos/${repo}/git/ref/heads/main` && method === 'GET') {
        return jsonResponse(200, { object: { sha: 'base-sha' } });
      }
      if (path === `/repos/${repo}/git/refs` && method === 'POST') {
        branchPostCount++;
        const body = JSON.parse(String(init?.body)) as { ref: string };
        const branch = body.ref.replace('refs/heads/', '');
        if (branches.has(branch)) return new Response('exists', { status: 422 });
        branches.add(branch);
        return jsonResponse(201, {});
      }
      if (path.startsWith(contentsPrefix) && path !== `${contentsPrefix}src/content.config.ts` && method === 'GET') {
        const filePath = path.slice(contentsPrefix.length);
        const branch = url.searchParams.get('ref') ?? '';
        const existing = files.get(`${branch}:${filePath}`);
        if (existing === undefined) return new Response('not found', { status: 404 });
        return jsonResponse(200, { sha: existing.sha });
      }
      if (path.startsWith(contentsPrefix) && method === 'PUT') {
        const filePath = path.slice(contentsPrefix.length);
        const body = JSON.parse(String(init?.body)) as { content: string; branch: string };
        fileShaCounter++;
        putBranches.push(body.branch);
        files.set(`${body.branch}:${filePath}`, { content: body.content, sha: `sha-${fileShaCounter}` });
        return jsonResponse(200, {});
      }
      if (path === `/repos/${repo}/pulls` && method === 'GET') {
        return jsonResponse(200, openPrUrl === null ? [] : [{ html_url: openPrUrl }]);
      }
      if (path === `/repos/${repo}/pulls` && method === 'POST') {
        prPostCount++;
        openPrUrl = `https://github.com/${repo}/pull/1`;
        return jsonResponse(201, { html_url: openPrUrl });
      }
      throw new Error(`fakeGithub: unhandled ${method} ${path}`);
    });

    return {
      fetchMock,
      branches,
      files,
      putBranches,
      prPostCount: () => prPostCount,
      branchPostCount: () => branchPostCount,
    };
  }

  function draft(overrides: Partial<Draft> = {}): Draft {
    return {
      slug: 'agentic-code-review',
      title: 'Why agentic code review catches more bugs',
      description: 'A tension worth stating.',
      date: '2026-08-27',
      authors: ['nimeshjm'],
      tags: ['ai'],
      draft: true,
      brief: '# Research brief\n\n- [Article A](https://example.com/a)',
      body: '## Heading\n\nProse.',
      sources: ['https://example.com/a'],
      ...overrides,
    };
  }

  it('run twice against the same draft produces exactly one PR, one branch, one file version', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    vi.stubGlobal('fetch', fake.fetchMock);

    const d = draft();
    const url1 = await openPullRequest(env, d);
    const url2 = await openPullRequest(env, d);

    expect(url1).toBe(url2);
    expect(fake.prPostCount()).toBe(1); // mechanism: existing-open-PR-by-head reuse (github.ts's findOpenPullRequest)
    expect(fake.branchPostCount()).toBe(2); // both attempts POST; the second's 422 is treated as success (mechanism: existing-branch reuse)
    expect(fake.branches.size).toBe(1);
    expect(fake.putBranches).toEqual(['research/2026-08-27-agentic-code-review', 'research/2026-08-27-agentic-code-review']); // mechanism: existing-file-sha reuse on the retry PUT
  });

  it('never writes to BLOG_BASE_BRANCH - only ever reads its ref, and only research/* branches receive commits', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    vi.stubGlobal('fetch', fake.fetchMock);

    await openPullRequest(env, draft());

    expect(fake.branches.has(env.BLOG_BASE_BRANCH)).toBe(false);
    for (const b of fake.putBranches) expect(b).not.toBe(env.BLOG_BASE_BRANCH);
  });

  it('the committed frontmatter carries draft: true and no image key', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    vi.stubGlobal('fetch', fake.fetchMock);

    await openPullRequest(env, draft());

    const [key] = [...fake.files.keys()];
    const content = key !== undefined ? fake.files.get(key)?.content : undefined;
    const decoded = content !== undefined ? atob(content) : '';
    expect(decoded).toMatch(/^draft: true$/m);
    expect(decoded).not.toMatch(/^image:/m);
  });

  it('rejects a statically-invalid draft before making any GitHub call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(openPullRequest(env, draft({ slug: 'has a space' }))).rejects.toThrow(InvalidDraftError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws, and opens no PR, when the live schema now requires a field renderMdx does not emit', async () => {
    const mutatedSchema = REAL_CONTENT_CONFIG.replace('image: image().optional(),', 'image: image(),');
    const fake = fakeGithub(mutatedSchema);
    vi.stubGlobal('fetch', fake.fetchMock);

    await expect(openPullRequest(env, draft())).rejects.toThrow(/image/);
    expect(fake.prPostCount()).toBe(0);
    expect(fake.branches.size).toBe(0);
  });
});
