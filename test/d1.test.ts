import { env as testEnv } from 'cloudflare:test';
import migrationSql from '../migrations/0001_init.sql?raw';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimOldestQueuedTopic,
  claimTopicById,
  findSeenUrls,
  recordRunOutcome,
  SEEN_URLS_CHUNK_SIZE,
} from '../src/lib/d1';
import type { Env } from '../src/lib/types';

// `cloudflare:test`'s `env` types as the global (project-unaware) `Cloudflare.Env`
// - this repo has no generated worker-configuration.d.ts (no `wrangler types` run),
// so the real `DB` binding is cast to this project's own `Env` here.
const env = testEnv as unknown as Env;

/**
 * `env.DB` is the real D1 binding from wrangler.toml, run under Miniflare -
 * per CLAUDE.md, this is what proves the `seen_urls` chunking arithmetic
 * against the actual 100-bound-parameter limit rather than a mock. The
 * schema is applied by hand from migrations/0001_init.sql (split on `;`,
 * comment lines stripped) rather than through `applyD1Migrations` (which
 * needs a Node-side `readD1Migrations()` wired into vitest.config.ts as a
 * bound migrations array) - this file is the one source of truth either
 * way, and the `?raw` import is what gets the file's text into the test's
 * module bundle at all: this test runs inside the Workers runtime, where
 * `node:fs` only sees that bundle, not the real filesystem.
 */
function statementsFrom(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function resetSchema(): Promise<void> {
  for (const table of ['drafts', 'runs', 'seen_urls', 'topics']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(async () => {
  for (const stmt of statementsFrom(migrationSql)) {
    await env.DB.prepare(stmt).run();
  }
  await resetSchema();
});

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
