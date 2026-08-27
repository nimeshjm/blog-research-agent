import { env as testEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  attachRunTopic,
  claimOldestQueuedTopic,
  claimTopicById,
  findOrProposeTopic,
  findSeenUrls,
  pruneRunCandidates,
  reclaimStaleTopics,
  readRunCandidates,
  recordRunOutcome,
  SEEN_URLS_CHUNK_SIZE,
  startRun,
  writeRunCandidates,
} from '../src/lib/d1';
import type { Candidate, Env } from '../src/lib/types';
import { applySchema } from './schema';

// `cloudflare:test`'s `env` types as the global (project-unaware) `Cloudflare.Env`
// - this repo has no generated worker-configuration.d.ts (no `wrangler types` run),
// so the real `DB` binding is cast to this project's own `Env` here.
const env = testEnv as unknown as Env;

/**
 * `env.DB` is the real D1 binding from wrangler.toml, run under Miniflare -
 * per CLAUDE.md, this is what proves the `seen_urls` chunking arithmetic
 * against the actual 100-bound-parameter limit rather than a mock. Schema
 * setup itself lives in `./schema.ts`, shared with test/workflow.test.ts.
 */
async function resetSchema(): Promise<void> {
  for (const table of ['drafts', 'runs', 'run_candidates', 'seen_urls', 'topics']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(async () => {
  await applySchema(env.DB);
  await resetSchema();
});

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    url: 'https://example.com/x',
    title: 'A candidate title',
    publishedAt: '2026-08-20T00:00:00Z',
    publishedMs: Date.parse('2026-08-20T00:00:00Z'),
    sourceName: 'Test Source',
    ...overrides,
  };
}

describe('claimOldestQueuedTopic()', () => {
  it('claims the oldest queued row and transitions it to in_progress', async () => {
    await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin, created_at) VALUES (?, ?, 'queued', 'human', ?)`,
    )
      .bind('older', null, '2026-08-01T00:00:00Z')
      .run();
    await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin, created_at) VALUES (?, ?, 'queued', 'human', ?)`,
    )
      .bind('newer', null, '2026-08-20T00:00:00Z')
      .run();

    const claimed = await claimOldestQueuedTopic(env.DB);

    expect(claimed?.title).toBe('older');
    expect(claimed?.status).toBe('in_progress');

    const row = await env.DB.prepare('SELECT status FROM topics WHERE title = ?').bind('older').first<{
      status: string;
    }>();
    expect(row?.status).toBe('in_progress');
  });

  it('returns null when the queue is empty', async () => {
    expect(await claimOldestQueuedTopic(env.DB)).toBeNull();
  });

  it('a second call finds nothing once the only queued row is claimed', async () => {
    // Once claimed, the row is no longer `queued`, so a fresh top-level call
    // correctly reports an empty queue rather than reaching for a second
    // topic - draining the queue does not skip rows a run has already taken.
    await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('only', NULL, 'queued', 'human')`,
    ).run();

    const first = await claimOldestQueuedTopic(env.DB);
    const second = await claimOldestQueuedTopic(env.DB);

    expect(first?.status).toBe('in_progress');
    expect(second).toBeNull();
  });

  it('stamps claimed_at when claiming a queued row', async () => {
    await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('stampable', NULL, 'queued', 'human')`,
    ).run();

    await claimOldestQueuedTopic(env.DB);

    const row = await env.DB.prepare(`SELECT claimed_at FROM topics WHERE title = 'stampable'`).first<{
      claimed_at: string | null;
    }>();
    expect(row?.claimed_at).not.toBeNull();
  });
});

describe('claimTopicById()', () => {
  it('claims a specific queued row regardless of age', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('targeted', NULL, 'queued', 'human') RETURNING id`,
    ).first<{ id: number }>();
    const id = insert?.id;
    expect(id).toBeDefined();

    const claimed = await claimTopicById(env.DB, id as number);
    expect(claimed?.title).toBe('targeted');
    expect(claimed?.status).toBe('in_progress');
  });

  it('returns null for a non-existent id', async () => {
    expect(await claimTopicById(env.DB, 999_999)).toBeNull();
  });

  it('returns null for a topic that is already done', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('finished', NULL, 'done', 'human') RETURNING id`,
    ).first<{ id: number }>();
    expect(await claimTopicById(env.DB, insert?.id as number)).toBeNull();
  });

  it('called twice with the same id recovers the same row instead of erroring (idempotent replay)', async () => {
    // The scenario `plan.md` names: a retried `select-topic` step re-runs its
    // whole body from scratch. When the run was started with a specific
    // topicId (ResearchParams.topicId), the retry calls claimTopicById with
    // that same id again - it must recover the row an earlier attempt's
    // UPDATE already committed, not error or silently no-op on it.
    const insert = await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('retried', NULL, 'queued', 'human') RETURNING id`,
    ).first<{ id: number }>();
    const id = insert?.id as number;

    const first = await claimTopicById(env.DB, id);
    const second = await claimTopicById(env.DB, id);

    expect(first?.status).toBe('in_progress');
    expect(second?.id).toBe(first?.id);
    expect(second?.status).toBe('in_progress');
  });

  it('does not re-stamp claimed_at on the already-in_progress recovery path', async () => {
    // claimRow's early return for an already-in_progress row must not extend
    // the TTL of a claim it did not make - backdated first so a re-stamp
    // would be visible.
    const insert = await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin, claimed_at)
       VALUES ('recovered', NULL, 'in_progress', 'human', datetime('now', '-2 hours')) RETURNING id`,
    ).first<{ id: number }>();
    const id = insert?.id as number;

    const before = await env.DB.prepare('SELECT claimed_at FROM topics WHERE id = ?').bind(id).first<{
      claimed_at: string;
    }>();

    await claimTopicById(env.DB, id);

    const after = await env.DB.prepare('SELECT claimed_at FROM topics WHERE id = ?').bind(id).first<{
      claimed_at: string;
    }>();
    expect(after?.claimed_at).toBe(before?.claimed_at);
  });
});

describe('findSeenUrls()', () => {
  it('issues ceil(n/100) chunked queries for n distinct URLs', async () => {
    const urlCount = 2.5 * SEEN_URLS_CHUNK_SIZE; // 250 - not a multiple of the chunk size
    const urls = Array.from({ length: urlCount }, (_, i) => `https://example.com/article-${i}`);

    let queryCount = 0;
    const countingDb = {
      prepare: (sql: string) => {
        queryCount++;
        return env.DB.prepare(sql);
      },
    } as D1Database;

    await findSeenUrls(countingDb, urls);

    expect(queryCount).toBe(Math.ceil(urlCount / SEEN_URLS_CHUNK_SIZE));
  });

  it('returns exactly the URLs already present in seen_urls, across a chunk boundary', async () => {
    const total = SEEN_URLS_CHUNK_SIZE + 5; // spans two chunks
    const urls = Array.from({ length: total }, (_, i) => `https://example.com/post-${i}`);

    // Mark every 10th URL as seen, including at least one past the first chunk.
    const seenUrls = urls.filter((_, i) => i % 10 === 0);
    for (const url of seenUrls) {
      await env.DB.prepare(`INSERT INTO seen_urls (url, source) VALUES (?, 'test')`).bind(url).run();
    }

    const seen = await findSeenUrls(env.DB, urls);

    expect(seen.size).toBe(seenUrls.length);
    for (const url of seenUrls) expect(seen.has(url)).toBe(true);
  });

  it('dedupes the input before chunking', async () => {
    const urls = Array.from({ length: SEEN_URLS_CHUNK_SIZE + 1 }, () => 'https://example.com/same');

    let queryCount = 0;
    const countingDb = {
      prepare: (sql: string) => {
        queryCount++;
        return env.DB.prepare(sql);
      },
    } as D1Database;

    await findSeenUrls(countingDb, urls);

    expect(queryCount).toBe(1); // one distinct URL, not ceil(101/100) = 2
  });

  it('returns an empty set for an empty input with no query', async () => {
    let queryCount = 0;
    const countingDb = {
      prepare: (sql: string) => {
        queryCount++;
        return env.DB.prepare(sql);
      },
    } as D1Database;

    const seen = await findSeenUrls(countingDb, []);

    expect(seen.size).toBe(0);
    expect(queryCount).toBe(0);
  });

  it('throws rather than truncating when the input needs more than 50 chunks', async () => {
    const urls = Array.from({ length: SEEN_URLS_CHUNK_SIZE * 51 }, (_, i) => `https://example.com/x-${i}`);
    await expect(findSeenUrls(env.DB, urls)).rejects.toThrow(/50-query/);
  });
});

describe('findOrProposeTopic()', () => {
  it('inserts a new agent-origin row, already in_progress', async () => {
    const topic = await findOrProposeTopic(env.DB, { title: 'Proposed title', angle: 'An angle' });

    expect(topic.title).toBe('Proposed title');
    expect(topic.origin).toBe('agent');
    expect(topic.status).toBe('in_progress');

    const row = await env.DB.prepare(`SELECT status, origin FROM topics WHERE title = ?`).bind('Proposed title').first<{
      status: string;
      origin: string;
    }>();
    expect(row?.status).toBe('in_progress');
    expect(row?.origin).toBe('agent');
  });

  it('called twice with the same title recovers the same row instead of inserting a second one (idempotent replay)', async () => {
    const first = await findOrProposeTopic(env.DB, { title: 'Retried proposal', angle: null });
    const second = await findOrProposeTopic(env.DB, { title: 'Retried proposal', angle: null });

    expect(second.id).toBe(first.id);

    const rows = await env.DB.prepare(`SELECT COUNT(*) as n FROM topics WHERE title = ?`).bind('Retried proposal').first<{
      n: number;
    }>();
    expect(rows?.n).toBe(1);
  });

  it('a human-origin topic with the same title does not shadow the agent proposal', async () => {
    await env.DB.prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('Same title', NULL, 'queued', 'human')`).run();

    const proposed = await findOrProposeTopic(env.DB, { title: 'Same title', angle: null });

    expect(proposed.origin).toBe('agent');
    const rows = await env.DB.prepare(`SELECT COUNT(*) as n FROM topics WHERE title = 'Same title'`).first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });
});

describe('recordRunOutcome()', () => {
  it('called twice with the same instance id leaves exactly one row', async () => {
    const topic = await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('t', NULL, 'in_progress', 'human') RETURNING id`,
    ).first<{ id: number }>();

    await recordRunOutcome(env.DB, {
      instanceId: 'run-1',
      topicId: null,
      status: 'no_topic',
      neuronsSpent: 0,
      sourcesUsed: 0,
      prUrl: null,
    });
    await recordRunOutcome(env.DB, {
      instanceId: 'run-1',
      topicId: topic?.id ?? null,
      status: 'succeeded',
      neuronsSpent: 4132,
      sourcesUsed: 3,
      prUrl: 'https://github.com/nimeshjm/nimeshjm.com/pull/1',
    });

    const rows = await env.DB.prepare('SELECT * FROM runs WHERE instance_id = ?').bind('run-1').all<{
      status: string;
      neurons_spent: number;
      pr_url: string | null;
    }>();

    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.status).toBe('succeeded');
    expect(rows.results[0]?.neurons_spent).toBe(4132);
    expect(rows.results[0]?.pr_url).toBe('https://github.com/nimeshjm/nimeshjm.com/pull/1');
  });

  it('two different instance ids leave two rows', async () => {
    await recordRunOutcome(env.DB, {
      instanceId: 'run-a',
      topicId: null,
      status: 'no_topic',
      neuronsSpent: 0,
      sourcesUsed: 0,
      prUrl: null,
    });
    await recordRunOutcome(env.DB, {
      instanceId: 'run-b',
      topicId: null,
      status: 'no_topic',
      neuronsSpent: 0,
      sourcesUsed: 0,
      prUrl: null,
    });

    const rows = await env.DB.prepare('SELECT COUNT(*) as n FROM runs').first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });
});

describe('writeRunCandidates()', () => {
  it('writes rows readable back with published_ms round-tripped as a number, null staying null', async () => {
    const count = await writeRunCandidates(env.DB, 'run-1', 'Source A', [
      candidate({ url: 'https://example.com/a', publishedMs: 1000 }),
      candidate({ url: 'https://example.com/b', publishedAt: null, publishedMs: null }),
    ]);
    expect(count).toBe(2);

    const rows = await env.DB
      .prepare('SELECT url, published_ms FROM run_candidates WHERE run_id = ? ORDER BY url')
      .bind('run-1')
      .all<{ url: string; published_ms: number | null }>();
    expect(rows.results).toEqual([
      { url: 'https://example.com/a', published_ms: 1000 },
      { url: 'https://example.com/b', published_ms: null },
    ]);
  });

  it('a re-run with the same (runId, sourceName) leaves the row count unchanged (req. 7 / criterion 8)', async () => {
    const candidates = [candidate({ url: 'https://example.com/a' }), candidate({ url: 'https://example.com/b' })];
    await writeRunCandidates(env.DB, 'run-1', 'Source A', candidates);
    await writeRunCandidates(env.DB, 'run-1', 'Source A', candidates);

    const rows = await env.DB
      .prepare('SELECT COUNT(*) as n FROM run_candidates WHERE run_id = ?')
      .bind('run-1')
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it('a re-run whose feed lost an item does not leave the vanished row behind', async () => {
    await writeRunCandidates(env.DB, 'run-1', 'Source A', [
      candidate({ url: 'https://example.com/a' }),
      candidate({ url: 'https://example.com/b' }),
    ]);
    await writeRunCandidates(env.DB, 'run-1', 'Source A', [candidate({ url: 'https://example.com/a' })]);

    const rows = await env.DB
      .prepare('SELECT url FROM run_candidates WHERE run_id = ?')
      .bind('run-1')
      .all<{ url: string }>();
    expect(rows.results.map((r) => r.url)).toEqual(['https://example.com/a']);
  });

  it("a second source's rows are not deleted by the first source's re-run", async () => {
    // The whole reason the DELETE is scoped to (run_id, source_name): a
    // run_id-wide delete here would wipe Source B's row too.
    await writeRunCandidates(env.DB, 'run-1', 'Source A', [candidate({ url: 'https://example.com/a' })]);
    await writeRunCandidates(env.DB, 'run-1', 'Source B', [candidate({ url: 'https://example.com/b' })]);
    await writeRunCandidates(env.DB, 'run-1', 'Source A', [candidate({ url: 'https://example.com/a' })]);

    const rows = await env.DB
      .prepare('SELECT url FROM run_candidates WHERE run_id = ? ORDER BY url')
      .bind('run-1')
      .all<{ url: string }>();
    expect(rows.results.map((r) => r.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it("empty candidates returns 0 and still clears that source's rows", async () => {
    await writeRunCandidates(env.DB, 'run-1', 'Source A', [candidate({ url: 'https://example.com/a' })]);
    const count = await writeRunCandidates(env.DB, 'run-1', 'Source A', []);
    expect(count).toBe(0);

    const rows = await env.DB
      .prepare('SELECT COUNT(*) as n FROM run_candidates WHERE run_id = ?')
      .bind('run-1')
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe('readRunCandidates()', () => {
  it('orders dated rows newest-first, with undated rows after all dated ones', async () => {
    await writeRunCandidates(env.DB, 'run-1', 'Source A', [
      candidate({ url: 'https://example.com/older', publishedMs: 1000 }),
      candidate({ url: 'https://example.com/newer', publishedMs: 2000 }),
      candidate({ url: 'https://example.com/undated', publishedAt: null, publishedMs: null }),
    ]);

    const result = await readRunCandidates(env.DB, 'run-1', 10);
    expect(result.map((c) => c.url)).toEqual([
      'https://example.com/newer',
      'https://example.com/older',
      'https://example.com/undated',
    ]);
  });

  it('limit truncates from the end of that order', async () => {
    await writeRunCandidates(env.DB, 'run-1', 'Source A', [
      candidate({ url: 'https://example.com/a', publishedMs: 3000 }),
      candidate({ url: 'https://example.com/b', publishedMs: 2000 }),
      candidate({ url: 'https://example.com/c', publishedMs: 1000 }),
    ]);

    const result = await readRunCandidates(env.DB, 'run-1', 2);
    expect(result.map((c) => c.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('does not return rows for another run_id', async () => {
    await writeRunCandidates(env.DB, 'run-1', 'Source A', [candidate({ url: 'https://example.com/a' })]);
    await writeRunCandidates(env.DB, 'run-2', 'Source A', [candidate({ url: 'https://example.com/b' })]);

    const result = await readRunCandidates(env.DB, 'run-1', 10);
    expect(result.map((c) => c.url)).toEqual(['https://example.com/a']);
  });
});

describe('pruneRunCandidates()', () => {
  it('deletes a row older than the retention window and keeps a fresh one', async () => {
    await writeRunCandidates(env.DB, 'run-old', 'Source A', [candidate({ url: 'https://example.com/old' })]);
    await writeRunCandidates(env.DB, 'run-fresh', 'Source A', [candidate({ url: 'https://example.com/fresh' })]);
    await env.DB
      .prepare(`UPDATE run_candidates SET created_at = datetime('now', '-30 days') WHERE run_id = 'run-old'`)
      .run();

    await pruneRunCandidates(env.DB, 7);

    const rows = await env.DB.prepare('SELECT run_id FROM run_candidates').all<{ run_id: string }>();
    expect(rows.results.map((r) => r.run_id)).toEqual(['run-fresh']);
  });
});

describe('startRun()', () => {
  it('inserts a running row', async () => {
    await startRun(env.DB, 'run-1');

    const row = await env.DB.prepare('SELECT status FROM runs WHERE instance_id = ?').bind('run-1').first<{
      status: string;
    }>();
    expect(row?.status).toBe('running');
  });

  it('called twice leaves one row', async () => {
    await startRun(env.DB, 'run-1');
    await startRun(env.DB, 'run-1');

    const row = await env.DB.prepare('SELECT COUNT(*) as n FROM runs WHERE instance_id = ?').bind('run-1').first<{
      n: number;
    }>();
    expect(row?.n).toBe(1);
  });

  it('called after recordRunOutcome wrote a terminal status does not reset it to running', async () => {
    await recordRunOutcome(env.DB, {
      instanceId: 'run-1',
      topicId: null,
      status: 'succeeded',
      neuronsSpent: 100,
      sourcesUsed: 3,
      prUrl: null,
    });

    await startRun(env.DB, 'run-1');

    const row = await env.DB.prepare('SELECT status FROM runs WHERE instance_id = ?').bind('run-1').first<{
      status: string;
    }>();
    expect(row?.status).toBe('succeeded');
  });
});

describe('attachRunTopic()', () => {
  it('sets topic_id on the existing run row', async () => {
    const topic = await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('t', NULL, 'in_progress', 'human') RETURNING id`,
    ).first<{ id: number }>();
    await startRun(env.DB, 'run-1');

    await attachRunTopic(env.DB, 'run-1', topic?.id as number);

    const row = await env.DB.prepare('SELECT topic_id FROM runs WHERE instance_id = ?').bind('run-1').first<{
      topic_id: number;
    }>();
    expect(row?.topic_id).toBe(topic?.id);
  });
});

describe('reclaimStaleTopics()', () => {
  it('returns a stale in_progress topic to queued, clears claimed_at, and counts it', async () => {
    const insert = await env.DB
      .prepare(
        `INSERT INTO topics (title, angle, status, origin, claimed_at)
         VALUES ('stale', NULL, 'in_progress', 'human', datetime('now', '-7 hours')) RETURNING id`,
      )
      .first<{ id: number }>();

    const changed = await reclaimStaleTopics(env.DB, 6);
    expect(changed).toBe(1);

    const row = await env.DB.prepare('SELECT status, claimed_at FROM topics WHERE id = ?').bind(insert?.id).first<{
      status: string;
      claimed_at: string | null;
    }>();
    expect(row?.status).toBe('queued');
    expect(row?.claimed_at).toBeNull();
  });

  it('leaves a topic claimed within the TTL untouched', async () => {
    const insert = await env.DB
      .prepare(
        `INSERT INTO topics (title, angle, status, origin, claimed_at)
         VALUES ('live', NULL, 'in_progress', 'human', datetime('now')) RETURNING id`,
      )
      .first<{ id: number }>();

    const changed = await reclaimStaleTopics(env.DB, 6);
    expect(changed).toBe(0);

    const row = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(insert?.id).first<{
      status: string;
    }>();
    expect(row?.status).toBe('in_progress');
  });

  it('leaves a row with claimed_at IS NULL alone (a pre-migration claim, not guessed at)', async () => {
    const insert = await env.DB
      .prepare(
        `INSERT INTO topics (title, angle, status, origin) VALUES ('pre-migration', NULL, 'in_progress', 'human') RETURNING id`,
      )
      .first<{ id: number }>();

    const changed = await reclaimStaleTopics(env.DB, 6);
    expect(changed).toBe(0);

    const row = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(insert?.id).first<{
      status: string;
    }>();
    expect(row?.status).toBe('in_progress');
  });
});
