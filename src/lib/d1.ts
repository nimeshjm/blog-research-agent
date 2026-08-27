import type { RunOutcome, Topic, TopicStatus } from './types';

/**
 * Every query against the four tables in migrations/0001_init.sql. See
 * spec.md -> Design -> Data model for what each table is for; this file
 * only turns those rows into typed reads and writes.
 */

interface TopicRow {
  id: number;
  title: string;
  angle: string | null;
  status: TopicStatus;
  origin: 'human' | 'agent';
  created_at: string;
}

function toTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    title: row.title,
    angle: row.angle,
    status: row.status,
    origin: row.origin,
    createdAt: row.created_at,
  };
}

const TOPIC_COLUMNS = 'id, title, angle, status, origin, created_at';

async function fetchTopicRow(db: D1Database, id: number): Promise<TopicRow | null> {
  return db.prepare(`SELECT ${TOPIC_COLUMNS} FROM topics WHERE id = ?`).bind(id).first<TopicRow>();
}

/**
 * Transitions `row` from `queued` to `in_progress`, conditional on its
 * *current* status rather than a blind `UPDATE` (spec.md req. 2; plan.md
 * step 3). This is what makes the transition safe to replay: a Workflow
 * step is retried on failure, and if an earlier attempt's `UPDATE` already
 * committed before the step body threw for some other reason, a retry must
 * recover that same row rather than reaching for a different `queued` one
 * and orphaning the first.
 */
async function claimRow(db: D1Database, row: TopicRow): Promise<Topic | null> {
  if (row.status === 'in_progress') return toTopic(row); // already claimed - retry recovery
  if (row.status !== 'queued') return null; // done/rejected: not selectable

  const update = await db
    .prepare(`UPDATE topics SET status = 'in_progress' WHERE id = ? AND status = 'queued'`)
    .bind(row.id)
    .run();

  if ((update.meta?.changes ?? 0) > 0) {
    return toTopic({ ...row, status: 'in_progress' });
  }

  // 0 rows changed: something else moved this exact row off `queued` between
  // the caller's SELECT and this UPDATE. Recover it if it is now
  // `in_progress` (an earlier attempt of this same retried step); otherwise
  // it was claimed or resolved by something else entirely and is not ours.
  const current = await fetchTopicRow(db, row.id);
  return current !== null && current.status === 'in_progress' ? toTopic(current) : null;
}

/** Drains the oldest `queued` row (spec.md req. 2: queue-first). */
export async function claimOldestQueuedTopic(db: D1Database): Promise<Topic | null> {
  const row = await db
    .prepare(
      `SELECT ${TOPIC_COLUMNS} FROM topics WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
    .first<TopicRow>();
  if (row === null) return null;
  return claimRow(db, row);
}

/**
 * Claims a specific topic by id, used when `ResearchParams.topicId` skips
 * queue draining for a manually-targeted run. `null` when the id does not
 * exist or is not in a claimable state (`queued` or, on retry, already
 * `in_progress` from this same attempt).
 */
export async function claimTopicById(db: D1Database, id: number): Promise<Topic | null> {
  const row = await fetchTopicRow(db, id);
  if (row === null) return null;
  return claimRow(db, row);
}

/** Bound parameters per query and queries per invocation, both D1 free-plan limits. */
export const SEEN_URLS_CHUNK_SIZE = 100;
export const SEEN_URLS_MAX_QUERIES = 50;

/**
 * Cross-run dedupe lookup (spec.md req. 4; `seen_urls`). D1 caps a query at
 * 100 bound parameters and an invocation at 50 queries, so `urls` is
 * deduped and chunked rather than queried once per candidate. Returns the
 * subset of `urls` already present in `seen_urls` - callers filter
 * candidates against it, not the other way round, so this stays a pure
 * lookup with no write.
 *
 * Throws rather than truncating when the deduped input needs more than
 * `SEEN_URLS_MAX_QUERIES` chunks. spec.md's own arithmetic says this cannot
 * happen once the 30-day `gather` window and the 4,000-candidate `shortlist`
 * ceiling are both applied upstream (7 of 50 queries, measured on
 * 2026-08-26) - a count this high means one of those bounds was skipped,
 * and failing loud beats silently dropping part of the dedupe check.
 */
export async function findSeenUrls(db: D1Database, urls: string[]): Promise<Set<string>> {
  const distinct = [...new Set(urls)];
  if (distinct.length === 0) return new Set();

  const chunks: string[][] = [];
  for (let i = 0; i < distinct.length; i += SEEN_URLS_CHUNK_SIZE) {
    chunks.push(distinct.slice(i, i + SEEN_URLS_CHUNK_SIZE));
  }
  if (chunks.length > SEEN_URLS_MAX_QUERIES) {
    throw new Error(
      `findSeenUrls: ${distinct.length} distinct URLs need ${chunks.length} chunked queries, over the ${SEEN_URLS_MAX_QUERIES}-query D1 invocation budget`,
    );
  }

  const results = await Promise.all(
    chunks.map((chunk) => {
      const placeholders = chunk.map(() => '?').join(',');
      return db
        .prepare(`SELECT url FROM seen_urls WHERE url IN (${placeholders})`)
        .bind(...chunk)
        .all<{ url: string }>();
    }),
  );

  const seen = new Set<string>();
  for (const result of results) {
    for (const r of result.results) seen.add(r.url);
  }
  return seen;
}

/**
 * Exactly one row per run whatever the outcome (spec.md req. 9). Steps
 * retry, so this is `INSERT ... ON CONFLICT(instance_id) DO UPDATE` keyed
 * on the Workflow instance id rather than a plain `INSERT` - a
 * `record-success` step re-run after a successful commit but before the
 * step returned must update the same row, not violate the primary key or
 * create a second one.
 */
export async function recordRunOutcome(db: D1Database, outcome: RunOutcome): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runs (instance_id, topic_id, status, neurons_spent, sources_used, pr_url, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(instance_id) DO UPDATE SET
         topic_id      = excluded.topic_id,
         status        = excluded.status,
         neurons_spent = excluded.neurons_spent,
         sources_used  = excluded.sources_used,
         pr_url        = excluded.pr_url,
         finished_at   = excluded.finished_at`,
    )
    .bind(
      outcome.instanceId,
      outcome.topicId,
      outcome.status,
      outcome.neuronsSpent,
      outcome.sourcesUsed,
      outcome.prUrl,
    )
    .run();
}
