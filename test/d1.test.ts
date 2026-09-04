import { env as testEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  attachRunTopic,
  claimRow,
  claimTopicById,
  findOrProposeTopic,
  findSeenUrls,
  pruneRunCandidates,
  reclaimAndClaim,
  readRunCandidates,
  readSourceWeights,
  recordRunOutcome,
  recordRunSpend,
  recordSeenPruneAndCloseTopic,
  SEEN_URLS_CHUNK_SIZE,
  startRun,
  TOPIC_DEDUPE_TITLE_LIMIT,
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

/**
 * `reclaimAndClaim` + `claimRow` is the pairing `selectTopic`'s
 * queue-draining path now runs in production (#91): `reclaimAndClaim`'s own
 * `SELECT` finds the oldest `queued` row, and `claimRow` - exported for
 * exactly this - is the caller's next, separate call to actually claim it.
 * This describe covers what `claimOldestQueuedTopic()`'s suite covered
 * before that function was deleted as a dead export duplicating
 * `reclaimAndClaim`'s SQL: the pairing's ordering, its idempotent-drain
 * behaviour, and `claimRow`'s own `claimed_at` stamp.
 */
describe('reclaimAndClaim() + claimRow() (queue draining)', () => {
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

    const { row } = await reclaimAndClaim(env.DB, 6, 'test-instance');
    const claimed = row === null ? null : await claimRow(env.DB, row);

    expect(claimed?.title).toBe('older');
    expect(claimed?.status).toBe('in_progress');

    const persisted = await env.DB.prepare('SELECT status FROM topics WHERE title = ?').bind('older').first<{
      status: string;
    }>();
    expect(persisted?.status).toBe('in_progress');
  });

  it('a second call finds nothing once the only queued row is claimed', async () => {
    // Once claimed, the row is no longer `queued`, so a fresh top-level call
    // correctly reports an empty queue rather than reaching for a second
    // topic - draining the queue does not skip rows a run has already taken.
    await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('only', NULL, 'queued', 'human')`,
    ).run();

    const first = await reclaimAndClaim(env.DB, 6, 'test-instance');
    const firstClaimed = first.row === null ? null : await claimRow(env.DB, first.row);
    const second = await reclaimAndClaim(env.DB, 6, 'test-instance');

    expect(firstClaimed?.status).toBe('in_progress');
    expect(second.row).toBeNull();
  });

  it("stamps claimRow's own claimed_at when claiming a queued row", async () => {
    await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('stampable', NULL, 'queued', 'human')`,
    ).run();

    const { row } = await reclaimAndClaim(env.DB, 6, 'test-instance');
    if (row !== null) await claimRow(env.DB, row);

    const persisted = await env.DB.prepare(`SELECT claimed_at FROM topics WHERE title = 'stampable'`).first<{
      claimed_at: string | null;
    }>();
    expect(persisted?.claimed_at).not.toBeNull();
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

describe('readSourceWeights()', () => {
  it('averages per distinct run, not per row: a feed seen in many runs does not outweigh a bigger one seen in few', async () => {
    // Small feed, 2 items in each of three runs. Big feed, 30 items in one.
    for (const run of ['run-1', 'run-2', 'run-3']) {
      await writeRunCandidates(env.DB, run, 'Small', [
        candidate({ url: `https://example.com/${run}/s1` }),
        candidate({ url: `https://example.com/${run}/s2` }),
      ]);
    }
    await writeRunCandidates(
      env.DB,
      'run-1',
      'Big',
      Array.from({ length: 30 }, (_, i) => candidate({ url: `https://example.com/big/${i}` })),
    );

    const weights = await readSourceWeights(env.DB, 'run-now');

    expect(weights.get('Small')).toBe(2);
    expect(weights.get('Big')).toBe(30);
  });

  it("excludes the current run's own rows, so a replay computes the same weights the first pass did", async () => {
    await writeRunCandidates(env.DB, 'run-history', 'Feed A', [candidate({ url: 'https://example.com/h1' })]);
    // What this run's own children have written so far. Counting these would
    // make the weights - and so the chunks - depend on how far the run got.
    await writeRunCandidates(
      env.DB,
      'run-now',
      'Feed A',
      Array.from({ length: 40 }, (_, i) => candidate({ url: `https://example.com/now/${i}` })),
    );

    const weights = await readSourceWeights(env.DB, 'run-now');

    expect(weights.get('Feed A')).toBe(1);
  });

  it('returns no entry for a source with no history, rather than inventing a zero', async () => {
    await writeRunCandidates(env.DB, 'run-1', 'Feed A', [candidate({ url: 'https://example.com/a' })]);

    const weights = await readSourceWeights(env.DB, 'run-now');

    expect(weights.has('Feed B')).toBe(false);
  });

  it('empty history is an empty map, not a throw', async () => {
    expect(await readSourceWeights(env.DB, 'run-now')).toEqual(new Map());
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

describe('recordSeenPruneAndCloseTopic()', () => {
  // The actual writer this PR adds (spec.md req. 4, #100): findSeenUrls only
  // ever reads seen_urls, and until this function existed nothing in src/
  // ever inserted into it - only test fixtures did, by hand, which is why
  // the dedupe filter had passing tests while being inert in production.
  it('inserts every candidate passed as seen into seen_urls', async () => {
    await recordSeenPruneAndCloseTopic(
      env.DB,
      7,
      [
        candidate({ url: 'https://example.com/a', title: 'A', sourceName: 'Source A' }),
        candidate({ url: 'https://example.com/b', title: 'B', sourceName: 'Source B' }),
      ],
      null,
    );

    const rows = await env.DB.prepare('SELECT url, title, source FROM seen_urls ORDER BY url').all<{
      url: string;
      title: string;
      source: string;
    }>();
    expect(rows.results).toEqual([
      { url: 'https://example.com/a', title: 'A', source: 'Source A' },
      { url: 'https://example.com/b', title: 'B', source: 'Source B' },
    ]);
  });

  it('is idempotent under a replayed insert of the same URL (ON CONFLICT DO NOTHING)', async () => {
    await recordSeenPruneAndCloseTopic(env.DB, 7, [candidate({ url: 'https://example.com/a', title: 'first' })], null);
    // A second attempt, as `run()`'s top-of-function replay (spec.md fact 2)
    // would produce - same URL, and here a different title, to prove the
    // original row is kept rather than overwritten or duplicated.
    await recordSeenPruneAndCloseTopic(env.DB, 7, [candidate({ url: 'https://example.com/a', title: 'replayed' })], null);

    const rows = await env.DB.prepare('SELECT url, title FROM seen_urls WHERE url = ?')
      .bind('https://example.com/a')
      .all<{ url: string; title: string }>();
    expect(rows.results).toEqual([{ url: 'https://example.com/a', title: 'first' }]);
  });

  it('writes nothing to seen_urls for an empty seen list, and still prunes', async () => {
    await writeRunCandidates(env.DB, 'run-old', 'Source A', [candidate({ url: 'https://example.com/old' })]);
    await env.DB.prepare(`UPDATE run_candidates SET created_at = datetime('now', '-30 days')`).run();

    await recordSeenPruneAndCloseTopic(env.DB, 7, [], null);

    const seen = await env.DB.prepare('SELECT COUNT(*) AS n FROM seen_urls').first<{ n: number }>();
    expect(seen?.n).toBe(0);
    const candidates = await env.DB.prepare('SELECT COUNT(*) AS n FROM run_candidates').first<{ n: number }>();
    expect(candidates?.n).toBe(0);
  });

  it('costs exactly one subrequest (one db.batch() call), whether or not a topic is closed', async () => {
    // `db.prepare()` builds a statement object without talking to D1 - the
    // subrequest is the terminal call (`.batch()`, `.run()`, `.all()`,
    // `.first()`), so only `batch` is counted here, not `prepare`
    // (`createPublishChildren`'s comment, src/workflow.ts, is what this
    // function's own doc comment says the count must not disturb).
    let batchCount = 0;
    const countingDb = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: (statements: Parameters<D1Database['batch']>[0]) => {
        batchCount++;
        return env.DB.batch(statements);
      },
    } as D1Database;

    await recordSeenPruneAndCloseTopic(countingDb, 7, [candidate({ url: 'https://example.com/a' })], null);
    // #108: the third statement (the topic-close UPDATE) must still ride the
    // same batch, not spend a second subrequest - this is the arithmetic
    // `createPublishChildren`'s comment (src/workflow.ts) depends on staying
    // true.
    await recordSeenPruneAndCloseTopic(countingDb, 7, [candidate({ url: 'https://example.com/b' })], {
      id: 1,
      status: 'done',
    });

    expect(batchCount).toBe(2);
  });

  // #108: nothing ever closed a topic, so a run that succeeded left it
  // `in_progress` forever - indistinguishable from a run that died mid-step,
  // and reclaimed by the TTL sweep exactly as if it had.
  describe('closing a topic', () => {
    async function insertTopic(status: string, claimedAt: string | null = "datetime('now')"): Promise<number> {
      const claimedAtSql = claimedAt === null ? 'NULL' : claimedAt;
      const row = await env.DB.prepare(
        `INSERT INTO topics (title, angle, status, origin, claimed_at) VALUES ('t', NULL, ?, 'human', ${claimedAtSql}) RETURNING id`,
      )
        .bind(status)
        .first<{ id: number }>();
      return row?.id as number;
    }

    it('closes an in_progress topic to done', async () => {
      const id = await insertTopic('in_progress');

      await recordSeenPruneAndCloseTopic(env.DB, 7, [], { id, status: 'done' });

      const row = await env.DB.prepare('SELECT status, claimed_at FROM topics WHERE id = ?').bind(id).first<{
        status: string;
        claimed_at: string | null;
      }>();
      expect(row?.status).toBe('done');
      expect(row?.claimed_at).toBeNull();
    });

    it('closes an in_progress topic to rejected', async () => {
      const id = await insertTopic('in_progress');

      await recordSeenPruneAndCloseTopic(env.DB, 7, [], { id, status: 'rejected' });

      const row = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(id).first<{ status: string }>();
      expect(row?.status).toBe('rejected');
    });

    it('leaves the topic alone when topicClose is null', async () => {
      const id = await insertTopic('in_progress');

      await recordSeenPruneAndCloseTopic(env.DB, 7, [], null);

      const row = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(id).first<{ status: string }>();
      expect(row?.status).toBe('in_progress');
    });

    // The replay case (spec.md fact 2: `run()` re-executes from the top).
    // The guard is `AND status = 'in_progress'`, the same conditional-update
    // pattern `claimRow` uses - a second call finds the row already `done`
    // and changes nothing, rather than erroring or reverting a status a
    // later, unrelated process may have since moved on from.
    it('is a no-op on a replayed close (idempotent under AND status = in_progress)', async () => {
      const id = await insertTopic('in_progress');

      await recordSeenPruneAndCloseTopic(env.DB, 7, [], { id, status: 'done' });
      await recordSeenPruneAndCloseTopic(env.DB, 7, [], { id, status: 'done' });

      const row = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(id).first<{ status: string }>();
      expect(row?.status).toBe('done');
    });

    // A topic already `queued` (never claimed) or already `rejected`/`done`
    // by something else must not be silently overwritten by this call - the
    // `AND status = 'in_progress'` guard is what stops that, not merely what
    // makes replay idempotent.
    it('does not close a topic that is not in_progress', async () => {
      const id = await insertTopic('queued', null);

      await recordSeenPruneAndCloseTopic(env.DB, 7, [], { id, status: 'done' });

      const row = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(id).first<{ status: string }>();
      expect(row?.status).toBe('queued');
    });

    // The actual bug (#108): a topic left `in_progress` by a successful run
    // is indistinguishable from one stranded by a dead instance, so the TTL
    // reclaim sweep picks it up again forever. This proves the fix closes
    // that loop, not merely that a status column changed.
    it('a topic closed to done is never picked up by the TTL reclaim sweep, even past the TTL', async () => {
      const id = await insertTopic('in_progress', "datetime('now', '-100 hours')");

      await recordSeenPruneAndCloseTopic(env.DB, 7, [], { id, status: 'done' });

      // ttlHours: 1 - the claim is 100 hours stale, so an in_progress row
      // would certainly be reclaimed; a closed one must not be.
      const { row, reclaimedTopics } = await reclaimAndClaim(env.DB, 1, 'some-other-run');

      expect(reclaimedTopics).toBe(0);
      expect(row).toBeNull();
      const persisted = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(id).first<{
        status: string;
      }>();
      expect(persisted?.status).toBe('done');
    });

    // Same proof for the rejected path (record-no-sources / record-no-summaries).
    it('a topic closed to rejected is never picked up by the TTL reclaim sweep', async () => {
      const id = await insertTopic('in_progress', "datetime('now', '-100 hours')");

      await recordSeenPruneAndCloseTopic(env.DB, 7, [], { id, status: 'rejected' });

      const { row, reclaimedTopics } = await reclaimAndClaim(env.DB, 1, 'some-other-run');

      expect(reclaimedTopics).toBe(0);
      expect(row).toBeNull();
    });
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

describe('reclaimAndClaim()', () => {
  it('reclaims a stale topic, clears its claimed_at, sweeps a stranded run, and returns the newly-queued row in one call (#91)', async () => {
    const stale = await env.DB
      .prepare(
        `INSERT INTO topics (title, angle, status, origin, claimed_at)
         VALUES ('stale', NULL, 'in_progress', 'human', datetime('now', '-7 hours')) RETURNING id`,
      )
      .first<{ id: number }>();
    await env.DB
      .prepare(`INSERT INTO runs (instance_id, status, started_at) VALUES ('stranded-run', 'running', datetime('now', '-7 hours'))`)
      .run();

    const result = await reclaimAndClaim(env.DB, 6, 'test-instance');

    expect(result.reclaimedTopics).toBe(1);
    expect(result.strandedRuns).toBe(1);
    // The SELECT sees the reclaim's own write - same batch, same transaction,
    // reclaim ordered first.
    expect(result.row?.id).toBe(stale?.id);
    expect(result.row?.status).toBe('queued');

    const persistedTopic = await env.DB.prepare('SELECT claimed_at FROM topics WHERE id = ?').bind(stale?.id).first<{
      claimed_at: string | null;
    }>();
    expect(persistedTopic?.claimed_at).toBeNull();

    const runRow = await env.DB.prepare('SELECT status, finished_at FROM runs WHERE instance_id = ?').bind('stranded-run').first<{
      status: string;
      finished_at: string | null;
    }>();
    expect(runRow?.status).toBe('failed');
    expect(runRow?.finished_at).not.toBeNull();
  });

  it('leaves a topic claimed within the TTL untouched', async () => {
    const insert = await env.DB
      .prepare(
        `INSERT INTO topics (title, angle, status, origin, claimed_at)
         VALUES ('live', NULL, 'in_progress', 'human', datetime('now')) RETURNING id`,
      )
      .first<{ id: number }>();

    const result = await reclaimAndClaim(env.DB, 6, 'test-instance');
    expect(result.reclaimedTopics).toBe(0);
    expect(result.row).toBeNull(); // not returned to queued, so not selectable either

    const row = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(insert?.id).first<{
      status: string;
    }>();
    expect(row?.status).toBe('in_progress');
  });

  it('leaves a topic with claimed_at IS NULL alone (a pre-migration claim, not guessed at)', async () => {
    const insert = await env.DB
      .prepare(
        `INSERT INTO topics (title, angle, status, origin) VALUES ('pre-migration', NULL, 'in_progress', 'human') RETURNING id`,
      )
      .first<{ id: number }>();

    const result = await reclaimAndClaim(env.DB, 6, 'test-instance');
    expect(result.reclaimedTopics).toBe(0);

    const row = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(insert?.id).first<{
      status: string;
    }>();
    expect(row?.status).toBe('in_progress');
  });

  it('returns the oldest already-queued row when nothing needs reclaiming', async () => {
    await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin, created_at) VALUES ('older', NULL, 'queued', 'human', '2026-08-01T00:00:00Z')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin, created_at) VALUES ('newer', NULL, 'queued', 'human', '2026-08-20T00:00:00Z')`,
    ).run();

    const result = await reclaimAndClaim(env.DB, 6, 'test-instance');

    expect(result.reclaimedTopics).toBe(0);
    expect(result.strandedRuns).toBe(0);
    expect(result.row?.title).toBe('older');
    // Not yet claimed - reclaimAndClaim only returns the row, per its own
    // doc comment. claimRow (the caller's next, separate call) is what
    // transitions it.
    expect(result.row?.status).toBe('queued');
  });

  it('returns a null row when the queue is empty', async () => {
    const result = await reclaimAndClaim(env.DB, 6, 'test-instance');
    expect(result.row).toBeNull();
  });

  it('never sweeps a runs row within the TTL (a live run is not marked failed)', async () => {
    await env.DB.prepare(`INSERT INTO runs (instance_id, status, started_at) VALUES ('live-run', 'running', datetime('now'))`).run();

    const result = await reclaimAndClaim(env.DB, 6, 'test-instance');

    expect(result.strandedRuns).toBe(0);
    const row = await env.DB.prepare('SELECT status FROM runs WHERE instance_id = ?').bind('live-run').first<{
      status: string;
    }>();
    expect(row?.status).toBe('running');
  });

  it('never sweeps a runs row that already finished, whatever its outcome', async () => {
    // status = 'running' is the sweep's own guard - a stale write must never
    // clobber a row a terminal record-* step already resolved.
    await env.DB
      .prepare(
        `INSERT INTO runs (instance_id, status, started_at, finished_at)
         VALUES ('done-run', 'succeeded', datetime('now', '-7 hours'), datetime('now', '-6 hours'))`,
      )
      .run();

    await reclaimAndClaim(env.DB, 6, 'test-instance');

    const row = await env.DB.prepare('SELECT status FROM runs WHERE instance_id = ?').bind('done-run').first<{
      status: string;
    }>();
    expect(row?.status).toBe('succeeded');
  });

  // #104: coveredTopicTitles - the fourth statement in the same db.batch()
  // call, so `proposeTopic` (src/workflow.ts) can dedupe against the
  // agent's own past proposals at no extra subrequest.
  describe('coveredTopicTitles (#104)', () => {
    it('includes queued, in_progress and done titles but excludes rejected ones', async () => {
      for (const [title, status] of [
        ['queued title', 'queued'],
        ['in-progress title', 'in_progress'],
        ['done title', 'done'],
        ['rejected title', 'rejected'],
      ] as const) {
        await env.DB
          .prepare(`INSERT INTO topics (title, angle, status, origin) VALUES (?, NULL, ?, 'agent')`)
          .bind(title, status)
          .run();
      }

      const result = await reclaimAndClaim(env.DB, 6, 'test-instance');

      expect(result.coveredTopicTitles).toEqual(
        expect.arrayContaining(['queued title', 'in-progress title', 'done title']),
      );
      expect(result.coveredTopicTitles).not.toContain('rejected title');
    });

    it('returns at most TOPIC_DEDUPE_TITLE_LIMIT titles, newest first', async () => {
      const total = TOPIC_DEDUPE_TITLE_LIMIT + 5;
      const base = Date.UTC(2026, 0, 1);
      const rows = Array.from({ length: total }, (_, i) => ({
        title: `title-${i}`,
        // Strictly increasing - title-(total-1) is newest.
        createdAt: new Date(base + i * 1000).toISOString(),
      }));

      // Chunked INSERT...VALUES in one db.batch() call: D1 caps a query at
      // 100 bound parameters (CLAUDE.md), and this repo's own convention
      // (findSeenUrls, SEEN_URLS_CHUNK_SIZE) is to chunk rather than assume
      // a bulk write fits in one statement.
      const perStatement = 20;
      const statements = [];
      for (let i = 0; i < rows.length; i += perStatement) {
        const chunk = rows.slice(i, i + perStatement);
        const placeholders = chunk.map(() => '(?, NULL, ?, ?, ?)').join(', ');
        const binds = chunk.flatMap((r) => [r.title, 'in_progress', 'agent', r.createdAt]);
        statements.push(
          env.DB.prepare(`INSERT INTO topics (title, angle, status, origin, created_at) VALUES ${placeholders}`).bind(...binds),
        );
      }
      await env.DB.batch(statements);

      const result = await reclaimAndClaim(env.DB, 6, 'test-instance');

      expect(result.coveredTopicTitles).toHaveLength(TOPIC_DEDUPE_TITLE_LIMIT);
      // Newest TOPIC_DEDUPE_TITLE_LIMIT titles, i.e. the oldest 5 (title-0..title-4) are dropped.
      expect(result.coveredTopicTitles).not.toContain('title-0');
      expect(result.coveredTopicTitles).not.toContain('title-4');
      expect(result.coveredTopicTitles[0]).toBe(`title-${total - 1}`); // newest first
      expect(result.coveredTopicTitles).toContain('title-5'); // oldest surviving title
    });

    it("excludes currentInstanceId's own already-linked topic, so a retried select-topic step does not self-reject its own deterministic proposal", async () => {
      const own = await env.DB
        .prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('my own proposal', NULL, 'in_progress', 'agent') RETURNING id`)
        .first<{ id: number }>();
      await env.DB
        .prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('someone else entirely', NULL, 'in_progress', 'agent')`)
        .run();
      await startRun(env.DB, 'run-self');
      await env.DB.prepare(`UPDATE runs SET topic_id = ? WHERE instance_id = 'run-self'`).bind(own?.id).run();

      const result = await reclaimAndClaim(env.DB, 6, 'run-self');

      expect(result.coveredTopicTitles).not.toContain('my own proposal');
      expect(result.coveredTopicTitles).toContain('someone else entirely');
    });

    it('excludes nothing for an instance id with no linked topic (the exclusion is scoped, not a blanket exclude-everything)', async () => {
      await env.DB.prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('some title', NULL, 'in_progress', 'agent')`).run();

      const result = await reclaimAndClaim(env.DB, 6, 'an-instance-with-no-topic-linked');

      expect(result.coveredTopicTitles).toContain('some title');
    });
  });
});

describe('recordRunSpend()', () => {
  it('writes neurons_spent without touching status, finished_at, or pr_url', async () => {
    await startRun(env.DB, 'run-1');
    await env.DB.prepare(`UPDATE runs SET status = 'running' WHERE instance_id = 'run-1'`).run();

    await recordRunSpend(env.DB, 'run-1', 4000);

    const row = await env.DB.prepare('SELECT status, neurons_spent, finished_at, pr_url FROM runs WHERE instance_id = ?')
      .bind('run-1')
      .first<{ status: string; neurons_spent: number; finished_at: string | null; pr_url: string | null }>();
    expect(row?.neurons_spent).toBe(4000);
    expect(row?.status).toBe('running');
    expect(row?.finished_at).toBeNull();
    expect(row?.pr_url).toBeNull();
  });

  it('never resurrects a row that does not exist', async () => {
    await recordRunSpend(env.DB, 'no-such-run', 100);

    const row = await env.DB.prepare('SELECT * FROM runs WHERE instance_id = ?').bind('no-such-run').first();
    expect(row).toBeNull();
  });

  it('a later call overwrites an earlier one with the new cumulative total', async () => {
    await startRun(env.DB, 'run-2');

    await recordRunSpend(env.DB, 'run-2', 1500);
    await recordRunSpend(env.DB, 'run-2', 4200);

    const row = await env.DB.prepare('SELECT neurons_spent FROM runs WHERE instance_id = ?').bind('run-2').first<{
      neurons_spent: number;
    }>();
    expect(row?.neurons_spent).toBe(4200);
  });
});
