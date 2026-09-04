import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEEN_URLS_CHUNK_SIZE, startRun, writeRunCandidates } from '../src/lib/d1';
import { loadFeeds, SOURCE_TIER_PRIORITY, tierOf } from '../src/lib/feeds';
import type {
  ArticleSummary,
  Candidate,
  Draft,
  Env,
  GatherParams,
  GatherPollState,
  ParsedItem,
  PublishParams,
  PublishPollState,
  ResearchParams,
  Source,
  SummarizeChildOutput,
  SummarizeParams,
  SummarizePollState,
  Topic,
} from '../src/lib/types';
import { initialChildPollState, isTransientChildFailure } from '../src/lib/workflow-children';
import type { ChildReplacement } from '../src/lib/workflow-children';
import {
  chunkSourcesByVolume,
  createGatherChildren,
  createPublishChildren,
  createSummarizeChildren,
  DEFAULT_SOURCE_WEIGHT,
  DUPLICATE_TOKEN_THRESHOLD,
  isGrounded,
  pollGatherChildren,
  pollPublishChildren,
  pollSummarizeChildren,
  proposeTopic,
  ResearchWorkflow,
  selectTopic,
  SHORTLIST_MAX_CANDIDATES,
  SHORTLIST_TOP_N,
  shortlistCandidates,
  summarizeReplacement,
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

function candidateRow(url: string): ParsedItem {
  return { url, title: 'x', publishedAt: '2026-08-27T00:00:00Z', publishedMs: null };
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
  /** Every id `status()` was called on, in order - one entry is one parent subrequest. */
  polled: string[];
} {
  const created = new Map<string, GatherParams>();
  const statuses = new Map<string, InstanceStatus>();
  const polled: string[] = [];

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
      return {
        id,
        status: async () => {
          polled.push(id);
          return statuses.get(id) ?? { status: 'complete', output: 0 };
        },
      } as unknown as WorkflowInstance;
    },
  } as unknown as Env['GATHER_WORKFLOW'];

  return { binding, created, polled, setStatus: (id, status) => statuses.set(id, status) };
}

/**
 * The measured per-feed item counts behind spec.md's calibration table
 * (2026-09-01, run `bd33248b` plus two probe children). Held here as data so
 * the dominant-feed case below is the real allowlist rather than a
 * hand-picked shape that happens to prove the point. Perishable, and only
 * ever an input to these tests - production reads its weights from D1.
 */
const CALIBRATION_2026_09_01: Record<string, number> = {
  'arXiv cs.AI': 783, 'arXiv cs.SE': 80, 'OpenAI': 54, 'Simon Willison': 30, 'Claude': 29,
  'Cloudflare': 20, 'Stack Overflow': 16, 'GitHub': 10, 'Google Developers — AI': 10,
  'Cursor': 9, 'The Pragmatic Engineer': 9, 'DX': 8, 'Honeycomb': 8, 'Anthropic News': 7,
  'Martin Fowler': 7, 'Anthropic Research': 6, 'OpenAI Developer': 5, 'Ollama': 4,
  'Pinecone': 4, 'Surge AI': 4, 'AI FIRST Podcast': 3, 'Weaviate': 3, 'OpenAI Engineering': 2,
  'UK AI Safety Institute': 2, 'Will Larson': 2, 'Dagster': 1, 'Goodfire': 1,
};

function calibrationWeights(sources: Source[]): Map<string, number> {
  // Every source gets an explicit entry, zeroes included, so this reproduces
  // the calibration table exactly. In production a feed with no rows is
  // absent from the map and picks up DEFAULT_SOURCE_WEIGHT instead - D1
  // stores rows, not absences, so it cannot tell "new" from "empty".
  return new Map(sources.map((s) => [s.name, CALIBRATION_2026_09_01[s.name] ?? 0]));
}

function loadOf(chunk: Source[], weights: Map<string, number>): number {
  return chunk.reduce((sum, s) => sum + (weights.get(s.name) ?? DEFAULT_SOURCE_WEIGHT), 0);
}

function syntheticSources(count: number): Source[] {
  return Array.from({ length: count }, (_, i) => ({ name: `Feed ${i}`, feedUrl: `https://feed.test.example/${i}.xml` }));
}

describe('chunkSourcesByVolume()', () => {
  it('isolates the dominant feed: cs.AI alone carries a child while the other 45 spread over four', () => {
    const sources = loadFeeds();
    const weights = calibrationWeights(sources);

    const chunks = chunkSourcesByVolume(sources, weights, 10);

    expect(chunks).toHaveLength(5);
    // The failure this replaces: `bd33248b`'s g0 drew both arXiv feeds and
    // died. Here cs.AI is the only non-empty feed in its chunk.
    expect(chunks[0]!.filter((s) => weights.get(s.name)! > 0).map((s) => s.name)).toEqual(['arXiv cs.AI']);
    expect(chunks.map((c) => loadOf(c, weights))).toEqual([783, 84, 84, 83, 83]);
    expect(chunks.map((c) => c.length)).toEqual([6, 10, 10, 10, 10]);
    // Membership, not only the aggregates: the totals above are identical
    // under several different placements of the 19 empty feeds, so they do
    // not on their own pin what this function returns.
    expect(chunks.map((c) => c.map((s) => s.name))).toEqual([
      ['Transluce', 'Windsurf Blog', 'Windsurf Changelog', 'Windsurf Next Changelog', 'xAI', 'arXiv cs.AI'],
      [
        'Weaviate', 'Dagster', 'Cohere', 'EleutherAI Papers', 'FAR.AI', 'Groq', 'Mistral AI',
        'Paul Graham Essays', 'The Batch (DeepLearning.AI)', 'arXiv cs.SE',
      ],
      [
        'OpenAI', 'Anthropic Research', 'OpenAI Engineering', 'OpenAI Research', 'Cursor', 'Honeycomb',
        'Pinecone', 'Goodfire', 'Perplexity', 'Timaeus',
      ],
      [
        'Anthropic News', 'OpenAI Developer', 'Anthropic Frontier Red Team', 'Simon Willison', 'Stack Overflow',
        'GitHub', 'The Pragmatic Engineer', 'Surge AI', 'UK AI Safety Institute', 'AI at Meta',
      ],
      [
        'Claude', 'Anthropic Engineering', 'Cloudflare', 'Google Developers — AI', 'DX', 'Martin Fowler',
        'Ollama', 'AI FIRST Podcast', 'Will Larson', 'Chander Ramesh',
      ],
    ]);
  });

  it('emits each chunk in tier order: priority sources before the rest, the deferred arXiv feeds last', () => {
    const sources = loadFeeds();
    const weights = calibrationWeights(sources);

    const chunks = chunkSourcesByVolume(sources, weights, 10);

    for (const chunk of chunks) {
      const tiers = chunk.map((s) => tierOf(s));
      expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    }
    // The point of the ordering, stated as the failure it guards: cs.AI is
    // 783 of the allowlist's ~1,100 items, so a child that dies on the 10 ms
    // CPU limit part-way through it (run `bd33248b`) loses only whatever
    // follows it - and nothing does.
    for (const name of ['arXiv cs.AI', 'arXiv cs.SE']) {
      const chunk = chunks.find((c) => c.some((s) => s.name === name))!;
      expect(chunk.at(-1)!.name).toBe(name);
    }
    // Assignment order is untouched: the bins are still balanced by weight.
    expect(chunks.map((c) => loadOf(c, weights))).toEqual([783, 84, 84, 83, 83]);
  });

  it('a priority source leads its chunk even when it is the lightest feed in it', () => {
    const sources: Source[] = [
      { name: 'Heavy default', feedUrl: 'https://feed.test.example/heavy.xml' },
      { name: 'Light priority', feedUrl: 'https://feed.test.example/light.xml', tier: SOURCE_TIER_PRIORITY },
    ];
    const weights = new Map([['Heavy default', 500], ['Light priority', 1]]);

    // One bin, so this is purely about emission order - by weight alone the
    // heavy feed would go first, which is exactly what the tier overrides.
    expect(chunkSourcesByVolume(sources, weights, 2).map((c) => c.map((s) => s.name))).toEqual([
      ['Light priority', 'Heavy default'],
    ]);
  });

  it('the feed-count cap binds before the weight balance does', () => {
    // One 1,000-item feed and nine trivial ones over two bins of five. Purely
    // by weight every trivial feed would join bin 1; the cap stops bin 1 at
    // five and forces the rest back onto the heavy bin.
    const sources = syntheticSources(10);
    const weights = new Map(sources.map((s, i) => [s.name, i === 0 ? 1000 : 1]));

    const chunks = chunkSourcesByVolume(sources, weights, 5);

    expect(chunks.map((c) => c.length)).toEqual([5, 5]);
    expect(chunks[0]!.map((s) => s.name)).toContain('Feed 0');
  });

  it('is deterministic: the same inputs chunk identically twice, because the chunks key replayable child ids', () => {
    const sources = loadFeeds();
    const weights = calibrationWeights(sources);

    const first = chunkSourcesByVolume(sources, weights, 10);
    const second = chunkSourcesByVolume(sources, weights, 10);

    expect(second.map((c) => c.map((s) => s.name))).toEqual(first.map((c) => c.map((s) => s.name)));
    // And independent of the order sources arrive in - the sort is total.
    const reversed = chunkSourcesByVolume([...sources].reverse(), weights, 10);
    expect(reversed.map((c) => c.map((s) => s.name))).toEqual(first.map((c) => c.map((s) => s.name)));
  });

  it('empty history degrades to round-robin: every weight is the default, so bins fill evenly', () => {
    const sources = syntheticSources(7);

    const chunks = chunkSourcesByVolume(sources, new Map(), 3);

    expect(chunks.map((c) => c.length)).toEqual([3, 2, 2]);
  });

  it('a source absent from history is weighted at the default, not at zero', () => {
    // Without a non-zero default the newcomer would look free and pile onto
    // whichever bin already holds the heavy feed.
    const sources = [
      { name: 'Known heavy', feedUrl: 'https://feed.test.example/heavy.xml' },
      { name: 'Newcomer', feedUrl: 'https://feed.test.example/new.xml' },
    ];
    const weights = new Map([['Known heavy', DEFAULT_SOURCE_WEIGHT * 4]]);

    const chunks = chunkSourcesByVolume(sources, weights, 1);

    expect(chunks.map((c) => c.map((s) => s.name))).toEqual([['Known heavy'], ['Newcomer']]);
    expect(loadOf(chunks[1]!, weights)).toBe(DEFAULT_SOURCE_WEIGHT);
  });

  it('no sources means no children', () => {
    expect(chunkSourcesByVolume([], new Map(), 10)).toEqual([]);
  });
});

describe('createGatherChildren()', () => {
  it('derives the child count from GATHER_FEEDS_PER_CHILD and balances volume across it, with deterministic ids', async () => {
    const fake = fakeGatherWorkflow();
    const gatherEnv: Env = { ...env, GATHER_WORKFLOW: fake.binding, GATHER_FEEDS_PER_CHILD: '3' };
    const sources = syntheticSources(7);

    const ids = await createGatherChildren(gatherEnv, 'parent-1', sources);

    // `ceil(7 / 3) = 3` children, as the count-based chunking gave - but
    // balanced 3/2/2 rather than filled 3/3/1, because no history means
    // equal weights and equal weights are round-robin.
    expect(ids).toEqual(['parent-1-g0', 'parent-1-g1', 'parent-1-g2']);
    expect(fake.created.get('parent-1-g0')?.sources).toHaveLength(3);
    expect(fake.created.get('parent-1-g1')?.sources).toHaveLength(2);
    expect(fake.created.get('parent-1-g2')?.sources).toHaveLength(2);
    // runId on every child is the PARENT's instance id, not a child-specific one.
    expect(fake.created.get('parent-1-g0')?.runId).toBe('parent-1');
    expect(fake.created.get('parent-1-g2')?.index).toBe(2);
  });

  it('weights come from measured history, and the run being chunked is excluded from it', async () => {
    const fake = fakeGatherWorkflow();
    const gatherEnv: Env = { ...env, GATHER_WORKFLOW: fake.binding, GATHER_FEEDS_PER_CHILD: '1' };
    const sources = [
      { name: 'Heavy', feedUrl: 'https://feed.test.example/heavy.xml' },
      { name: 'Light', feedUrl: 'https://feed.test.example/light.xml' },
    ];

    await writeRunCandidates(
      env.DB,
      'earlier-run',
      'Heavy',
      Array.from({ length: 50 }, (_, i) => candidateRow(`https://example.com/h${i}`)),
    );
    await writeRunCandidates(env.DB, 'earlier-run', 'Light', [candidateRow('https://example.com/l0')]);
    // This run's own children, mid-flight. Counting them would flip the
    // ordering on a replay while the child ids stayed the same.
    await writeRunCandidates(
      env.DB,
      'parent-weights',
      'Light',
      Array.from({ length: 500 }, (_, i) => candidateRow(`https://example.com/now${i}`)),
    );

    await createGatherChildren(gatherEnv, 'parent-weights', sources);

    expect(fake.created.get('parent-weights-g0')?.sources.map((s) => s.name)).toEqual(['Heavy']);
    expect(fake.created.get('parent-weights-g1')?.sources.map((s) => s.name)).toEqual(['Light']);
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

  /** The state round 0 starts from: every child pending, nothing carried. */
  const fresh = (ids: string[]): GatherPollState => initialChildPollState<number>(ids);

  it('sums each complete child output once every child is complete', async () => {
    const { fake, gatherEnv, ids } = await createChildren(2);
    fake.setStatus(ids[0]!, { status: 'complete', output: 3 });
    fake.setStatus(ids[1]!, { status: 'complete', output: 4 });

    const result = await pollGatherChildren(gatherEnv, ids, fresh(ids), 0);

    expect(result).toEqual({ done: true, total: 7 });
  });

  it('returns done: false while any child has not reached complete', async () => {
    const { fake, gatherEnv, ids } = await createChildren(2);
    fake.setStatus(ids[0]!, { status: 'complete', output: 3 });
    fake.setStatus(ids[1]!, { status: 'running' });

    const result = await pollGatherChildren(gatherEnv, ids, fresh(ids), 0);

    expect(result).toEqual({ done: false, state: { pending: [ids[1]], outputs: { [ids[0]!]: 3 } } });
  });

  it('fails (visibly) the moment a child is errored, rather than contributing zero silently', async () => {
    const { fake, gatherEnv, ids } = await createChildren(2);
    fake.setStatus(ids[0]!, { status: 'errored', error: { name: 'Error', message: 'boom' } });
    fake.setStatus(ids[1]!, { status: 'complete', output: 1 });

    await expect(pollGatherChildren(gatherEnv, ids, fresh(ids), 0)).rejects.toThrow(/errored/);
  });

  it('fails when a child is terminated', async () => {
    const { fake, gatherEnv, ids } = await createChildren(1);
    fake.setStatus(ids[0]!, { status: 'terminated' });

    await expect(pollGatherChildren(gatherEnv, ids, fresh(ids), 0)).rejects.toThrow(/terminated/);
  });

  it('fails rather than hangs once the poll round cap is reached', async () => {
    const { fake, gatherEnv, ids } = await createChildren(1);
    fake.setStatus(ids[0]!, { status: 'running' });

    await expect(pollGatherChildren(gatherEnv, ids, fresh(ids), 1000)).rejects.toThrow(/still not complete/);
  });

  // Pins the cap's arithmetic (GATHER_POLL_SUBREQUEST_BUDGET / children) at a
  // concrete child count, the way test/workflow.test.ts's STALE_AGE_HOURS /
  // LIVE_AGE_HOURS pin TOPIC_CLAIM_TTL_HOURS - not the round number above,
  // which only proves "a large round eventually fails" and would stay green
  // even if the derivation inverted. GATHER_POLL_SUBREQUEST_BUDGET dropped
  // from 30 to 10 on 2026-08-31 (#75) once summarize's own poll loop started
  // sharing the parent's 50-subrequest invocation - see that constant's
  // comment in src/workflow.ts.
  //
  // The cap counts polls *including* the one it throws in, corrected
  // 2026-09-02 (#92): the round that throws has already spent one subrequest
  // per pending child on the statuses it throws about, so at 10 / 5 children
  // the loop polls at rounds 0 and 1 and costs the 10 the parent's ledger
  // charges it - it used to poll at round 2 as well and cost 15.
  it('at 5 children (GATHER_FEEDS_PER_CHILD default), the derived cap is two polls, not a fixed round count', async () => {
    const { fake, gatherEnv, ids } = await createChildren(5);
    for (const id of ids) fake.setStatus(id, { status: 'running' });

    await expect(pollGatherChildren(gatherEnv, ids, fresh(ids), 0)).resolves.toEqual({ done: false, state: { pending: ids, outputs: {} } });
    await expect(pollGatherChildren(gatherEnv, ids, fresh(ids), 1)).rejects.toThrow(/still not complete after 2 polls/);
  });

  // The other half of #75's polling cost: 19 of run `0357f119`'s 50
  // subrequests went on `status()` calls, some of them re-reading children
  // that had finished rounds earlier. The finished child is set to `errored`
  // between the two rounds, so a round that re-polled it would throw instead
  // of returning - which is what makes this an assertion about the
  // subrequest, not just about the arithmetic.
  it('does not re-poll a child that already completed, and carries its output forward', async () => {
    const { fake, gatherEnv, ids } = await createChildren(2);
    fake.setStatus(ids[0]!, { status: 'complete', output: 3 });
    fake.setStatus(ids[1]!, { status: 'running' });

    const first = await pollGatherChildren(gatherEnv, ids, fresh(ids), 0);
    if (first.done) throw new Error('expected round 0 to be incomplete');
    expect(first.state).toEqual({ pending: [ids[1]], outputs: { [ids[0]!]: 3 } });

    fake.setStatus(ids[0]!, { status: 'errored', error: { name: 'Error', message: 'boom' } });
    fake.setStatus(ids[1]!, { status: 'complete', output: 4 });
    fake.polled.length = 0;

    const second = await pollGatherChildren(gatherEnv, ids, first.state, 1);

    expect(second).toEqual({ done: true, total: 7 });
    expect(fake.polled).toEqual([ids[1]]);
  });

  it('validates a complete child\'s output rather than casting it - a non-count output fails the step', async () => {
    const { fake, gatherEnv, ids } = await createChildren(1);
    fake.setStatus(ids[0]!, { status: 'complete', output: 'not-a-count' });

    await expect(pollGatherChildren(gatherEnv, ids, fresh(ids), 0)).rejects.toThrow(/non-count/);
  });
});

/**
 * Same shape as `fakeGatherWorkflow()` above, generalized nowhere further
 * than that function was - a summarize child's output is an object
 * (`{ summaries, neuronsSpent }`), not an integer, so this fake's default
 * completed status carries one rather than `0`.
 */
function fakeSummarizeWorkflow(): {
  binding: Env['SUMMARIZE_WORKFLOW'];
  created: Map<string, SummarizeParams>;
  setStatus: (id: string, status: InstanceStatus) => void;
  /** As `fakeGatherWorkflow`'s: one entry is one parent subrequest. */
  polled: string[];
} {
  const created = new Map<string, SummarizeParams>();
  const statuses = new Map<string, InstanceStatus>();
  const polled: string[] = [];

  const binding = {
    createBatch: async (options: WorkflowInstanceCreateOptions<SummarizeParams>[]) => {
      for (const o of options) {
        if (o.id !== undefined && created.has(o.id)) {
          throw new Error(`Workflow instance ${o.id} already exists`);
        }
      }
      for (const o of options) {
        if (o.id === undefined) continue;
        created.set(o.id, o.params as SummarizeParams);
        if (!statuses.has(o.id)) statuses.set(o.id, { status: 'complete', output: { summaries: [], neuronsSpent: 0 } });
      }
      return options.map((o) => ({ id: o.id }) as unknown as WorkflowInstance);
    },
    get: async (id: string) => {
      if (!created.has(id)) throw new Error(`Workflow instance ${id} does not exist`);
      return {
        id,
        status: async () => {
          polled.push(id);
          return statuses.get(id) ?? { status: 'complete', output: { summaries: [], neuronsSpent: 0 } };
        },
      } as unknown as WorkflowInstance;
    },
  } as unknown as Env['SUMMARIZE_WORKFLOW'];

  return { binding, created, polled, setStatus: (id, status) => statuses.set(id, status) };
}

/**
 * The platform's own transient surface, as run `54ce776b` produced it. The
 * `{ name, message }` split is the measured renderer formula inverted onto
 * that run's rendering (`probe/FINDINGS.md` 8.2) - see
 * `isTransientChildFailure`'s comment in src/lib/workflow-children.ts.
 */
const TRANSIENT_CHILD_ERROR = {
  name: 'Error',
  message: 'WorkflowInternalError: Attempt failed due to internal workflows error',
};

describe('createSummarizeChildren()', () => {
  it('chunks the shortlist into SUMMARIZE_ARTICLES_PER_CHILD-sized groups with deterministic ids and a proportional budget slice', async () => {
    const fake = fakeSummarizeWorkflow();
    const summarizeEnv: Env = { ...env, SUMMARIZE_WORKFLOW: fake.binding, SUMMARIZE_ARTICLES_PER_CHILD: '3' };
    const shortlist = Array.from({ length: 7 }, (_, i) => candidate({ url: `https://example.com/${i}`, title: `Article ${i}` }));

    const ids = await createSummarizeChildren(summarizeEnv, 'parent-1', shortlist, topic(), 700);

    expect(ids).toEqual(['parent-1-s0', 'parent-1-s1', 'parent-1-s2']);
    expect(fake.created.get('parent-1-s0')?.candidates).toHaveLength(3);
    expect(fake.created.get('parent-1-s1')?.candidates).toHaveLength(3);
    expect(fake.created.get('parent-1-s2')?.candidates).toHaveLength(1);
    // 700 total across 7 candidates is 100/candidate - each child's slice is
    // proportional to how many candidates it carries, not an even split by
    // child count, and the three slices sum back to the whole 700.
    expect(fake.created.get('parent-1-s0')?.neuronBudget).toBeCloseTo(300);
    expect(fake.created.get('parent-1-s2')?.neuronBudget).toBeCloseTo(100);
    expect(fake.created.get('parent-1-s2')?.index).toBe(2);
    // topic is carried through unchanged so the child can call summarizeArticle.
    expect(fake.created.get('parent-1-s0')?.topic).toEqual(topic());
  });

  it('is idempotent on replay: a second call against an already-created id set does not throw and returns the same ids', async () => {
    const fake = fakeSummarizeWorkflow();
    const summarizeEnv: Env = { ...env, SUMMARIZE_WORKFLOW: fake.binding, SUMMARIZE_ARTICLES_PER_CHILD: '3' };
    const shortlist = Array.from({ length: 4 }, (_, i) => candidate({ url: `https://example.com/${i}` }));

    const first = await createSummarizeChildren(summarizeEnv, 'parent-replay', shortlist, topic(), 400);
    const second = await createSummarizeChildren(summarizeEnv, 'parent-replay', shortlist, topic(), 400);

    expect(second).toEqual(first);
    expect(fake.created.size).toBe(2); // not doubled
  });

  it('an empty shortlist creates no children', async () => {
    const fake = fakeSummarizeWorkflow();
    const summarizeEnv: Env = { ...env, SUMMARIZE_WORKFLOW: fake.binding, SUMMARIZE_ARTICLES_PER_CHILD: '5' };

    const ids = await createSummarizeChildren(summarizeEnv, 'parent-empty', [], topic(), 500);

    expect(ids).toEqual([]);
  });

  it('a genuine creation failure (not a duplicate id) still throws', async () => {
    const failing: Env['SUMMARIZE_WORKFLOW'] = {
      createBatch: async () => {
        throw new Error('quota exceeded');
      },
      get: async () => {
        throw new Error('Workflow instance does not exist');
      },
    } as unknown as Env['SUMMARIZE_WORKFLOW'];
    const summarizeEnv: Env = { ...env, SUMMARIZE_WORKFLOW: failing, SUMMARIZE_ARTICLES_PER_CHILD: '5' };

    await expect(
      createSummarizeChildren(summarizeEnv, 'parent-fail', [candidate()], topic(), 500),
    ).rejects.toThrow('quota exceeded');
  });
});

/**
 * The recognition rule requirement 4's narrowing turns on (#92). Its own
 * describe rather than a clause of the poll tests below, because which field
 * the class arrives in was the issue's open question: `probe/FINDINGS.md`
 * 8.1/8.3 measured `status.error.name` to be the literal `'Error'` for every
 * class in the capture corpus, with the thrown name folded into the front of
 * `message`. This table is what holds the rule to that measurement, including
 * the two exhaustion messages it must stay closed on.
 */
describe('isTransientChildFailure()', () => {
  it('recognises the one allowlisted platform class', () => {
    expect(isTransientChildFailure(TRANSIENT_CHILD_ERROR)).toBe(true);
  });

  // Fail closed. The first two are requirement 1's own measured argument one
  // level up - replacing a child that exhausted a resource spends the same
  // resource again - and the last two are why this is an exact match on the
  // token before the first colon rather than a substring test.
  it.each([
    'Worker exceeded CPU time limit.',
    'Too many subrequests by single Worker invocation.',
    // The subrequest message as the platform actually sends it. Its only colon
    // is `https:`, which is why splitting on `': '` keeps this closed.
    'Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/platform/limits/',
    'summarize child parent-poll-s0 errored',
    'boom',
    'wrapped WorkflowInternalError: not the leading token',
    'WorkflowInternalErrorish: not the same class',
  ])('fails closed on %s', (message) => {
    expect(isTransientChildFailure({ name: 'Error', message })).toBe(false);
  });

  it('fails closed when the platform reported no error object at all', () => {
    expect(isTransientChildFailure(undefined)).toBe(false);
  });
});

describe('pollSummarizeChildren()', () => {
  const shortlistFor = (count: number): Candidate[] =>
    Array.from({ length: count }, (_, i) => candidate({ url: `https://example.com/${i}` }));

  /**
   * The replacement capability `run()` hands this loop and hands no other
   * (spec.md requirement 4's narrowing, #92), built from the same inputs the
   * children were created from - which is the point of it: a replacement
   * recreates a child with the params the original was created with.
   */
  const replaceFor = (summarizeEnv: Env, count: number): ChildReplacement =>
    summarizeReplacement(summarizeEnv, 'parent-poll', shortlistFor(count), topic(), 100 * count);

  async function createChildrenFor(
    count: number,
  ): Promise<{ fake: ReturnType<typeof fakeSummarizeWorkflow>; summarizeEnv: Env; ids: string[] }> {
    const fake = fakeSummarizeWorkflow();
    const summarizeEnv: Env = { ...env, SUMMARIZE_WORKFLOW: fake.binding, SUMMARIZE_ARTICLES_PER_CHILD: '1' };
    const ids = await createSummarizeChildren(summarizeEnv, 'parent-poll', shortlistFor(count), topic(), 100 * count);
    return { fake, summarizeEnv, ids };
  }

  const fresh = (ids: string[]): SummarizePollState => initialChildPollState<SummarizeChildOutput>(ids);

  it('concatenates every complete child\'s summaries and sums their neuron spend once every child is complete', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(2);
    const a = summary({ url: 'https://example.com/a' });
    const b = summary({ url: 'https://example.com/b' });
    fake.setStatus(ids[0]!, { status: 'complete', output: { summaries: [a], neuronsSpent: 200 } });
    fake.setStatus(ids[1]!, { status: 'complete', output: { summaries: [b], neuronsSpent: 150 } });

    const result = await pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length));

    expect(result).toEqual({ done: true, summaries: [a, b], neuronsSpent: 350 });
  });

  it('returns done: false while any child has not reached complete', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(2);
    fake.setStatus(ids[0]!, { status: 'complete', output: { summaries: [], neuronsSpent: 0 } });
    fake.setStatus(ids[1]!, { status: 'running' });

    const result = await pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length));

    expect(result).toEqual({
      done: false,
      state: { pending: [ids[1]], outputs: { [ids[0]!]: { summaries: [], neuronsSpent: 0 } } },
    });
  });

  it('fails (visibly) the moment a child is errored, rather than contributing zero silently', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(2);
    fake.setStatus(ids[0]!, { status: 'errored', error: { name: 'Error', message: 'boom' } });
    fake.setStatus(ids[1]!, { status: 'complete', output: { summaries: [], neuronsSpent: 0 } });

    await expect(pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length))).rejects.toThrow(/errored/);
  });

  it('fails when a child is terminated', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(1);
    fake.setStatus(ids[0]!, { status: 'terminated' });

    await expect(pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length))).rejects.toThrow(/terminated/);
  });

  it('fails rather than hangs once the poll round cap is reached', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(1);
    fake.setStatus(ids[0]!, { status: 'running' });

    await expect(pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 1000, replaceFor(summarizeEnv, ids.length))).rejects.toThrow(/still not complete/);
  });

  // Pins the cap's arithmetic (SUMMARIZE_POLL_SUBREQUEST_BUDGET / children)
  // at a concrete child count - see createGatherChildren's sibling test for
  // why this is pinned rather than left to "a large round eventually fails".
  // SUMMARIZE_POLL_SUBREQUEST_BUDGET dropped from 15 to 9 on 2026-09-01
  // (#75), which is what moves this from round 5 to round 3.
  it('at 3 children (SUMMARIZE_ARTICLES_PER_CHILD default over SHORTLIST_TOP_N), the derived cap is three polls, not a fixed round count', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(3);
    for (const id of ids) fake.setStatus(id, { status: 'running' });

    await expect(pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 1, replaceFor(summarizeEnv, ids.length))).resolves.toEqual({ done: false, state: { pending: ids, outputs: {} } });
    await expect(pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 2, replaceFor(summarizeEnv, ids.length))).rejects.toThrow(/still not complete after 3 polls/);
  });

  // --- requirement 4's narrowing (#92) ------------------------------------
  // Run `54ce776b`: child `s0` returned three real summaries, hung four
  // minutes on its fourth article and errored with the platform's own
  // `WorkflowInternalError` while `s1` and `s2` were already complete and the
  // parent was at ~30 of 50 subrequests.

  it('replaces a child that errored with the recognised transient class, and polls the replacement in its place', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(2);
    const b = summary({ title: 'Article B' });
    fake.setStatus(ids[0]!, { status: 'errored', error: TRANSIENT_CHILD_ERROR });
    fake.setStatus(ids[1]!, { status: 'complete', output: { summaries: [b], neuronsSpent: 150 } });

    const first = await pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length));

    if (first.done) throw new Error('expected the replacement to still be pending');
    expect(first.state.pending).toEqual([`${ids[0]}r1`]);
    // The record travels in this step's own output, not a closure - `run()`
    // re-executes on replay.
    expect(first.state.replacements).toEqual({ [ids[0]!]: `${ids[0]}r1` });
    // The sibling that completed in the very round the other child errored is
    // carried forward rather than discarded with the error.
    expect(first.state.outputs[ids[1]!]).toEqual({ summaries: [b], neuronsSpent: 150 });
    // Recreated with the params the original was created with.
    expect(fake.created.get(`${ids[0]}r1`)).toEqual(fake.created.get(ids[0]!));

    const a = summary({ title: 'Article A' });
    fake.setStatus(`${ids[0]}r1`, { status: 'complete', output: { summaries: [a], neuronsSpent: 200 } });

    const second = await pollSummarizeChildren(summarizeEnv, ids, first.state, 1, replaceFor(summarizeEnv, ids.length));

    // The replacement's output lands in the replaced child's slot, so
    // `synthesize` still sees child-id order rather than completion order.
    expect(second).toEqual({ done: true, summaries: [a, b], neuronsSpent: 350 });
  });

  it('recreates the same replacement on replay rather than a fresh one per replay', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(1);
    fake.setStatus(ids[0]!, { status: 'errored', error: TRANSIENT_CHILD_ERROR });

    const attempt = await pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length));
    const replay = await pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length));

    expect(replay).toEqual(attempt);
    // Two instances, not three: the second create hits `createChildBatch`'s
    // already-exists tolerance, verified against reality rather than assumed.
    expect([...fake.created.keys()]).toEqual([ids[0], `${ids[0]}r1`]);
  });

  it('a replacement that also fails still fails the run', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(1);
    fake.setStatus(ids[0]!, { status: 'errored', error: TRANSIENT_CHILD_ERROR });
    const first = await pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length));
    if (first.done) throw new Error('expected the replacement to still be pending');
    fake.setStatus(`${ids[0]}r1`, { status: 'errored', error: TRANSIENT_CHILD_ERROR });

    await expect(
      pollSummarizeChildren(summarizeEnv, ids, first.state, 1, replaceFor(summarizeEnv, ids.length)),
    ).rejects.toThrow(/errored/);
  });

  // Fail closed, at the seam rather than in the predicate: these are the
  // classes `isTransientChildFailure` rejects, proved to reach the run's own
  // failure rather than a replacement.
  it.each([
    'Worker exceeded CPU time limit.',
    'Too many subrequests by single Worker invocation.',
  ])('fails the run rather than replacing a child that errored with %s', async (message) => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(1);
    fake.setStatus(ids[0]!, { status: 'errored', error: { name: 'Error', message } });

    await expect(
      pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length)),
    ).rejects.toThrow(/errored/);
    expect(fake.created.has(`${ids[0]}r1`)).toBe(false);
  });

  it('does not replace a terminated child even when its error names the transient class - a terminate is deliberate', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(1);
    fake.setStatus(ids[0]!, { status: 'terminated', error: TRANSIENT_CHILD_ERROR });

    await expect(
      pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length)),
    ).rejects.toThrow(/terminated/);
    expect(fake.created.has(`${ids[0]}r1`)).toBe(false);
  });

  // Both of these keep the allowance arithmetic true rather than merely
  // tidy: an extra poll round costs one subrequest only while the
  // replacement is the only child left to poll, and the allowance buys
  // `floor(3 / (1 + 2))` = one replacement per run.
  it('fails the run when a sibling is still running, rather than granting rounds that cost one subrequest per child', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(2);
    fake.setStatus(ids[0]!, { status: 'errored', error: TRANSIENT_CHILD_ERROR });
    fake.setStatus(ids[1]!, { status: 'running' });

    await expect(
      pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length)),
    ).rejects.toThrow(/errored/);
    expect(fake.created.has(`${ids[0]}r1`)).toBe(false);
  });

  it('fails the run when two children error transiently in the same round', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(2);
    fake.setStatus(ids[0]!, { status: 'errored', error: TRANSIENT_CHILD_ERROR });
    fake.setStatus(ids[1]!, { status: 'errored', error: TRANSIENT_CHILD_ERROR });

    await expect(
      pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length)),
    ).rejects.toThrow(/errored/);
  });

  // The part that decides whether this mechanism is live code or dead code.
  // At 3 children the cap is `max(2, floor(9 / 3))` = three polls, and run
  // `54ce776b` errored in the very round that cap was reached - so a
  // replacement swapped into `pending` with the cap untouched would get zero
  // rounds to converge. The grant is what buys it two, at one subrequest each.
  it('grants the replacement extra poll rounds, because the cap it was created under has none left', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(3);
    fake.setStatus(ids[0]!, { status: 'errored', error: TRANSIENT_CHILD_ERROR });
    fake.setStatus(ids[1]!, { status: 'complete', output: { summaries: [], neuronsSpent: 0 } });
    fake.setStatus(ids[2]!, { status: 'complete', output: { summaries: [], neuronsSpent: 0 } });

    const replaced = await pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 2, replaceFor(summarizeEnv, 3));

    if (replaced.done) throw new Error('expected the replacement to still be pending');
    fake.setStatus(`${ids[0]}r1`, { status: 'running' });
    fake.polled.length = 0;

    await expect(pollSummarizeChildren(summarizeEnv, ids, replaced.state, 3, replaceFor(summarizeEnv, 3)))
      .resolves.toMatchObject({ done: false });
    await expect(pollSummarizeChildren(summarizeEnv, ids, replaced.state, 4, replaceFor(summarizeEnv, 3)))
      .rejects.toThrow(/still not complete after 5 polls/);
    // One subrequest per granted round, not three: only the replacement is
    // pending, which is what `isReplaceable`'s last clause guarantees.
    expect(fake.polled).toEqual([`${ids[0]}r1`, `${ids[0]}r1`]);
  });

  it('does not re-poll a child that already completed, and carries its summaries forward', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(2);
    const a = summary({ title: 'Article A' });
    const b = summary({ title: 'Article B' });
    fake.setStatus(ids[0]!, { status: 'complete', output: { summaries: [a], neuronsSpent: 200 } });
    fake.setStatus(ids[1]!, { status: 'running' });

    const first = await pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length));
    if (first.done) throw new Error('expected round 0 to be incomplete');

    fake.setStatus(ids[0]!, { status: 'errored', error: { name: 'Error', message: 'boom' } });
    fake.setStatus(ids[1]!, { status: 'complete', output: { summaries: [b], neuronsSpent: 150 } });
    fake.polled.length = 0;

    const second = await pollSummarizeChildren(summarizeEnv, ids, first.state, 1, replaceFor(summarizeEnv, ids.length));

    expect(second).toEqual({ done: true, summaries: [a, b], neuronsSpent: 350 });
    expect(fake.polled).toEqual([ids[1]]);
  });

  // `run()` re-executes from the top on every replay (spec.md fact 2), so a
  // round has to be a function of its input state rather than of anything
  // accumulated in the parent's memory. Running the same middle round twice
  // is what a replay looks like from this function's side; the summaries must
  // not double up.
  it('is deterministic when a middle round is replayed against the same input state', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(2);
    const a = summary({ title: 'Article A' });
    const b = summary({ title: 'Article B' });
    fake.setStatus(ids[0]!, { status: 'complete', output: { summaries: [a], neuronsSpent: 200 } });
    fake.setStatus(ids[1]!, { status: 'running' });

    const first = await pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length));
    if (first.done) throw new Error('expected round 0 to be incomplete');
    fake.setStatus(ids[1]!, { status: 'complete', output: { summaries: [b], neuronsSpent: 150 } });

    const attempt = await pollSummarizeChildren(summarizeEnv, ids, first.state, 1, replaceFor(summarizeEnv, ids.length));
    const replay = await pollSummarizeChildren(summarizeEnv, ids, first.state, 1, replaceFor(summarizeEnv, ids.length));

    expect(attempt).toEqual({ done: true, summaries: [a, b], neuronsSpent: 350 });
    expect(replay).toEqual(attempt);
  });

  // Completion order is whatever the platform's children happen to do;
  // `synthesize`'s input should not depend on it.
  it('combines in child id order, not in the order children completed', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(2);
    const a = summary({ title: 'Article A' });
    const b = summary({ title: 'Article B' });
    fake.setStatus(ids[0]!, { status: 'running' });
    fake.setStatus(ids[1]!, { status: 'complete', output: { summaries: [b], neuronsSpent: 1 } });

    const first = await pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length));
    if (first.done) throw new Error('expected round 0 to be incomplete');
    fake.setStatus(ids[0]!, { status: 'complete', output: { summaries: [a], neuronsSpent: 2 } });

    const second = await pollSummarizeChildren(summarizeEnv, ids, first.state, 1, replaceFor(summarizeEnv, ids.length));

    expect(second).toEqual({ done: true, summaries: [a, b], neuronsSpent: 3 });
  });

  it('validates a complete child\'s output rather than casting it - a malformed output fails the step', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(1);
    fake.setStatus(ids[0]!, { status: 'complete', output: 'not-an-object' });

    await expect(pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length))).rejects.toThrow(/non-object/);
  });

  it('validates the summaries array element shape rather than casting it', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(1);
    fake.setStatus(ids[0]!, { status: 'complete', output: { summaries: [{ url: 'x' }], neuronsSpent: 0 } });

    await expect(pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length))).rejects.toThrow(/malformed summaries/);
  });

  it('validates neuronsSpent rather than casting it', async () => {
    const { fake, summarizeEnv, ids } = await createChildrenFor(1);
    fake.setStatus(ids[0]!, { status: 'complete', output: { summaries: [], neuronsSpent: 'lots' } });

    await expect(pollSummarizeChildren(summarizeEnv, ids, fresh(ids), 0, replaceFor(summarizeEnv, ids.length))).rejects.toThrow(/non-count neuronsSpent/);
  });
});

/** Not a real URL of anything - just the bounded string a publish child returns. */
const PR_URL = 'https://github.test.example/nimeshjm/nimeshjm.com/pull/1';

/**
 * Same shape as `fakeGatherWorkflow()` and `fakeSummarizeWorkflow()` above,
 * generalized no further than those two were - a publish child's output is a
 * single URL string, so this fake's default completed status carries one.
 */
function fakePublishWorkflow(): {
  binding: Env['PUBLISH_WORKFLOW'];
  created: Map<string, PublishParams>;
  setStatus: (id: string, status: InstanceStatus) => void;
  /** As `fakeGatherWorkflow`'s: one entry is one parent subrequest. */
  polled: string[];
} {
  const created = new Map<string, PublishParams>();
  const statuses = new Map<string, InstanceStatus>();
  const polled: string[] = [];
  const defaultStatus: InstanceStatus = { status: 'complete', output: PR_URL };

  const binding = {
    createBatch: async (options: WorkflowInstanceCreateOptions<PublishParams>[]) => {
      for (const o of options) {
        if (o.id !== undefined && created.has(o.id)) {
          throw new Error(`Workflow instance ${o.id} already exists`);
        }
      }
      for (const o of options) {
        if (o.id === undefined) continue;
        created.set(o.id, o.params as PublishParams);
        if (!statuses.has(o.id)) statuses.set(o.id, defaultStatus);
      }
      return options.map((o) => ({ id: o.id }) as unknown as WorkflowInstance);
    },
    get: async (id: string) => {
      if (!created.has(id)) throw new Error(`Workflow instance ${id} does not exist`);
      return {
        id,
        status: async () => {
          polled.push(id);
          return statuses.get(id) ?? defaultStatus;
        },
      } as unknown as WorkflowInstance;
    },
  } as unknown as Env['PUBLISH_WORKFLOW'];

  return { binding, created, polled, setStatus: (id, status) => statuses.set(id, status) };
}

function publishDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    slug: 'agentic-code-review',
    title: 'Why agentic code review catches more bugs',
    description: 'A tension worth stating.',
    date: '2026-08-27',
    authors: ['nimeshjm'],
    tags: ['ai'],
    draft: true,
    brief: '# Research brief',
    body: '## Heading\n\nProse.',
    sources: [],
    ...overrides,
  };
}

describe('createPublishChildren()', () => {
  it('creates exactly one child, carrying the whole draft, under a deterministic id', async () => {
    const fake = fakePublishWorkflow();
    const publishEnv: Env = { ...env, PUBLISH_WORKFLOW: fake.binding };

    const ids = await createPublishChildren(publishEnv, 'parent-1', publishDraft());

    expect(ids).toEqual(['parent-1-p0']);
    // The brief travels as part of the Draft - the child authors nothing and
    // needs no second field for the PR body.
    expect(fake.created.get('parent-1-p0')?.draft).toEqual(publishDraft());
  });

  it('is idempotent on replay: a second call against an already-created id does not throw and returns the same id', async () => {
    const fake = fakePublishWorkflow();
    const publishEnv: Env = { ...env, PUBLISH_WORKFLOW: fake.binding };

    const first = await createPublishChildren(publishEnv, 'parent-replay', publishDraft());
    const second = await createPublishChildren(publishEnv, 'parent-replay', publishDraft());

    expect(second).toEqual(first);
    expect(fake.created.size).toBe(1); // not doubled
  });

  it('a genuine creation failure (not a duplicate id) still throws', async () => {
    const failing: Env['PUBLISH_WORKFLOW'] = {
      createBatch: async () => {
        throw new Error('quota exceeded');
      },
      get: async () => {
        throw new Error('Workflow instance does not exist');
      },
    } as unknown as Env['PUBLISH_WORKFLOW'];
    const publishEnv: Env = { ...env, PUBLISH_WORKFLOW: failing };

    await expect(createPublishChildren(publishEnv, 'parent-fail', publishDraft())).rejects.toThrow('quota exceeded');
  });
});

describe('pollPublishChildren()', () => {
  async function createChild(): Promise<{ fake: ReturnType<typeof fakePublishWorkflow>; publishEnv: Env; ids: string[] }> {
    const fake = fakePublishWorkflow();
    const publishEnv: Env = { ...env, PUBLISH_WORKFLOW: fake.binding };
    const ids = await createPublishChildren(publishEnv, 'parent-poll', publishDraft());
    return { fake, publishEnv, ids };
  }

  const fresh = (ids: string[]): PublishPollState => initialChildPollState<string>(ids);

  it('reads the pull request URL back off the completed child', async () => {
    const { fake, publishEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'complete', output: PR_URL });

    const result = await pollPublishChildren(publishEnv, ids, fresh(ids), 0);

    expect(result).toEqual({ done: true, prUrl: PR_URL });
    expect(fake.polled).toEqual(ids); // one child, so one subrequest per round
  });

  it('returns done: false while the child has not reached complete', async () => {
    const { fake, publishEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'running' } as InstanceStatus);

    const result = await pollPublishChildren(publishEnv, ids, fresh(ids), 0);

    expect(result).toEqual({ done: false, state: { pending: ids, outputs: {} } });
  });

  // spec.md requirement 4, and the difference that matters most here: a
  // publication that failed must fail the run rather than let `record-success`
  // write a `runs` row claiming success.
  it('fails (visibly) the moment the child is errored, rather than recording a success with no PR', async () => {
    const { fake, publishEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'errored' } as InstanceStatus);

    await expect(pollPublishChildren(publishEnv, ids, fresh(ids), 0)).rejects.toThrow(/publish child .* errored/);
  });

  it('fails when the child is terminated', async () => {
    const { fake, publishEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'terminated' } as InstanceStatus);

    await expect(pollPublishChildren(publishEnv, ids, fresh(ids), 0)).rejects.toThrow(/publish child .* terminated/);
  });

  // At one child the derived cap `max(2, floor(budget / childCount))` divides
  // by 1, so PUBLISH_POLL_SUBREQUEST_BUDGET *is* the poll count: rounds 0-2
  // poll and return, and the fourth poll - round 3 - is where the backstop
  // fires, having spent the fourth of the four subrequests the parent's
  // ledger charges this loop.
  it('fails rather than hangs once the derived round cap is reached, which at one child equals the budget', async () => {
    const { fake, publishEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'running' } as InstanceStatus);

    await expect(pollPublishChildren(publishEnv, ids, fresh(ids), 2)).resolves.toMatchObject({ done: false });
    await expect(pollPublishChildren(publishEnv, ids, fresh(ids), 3)).rejects.toThrow(/after 4 polls/);
  });

  it('validates the completed output rather than casting it - a non-string output fails the step', async () => {
    const { fake, publishEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'complete', output: { html_url: PR_URL } });

    await expect(pollPublishChildren(publishEnv, ids, fresh(ids), 0)).rejects.toThrow(/no pull request URL/);
  });

  // An empty string would reach `record-success` as a `pr_url` of '', which is
  // exactly the "succeeded with nothing published" row acceptance criterion 2
  // is stated against.
  it('validates that the URL is non-empty, not merely a string', async () => {
    const { fake, publishEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'complete', output: '' });

    await expect(pollPublishChildren(publishEnv, ids, fresh(ids), 0)).rejects.toThrow(/no pull request URL/);
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

  it('ranks a priority source above a deferred one on the strength of the tier offset alone', async () => {
    const t = topic({ title: 'agentic code review', angle: null });
    const runId = 'run-shortlist-tier';
    // Without the offset the arXiv title wins outright: full topic overlap
    // plus the practice signal (3 + 2) against a priority-source title that
    // shares nothing with the topic (0). With it, 2 against 3.
    await writeRunCandidates(env.DB, runId, 'Anthropic Engineering', [
      candidate({ url: 'https://example.com/priority', title: 'Notes on something unrelated' }),
    ]);
    await writeRunCandidates(env.DB, runId, 'arXiv cs.AI', [
      candidate({ url: 'https://example.com/deferred', title: 'A study of agentic code review results' }),
    ]);

    const result = await shortlistCandidates(env, runId, t);

    expect(result.map((c) => c.url)).toEqual(['https://example.com/priority', 'https://example.com/deferred']);
  });

  it('lets a strongly on-topic deferred source outrank a weak priority one: the tier is an offset, not a gate', async () => {
    const t = topic({ title: 'agentic code review at scale for teams', angle: null });
    const runId = 'run-shortlist-tier-offset';
    await writeRunCandidates(env.DB, runId, 'Anthropic News', [
      candidate({ url: 'https://example.com/weak-priority', title: 'Announcing something unrelated' }),
    ]);
    await writeRunCandidates(env.DB, runId, 'arXiv cs.AI', [
      candidate({ url: 'https://example.com/on-topic-paper', title: 'Agentic code review at scale for teams: benchmark results' }),
    ]);

    // 5 overlap + 2 practice - 3 tier = 4, against 0 overlap - 1 commentary
    // + 3 tier = 2. This is the case a primary sort key on tier would get
    // wrong, and the reason TIER_SCORE_WEIGHT is bounded.
    const result = await shortlistCandidates(env, runId, t);

    expect(result.map((c) => c.url)).toEqual(['https://example.com/on-topic-paper', 'https://example.com/weak-priority']);
  });

  it('leaves the 35 unmarked sources between the two: a default source outranks a deferred one on an equal title', async () => {
    const t = topic({ title: 'agentic code review', angle: null });
    const runId = 'run-shortlist-tier-default';
    // Identical titles, so the whole ordering is the tier term - and the
    // point is that the unmarked majority of the allowlist is not lumped in
    // with arXiv.
    const title = 'Agentic code review in practice';
    await writeRunCandidates(env.DB, runId, 'Martin Fowler', [candidate({ url: 'https://example.com/default', title })]);
    await writeRunCandidates(env.DB, runId, 'arXiv cs.SE', [candidate({ url: 'https://example.com/deferred', title })]);
    await writeRunCandidates(env.DB, runId, 'Claude', [candidate({ url: 'https://example.com/priority', title })]);

    const result = await shortlistCandidates(env, runId, t);

    expect(result.map((c) => c.url)).toEqual([
      'https://example.com/priority',
      'https://example.com/default',
      'https://example.com/deferred',
    ]);
  });

  it('deferred sources still fill the slots the priority feeds leave, so a thin priority day still grounds', async () => {
    const t = topic({ title: 'agentic code review', angle: null });
    const runId = 'run-shortlist-tier-fallthrough';
    // One priority item and SHORTLIST_TOP_N deferred ones: the deferred set
    // must fill the remaining slots, or `isGrounded`'s MIN_SOURCES could not
    // be met on a day when the priority feeds published once.
    await writeRunCandidates(env.DB, runId, 'Claude', [
      candidate({ url: 'https://example.com/only-priority', title: 'Agentic code review at scale' }),
    ]);
    await writeRunCandidates(
      env.DB,
      runId,
      'arXiv cs.SE',
      Array.from({ length: SHORTLIST_TOP_N }, (_, i) =>
        candidate({ url: `https://example.com/paper-${i}`, title: `Agentic code review paper ${i}` }),
      ),
    );

    const result = await shortlistCandidates(env, runId, t);

    expect(result).toHaveLength(SHORTLIST_TOP_N);
    expect(result[0]?.url).toBe('https://example.com/only-priority');
    expect(result.slice(1).every((c) => c.sourceName === 'arXiv cs.SE')).toBe(true);
  });

  it('scores a candidate from a source no longer in the allowlist at the default tier', async () => {
    const t = topic({ title: 'agentic code review', angle: null });
    const runId = 'run-shortlist-tier-unknown';
    // `run_candidates` rows outlive an edit to config/feeds.json, so the
    // name join has to miss without sinking the row below the deferred feeds.
    await writeRunCandidates(env.DB, runId, 'Delisted Blog', [
      candidate({ url: 'https://example.com/delisted', title: 'Agentic code review in practice' }),
    ]);
    await writeRunCandidates(env.DB, runId, 'arXiv cs.AI', [
      candidate({ url: 'https://example.com/paper', title: 'Agentic code review in practice' }),
    ]);

    const result = await shortlistCandidates(env, runId, t);

    expect(result.map((c) => c.url)).toEqual(['https://example.com/delisted', 'https://example.com/paper']);
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
    const REF_TIER_SCORE_WEIGHT = 3;
    /** Mirrors `sourceTiers()` by reading the allowlist, not by restating it - a tier edit in config/feeds.json must not silently make the two sides agree. */
    function refTierOf(sourceName: string): number {
      return loadFeeds().find((s) => s.name === sourceName)?.tier ?? 1;
    }
    function refRelevanceScore(c: Candidate, t: Topic): number {
      const topicWords = new Set([...refTokenize(t.title), ...refTokenize(t.angle ?? '')]);
      const candidateWords = refTokenize(c.title);
      let overlap = 0;
      for (const word of candidateWords) if (topicWords.has(word)) overlap++;
      let score = overlap;
      if (REF_PRACTICE_SIGNAL_RE.test(c.title)) score += 2;
      if (REF_COMMENTARY_SIGNAL_RE.test(c.title)) score -= 1;
      const tier = refTierOf(c.sourceName);
      if (tier === 0) score += REF_TIER_SCORE_WEIGHT;
      if (tier === 2) score -= REF_TIER_SCORE_WEIGHT;
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

      // Three tiers in the fixture, or the parity claim would only hold over
      // tier-invariant input - and the tier term would be untested here while
      // looking covered. The deferred item deliberately scores highest on the
      // heuristic before its tier is applied.
      const tiered: Candidate[] = [
        candidate({
          url: 'https://example.com/priority',
          title: 'Notes from our own rollout',
          publishedAt: minutesAgo(6),
          publishedMs: now - 6 * 60_000,
          sourceName: 'Anthropic Engineering',
        }),
        candidate({
          url: 'https://example.com/deferred',
          title: 'Agentic code review for catching bugs: a benchmark study',
          publishedAt: minutesAgo(7),
          publishedMs: now - 7 * 60_000,
          sourceName: 'arXiv cs.AI',
        }),
      ];

      const runId = 'run-shortlist-parity';
      await writeRunCandidates(env.DB, runId, 'Source', fixture);
      for (const c of tiered) await writeRunCandidates(env.DB, runId, c.sourceName, [c]);
      await env.DB.prepare(`INSERT INTO seen_urls (url, source) VALUES (?, 'test')`).bind('https://example.com/seen-item').run();

      const t = topic({ title: 'agentic code review', angle: 'catching bugs' });

      // `writeRunCandidates` stamps the source name on the row, so the
      // in-memory side has to carry the same one the D1 side will read back.
      const inMemory = [...fixture.map((c) => ({ ...c, sourceName: 'Source' })), ...tiered];

      const actual = await shortlistCandidates(env, runId, t);
      const expected = referenceShortlist(inMemory, new Set(['https://example.com/seen-item']), t);

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
    expect(result.topic?.title).toBe('targeted');
    expect(result.topic?.status).toBe('in_progress');
    expect(result.strandedRuns).toBe(0); // targeted path never sweeps
  });

  it('drains the queue before proposing', async () => {
    await env.DB.prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('queued one', NULL, 'queued', 'human')`).run();
    const result = await selectTopic(env, 'run-drain', undefined);
    expect(result.topic?.title).toBe('queued one');
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

    // start-run always precedes select-topic in the real pipeline (run() in
    // src/workflow.ts) - required here since #104, so attachRunTopic's write
    // has a runs row to land on and reclaimAndClaim's self-exclusion
    // (coveredTopicTitles must not contain this same run's own proposal) has
    // something to exclude against.
    await startRun(env.DB, 'run-replay');

    const first = await selectTopic(env, 'run-replay', undefined);
    expect(first.topic?.title).toBe('Brand New Unrelated Topic Nobody Has Written About');
    expect(first.topic?.origin).toBe('agent');
    expect(first.topic?.status).toBe('in_progress');

    // Replay: a retried select-topic step must recover the same row, not
    // insert a second one, and must not reject its own deterministic
    // proposal as "already covered" by itself (#104).
    const second = await selectTopic(env, 'run-replay', undefined);
    expect(second.topic?.id).toBe(first.topic?.id);

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
    expect(result.topic).toBeNull();
  });

  // #104: end-to-end through the real D1 batch, not just proposeTopic() in
  // isolation - proves reclaimAndClaim's fourth statement actually reaches
  // proposeTopic through selectTopic. Reproduces PR #2 -> PR #3: #2's title
  // is a `topics` row (origin: agent, status: in_progress - exactly what
  // findOrProposeTopic leaves behind, and #104's design note on why `done`
  // is never reached in practice), and the seed feed's only candidate is
  // #3's near-duplicate. Without the fix this returns #3's title; the fixed
  // behaviour returns null, matching "no genuinely uncovered candidate".
  it('with an empty queue, a topics row from an earlier propose blocks a near-duplicate seed candidate (#104)', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');

    await env.DB
      .prepare(
        `INSERT INTO topics (title, angle, status, origin) VALUES (?, NULL, 'in_progress', 'agent')`,
      )
      .bind('Structure-Behavior Coalescence: A Unified Lens for System Design')
      .run();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          return new Response(
            rssFeed([{ title: 'Structure-Behavior Coalescence: Rethinking System Design', url: 'https://seed.example/sbc-2' }]),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await selectTopic(env, 'run-topics-dedupe', undefined);
    expect(result.topic).toBeNull();
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
    expect(afterSelect?.topic_id).toBe(result.topic?.id);
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

    expect(result.topic?.id).toBe(insert?.id);
    expect(result.topic?.status).toBe('in_progress');
  });

  // -------------------------------------------------------------------------
  // #91: the scheduled path's D1 batch also sweeps `runs` rows left
  // `running` past the same TTL to `failed` - feature 002 requirement 10's
  // second clause ("updated with its outcome, so a hard step failure is
  // distinguishable after the fact"), previously unimplemented. Same TTL,
  // same "unattended by definition" argument as the topic reclaim above.
  // -------------------------------------------------------------------------
  it(`a runs row left running ${STALE_AGE_HOURS}h ago, past TOPIC_CLAIM_TTL_HOURS, is swept to failed by a plain scheduled call`, async () => {
    expect(TOPIC_CLAIM_TTL_HOURS).toBeLessThan(STALE_AGE_HOURS);
    // A queued topic so the scheduled path resolves inside reclaimAndClaim
    // and never falls through to proposeTopic's real fetch calls - keeps
    // this test about the runs sweep, not about stubbing the network too.
    await env.DB.prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('queued one', NULL, 'queued', 'human')`).run();
    await env.DB
      .prepare(
        `INSERT INTO runs (instance_id, status, started_at) VALUES ('run-stranded', 'running', datetime('now', '-' || ? || ' hours'))`,
      )
      .bind(STALE_AGE_HOURS)
      .run();

    const result = await selectTopic(env, 'run-sweeper', undefined);

    expect(result.strandedRuns).toBe(1);
    const row = await env.DB.prepare('SELECT status, finished_at FROM runs WHERE instance_id = ?').bind('run-stranded').first<{
      status: string;
      finished_at: string | null;
    }>();
    expect(row?.status).toBe('failed');
    expect(row?.finished_at).not.toBeNull();
  });

  it(`does not sweep a runs row left running only ${LIVE_AGE_HOURS}h ago, within TOPIC_CLAIM_TTL_HOURS (a live run is not marked failed)`, async () => {
    expect(TOPIC_CLAIM_TTL_HOURS).toBeGreaterThan(LIVE_AGE_HOURS);
    // Same reason as the test above: a queued topic keeps this test off
    // proposeTopic's real fetch calls.
    await env.DB.prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('queued one', NULL, 'queued', 'human')`).run();
    await env.DB
      .prepare(
        `INSERT INTO runs (instance_id, status, started_at) VALUES ('run-live', 'running', datetime('now', '-' || ? || ' hours'))`,
      )
      .bind(LIVE_AGE_HOURS)
      .run();

    const result = await selectTopic(env, 'run-sweeper-2', undefined);

    expect(result.strandedRuns).toBe(0);
    const row = await env.DB.prepare('SELECT status FROM runs WHERE instance_id = ?').bind('run-live').first<{
      status: string;
    }>();
    expect(row?.status).toBe('running');
  });

  it('never sweeps the calling run\'s own row, which started seconds ago on this same call', async () => {
    // A queued topic keeps this test off proposeTopic's real fetch calls too.
    await env.DB.prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('queued one', NULL, 'queued', 'human')`).run();
    await startRun(env.DB, 'run-self');

    // selectTopic is called as the second step of a run whose start-run
    // already wrote this row `running` - the sweep must not be able to mark
    // its own caller's run failed just because it is the one running it.
    await selectTopic(env, 'run-self', undefined);

    const row = await env.DB.prepare('SELECT status FROM runs WHERE instance_id = ?').bind('run-self').first<{
      status: string;
    }>();
    expect(row?.status).toBe('running');
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

    expect(result.topic?.title).toBe('other queued');
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

    expect(result.topic?.id).toBe(named?.id);
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

    const result = await proposeTopic(env, []);

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

    const result = await proposeTopic(env, []);
    expect(result?.title).toBe('agentic infrastructure provisioning');
  });

  it('returns null when the blog feed cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await proposeTopic(env, []);
    expect(result).toBeNull();
  });

  // #104: reproduces the observed case - blog PR #2's title landed in
  // `topics` (origin: agent), and blog PR #3 was proposed two days later
  // sharing four non-stopword tokens with it ("structure", "behavior",
  // "coalescence", "system"), past DUPLICATE_TOKEN_THRESHOLD (2). Neither
  // the published feed nor the repo directory listing sees an unmerged
  // draft, so `coveredTopicTitles` - the third covered set - is the only
  // thing that can catch this. Without the fix, this test fails: nothing
  // else in `proposeTopic` rejects the near-duplicate.
  it('rejects a seed candidate that overlaps a title in coveredTopicTitles, even though it is absent from the feed and the repo', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          return new Response(
            rssFeed([
              {
                title: 'Structure-Behavior Coalescence: Rethinking System Design',
                url: 'https://seed.example/sbc-2',
              },
              { title: 'Genuinely Unrelated Topic', url: 'https://seed.example/unrelated' },
            ]),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await proposeTopic(env, ['Structure-Behavior Coalescence: A Unified Lens for System Design']);

    // The near-duplicate of the topics-table title is skipped; the
    // genuinely uncovered item is proposed instead.
    expect(result?.title).toBe('Genuinely Unrelated Topic');
  });

  it(`does not reject a seed candidate sharing fewer than ${DUPLICATE_TOKEN_THRESHOLD} words with a coveredTopicTitles entry`, async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          // Shares only one meaningful word ("agentic") with the topics-table title.
          return new Response(rssFeed([{ title: 'agentic infrastructure provisioning', url: 'https://seed.example/one-word' }]));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await proposeTopic(env, ['agentic pull request review']);
    expect(result?.title).toBe('agentic infrastructure provisioning');
  });
});

// ---------------------------------------------------------------------------
// synthesizeDraft() / isGrounded() / openPullRequest()
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

    const { draft, neurons } = await synthesizeDraft(aiEnv, 'run-test', topic(), summaries);

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

    const { draft } = await synthesizeDraft(aiEnv, 'run-test', topic(), summaries);

    expect(draft.brief).toContain('https://example.com/a');
    expect(draft.brief).toContain('https://example.com/b');
    expect(draft.brief).toContain('Article A');
    expect(draft.brief).toContain('Article B');
  });

  it('falls back to a topic-id slug when the title has no usable characters', async () => {
    const aiEnv = envWithAi(chatFixture(JSON.stringify({ title: '!!!', description: 'd', tags: [], body: 'b' })));
    const { draft } = await synthesizeDraft(aiEnv, 'run-test', topic({ id: 42 }), summaries);
    expect(draft.slug).toBe('research-topic-42');
  });

  it('throws when the completion was truncated (finish_reason: length) rather than committing a truncated draft', async () => {
    const aiEnv = envWithAi(chatFixture('{"title": "cut off h', 'length'));
    await expect(synthesizeDraft(aiEnv, 'run-test', topic(), summaries)).rejects.toThrow(/truncat/i);
  });

  it('throws when the model response is not valid JSON in the expected shape', async () => {
    const aiEnv = envWithAi(chatFixture('not json at all'));
    await expect(synthesizeDraft(aiEnv, 'run-test', topic(), summaries)).rejects.toThrow();
  });

  it('names the specific parse failure reason and response length, and never the response text itself', async () => {
    const secretDescription = 'THIS SHOULD NEVER APPEAR IN AN ERROR MESSAGE';
    const responseText = JSON.stringify({ title: 't', description: secretDescription, tags: [], body: '   ' });
    const aiEnv = envWithAi(chatFixture(responseText));

    let caught: Error | undefined;
    try {
      await synthesizeDraft(aiEnv, 'run-test', topic(), summaries);
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

/**
 * `run()`'s own orchestration, which no per-function test can see: the fake
 * `step` records the order steps and sleeps are requested in and returns a
 * canned output for each step **without running its body**, the same device
 * `recordingStep` in test/trace.test.ts uses. Nothing here touches D1, the
 * model or GitHub - the assertion is about the sequence `run()` asks for.
 */
function orchestrationStep(outputs: Record<string, unknown>, liveNames: string[] = []): { step: WorkflowStep; calls: string[] } {
  const calls: string[] = [];
  const live = new Set(liveNames);
  const step = {
    do(name: string, _config: unknown, callback?: unknown) {
      calls.push(name);
      // A named step whose body is allowed to run for real, against the
      // pool's own D1 - the only way to see what a step *wrote* rather than
      // what `run()` asked for.
      if (live.has(name) && typeof callback === 'function') return (callback as () => Promise<unknown>)();
      if (!(name in outputs)) return Promise.reject(new Error(`orchestrationStep: no canned output for step ${name}`));
      const canned = outputs[name];
      // A canned `Error` stands in for a step that throws - which is how a
      // failed child reaches `run()` (spec.md requirement 4).
      return canned instanceof Error ? Promise.reject(canned) : Promise.resolve(canned);
    },
    sleep(name: string, _duration: unknown) {
      calls.push(name);
      return Promise.resolve(undefined);
    },
  } as unknown as WorkflowStep;
  return { step, calls };
}

async function runOrchestration(overrides: Record<string, unknown> = {}, liveNames: string[] = []): Promise<string[]> {
  const outputs: Record<string, unknown> = {
    'start-run': null,
    'select-topic': topic(),
    'load-sources': [] as Source[],
    'create-gather-children': ['child-g0', 'child-g1'],
    'await-gather-children:0': { done: true, total: 7 },
    // Two of each, because `MIN_SOURCES` and `isGrounded` gate the paths
    // between the two poll loops; the values themselves are never read by a
    // step body here. Left as the helpers' defaults so this block adds no
    // `no-hardcoded-urls` warnings, the same reason test/trace.test.ts drops
    // a scheme from its step name.
    shortlist: [candidate(), candidate()],
    'create-summarize-children': ['child-s0'],
    'await-summarize-children:0': { done: true, summaries: [summary(), summary()], neuronsSpent: 11 },
    synthesize: { draft: {} as Draft, neurons: 22 },
    'create-publish-children': ['child-p0'],
    'await-publish-children:0': { done: true, prUrl: PR_URL },
    'record-success': null,
    ...overrides,
  };
  const { step, calls } = orchestrationStep(outputs, liveNames);
  const event = {
    instanceId: 'parent-orchestration',
    workflowName: 'research-workflow',
    payload: {} as ResearchParams,
  } as unknown as WorkflowEvent<ResearchParams>;

  // `WorkflowEntrypoint`'s constructor accepts only a real runtime
  // `ExecutionContext`, which `cloudflare:test` cannot hand out, so the
  // instance is built off the prototype instead and given the one thing
  // `run()` reads from `this`.
  const workflow = Object.create(ResearchWorkflow.prototype) as ResearchWorkflow;
  Object.defineProperty(workflow, 'env', { value: env });

  await workflow.run(event, step);
  return calls;
}

describe('ResearchWorkflow.run() poll ordering', () => {
  // The whole point of the change: round 0 used to fire ~1 s after
  // `createBatch` and could only ever return `{ done: false }`, at one
  // subrequest per child (run `0357f119`: 5 wasted for gather, 3 for
  // summarize). Asserted as adjacency, not as "a sleep happens somewhere",
  // which the old poll-then-sleep order would also satisfy.
  it('sleeps before the first poll of each child batch, not after it', async () => {
    const calls = await runOrchestration();

    expect(calls.indexOf('await-gather-children-wait:0')).toBe(calls.indexOf('await-gather-children:0') - 1);
    expect(calls.indexOf('await-summarize-children-wait:0')).toBe(calls.indexOf('await-summarize-children:0') - 1);
    expect(calls.indexOf('await-publish-children-wait:0')).toBe(calls.indexOf('await-publish-children:0') - 1);
    expect(calls.indexOf('create-gather-children')).toBe(calls.indexOf('await-gather-children-wait:0') - 1);
  });

  it('pairs every later round with its own preceding sleep', async () => {
    const calls = await runOrchestration({
      'await-gather-children:0': { done: false, state: { pending: ['child-g1'], outputs: { 'child-g0': 3 } } },
      'await-gather-children:1': { done: true, total: 7 },
    });

    expect(calls.slice(calls.indexOf('create-gather-children'), calls.indexOf('shortlist'))).toEqual([
      'create-gather-children',
      'await-gather-children-wait:0',
      'await-gather-children:0',
      'await-gather-children-wait:1',
      'await-gather-children:1',
    ]);
  });
});

describe('ResearchWorkflow.run() publication in a child instance', () => {
  /**
   * spec.md requirement 2's third extension: the parent no longer opens the
   * pull request itself, so `open-pull-request` must not appear among its
   * steps at all - it is the child's step name now
   * (test/publish-workflow.test.ts asserts that side). Asserted as absence
   * rather than as "create-publish-children exists", because a parent that
   * created the child *and* kept its own GitHub calls would satisfy the
   * latter and spend the seven subrequests this PR exists to move.
   */
  it('creates the child instead of opening the pull request itself, and records the URL it returns afterwards', async () => {
    const calls = await runOrchestration();

    expect(calls).not.toContain('open-pull-request');
    expect(calls.slice(calls.indexOf('synthesize'))).toEqual([
      'synthesize',
      'create-publish-children',
      'await-publish-children-wait:0',
      'await-publish-children:0',
      'record-success',
    ]);
  });

  it('polls a second publish round when the first finds the child still running', async () => {
    const calls = await runOrchestration({
      'await-publish-children:0': { done: false, state: { pending: ['child-p0'], outputs: {} } },
      'await-publish-children:1': { done: true, prUrl: PR_URL },
    });

    expect(calls.slice(calls.indexOf('create-publish-children'))).toEqual([
      'create-publish-children',
      'await-publish-children-wait:0',
      'await-publish-children:0',
      'await-publish-children-wait:1',
      'await-publish-children:1',
      'record-success',
    ]);
  });

  // spec.md requirement 4 at the run level: a poll step that throws is a step
  // that fails the run, and `record-success` is never reached - so no `runs`
  // row can claim success without a pull request behind it.
  it('a failed publish child fails the run, and record-success never runs', async () => {
    const failure = new Error('publish child child-p0 errored');
    await expect(
      runOrchestration({
        'await-publish-children:0': failure,
      }),
    ).rejects.toThrow('publish child child-p0 errored');
  });

  /**
   * The one thing the parent still owns. `record-success`'s body runs for real
   * here - against the pool's D1, not a canned result - because the point is
   * that the `pr_url` the child returned is what lands in the `runs` row.
   */
  it('writes the child-returned pr_url into the runs row', async () => {
    await env.DB.prepare("INSERT INTO topics (id, title, status, origin) VALUES (1, 't', 'in_progress', 'human')").run();

    await runOrchestration({}, ['record-success']);

    const row = await env.DB.prepare('SELECT status, pr_url FROM runs WHERE instance_id = ?')
      .bind('parent-orchestration')
      .first<{ status: string; pr_url: string | null }>();
    expect(row?.status).toBe('succeeded');
    expect(row?.pr_url).toBe(PR_URL);
  });
});
