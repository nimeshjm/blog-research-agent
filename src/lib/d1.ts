import type { Candidate, ParsedItem, RunOutcome, Topic, TopicStatus } from './types';

/**
 * Every query against the tables in migrations/0001_init.sql and
 * 0002_run_candidates_and_claims.sql. See spec.md -> Design -> Data model
 * and features/002-gather-without-accumulation/plan.md, step 2, for what
 * each table is for; this file only turns those rows into typed reads and
 * writes.
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
  // Already claimed - retry recovery. Does not stamp claimed_at: a retry
  // recovering its own row must not extend the TTL of a claim it did not make.
  if (row.status === 'in_progress') return toTopic(row);
  if (row.status !== 'queued') return null; // done/rejected: not selectable

  const update = await db
    .prepare(
      `UPDATE topics SET status = 'in_progress', claimed_at = datetime('now') WHERE id = ? AND status = 'queued'`,
    )
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

/**
 * Finds or inserts the agent's proposed topic (spec.md req. 2/3;
 * plan.md step 4's reassignment of the propose-when-empty path), keyed by
 * an exact title match rather than a DB constraint - `topics` has none, and
 * adding one is a schema migration out of scope for this PR. This is what
 * makes a retried `select-topic` step idempotent on this path the same way
 * `claimRow` makes the queue-draining path idempotent: an earlier attempt's
 * INSERT is recovered by title, not duplicated, on the assumption (true
 * within a step's retry window) that the same run's proposal is
 * deterministic. Inserted directly as `in_progress` rather than `queued`
 * then claimed - this run is about to use the row immediately, and nothing
 * else can have raced ahead of it, unlike the shared `queued` state that
 * `claimOldestQueuedTopic` drains.
 */
export async function findOrProposeTopic(
  db: D1Database,
  proposal: { title: string; angle: string | null },
): Promise<Topic> {
  // Only recovers a row still in a claimable state, matching claimRow()'s
  // own rule right above ("done/rejected: not selectable"). Without this, a
  // proposal whose earlier PR was opened but never merged - so the title
  // stays genuinely uncovered on later runs - would keep resolving to that
  // same `done`/`rejected` row forever instead of being researched again.
  const existing = await db
    .prepare(
      `SELECT ${TOPIC_COLUMNS} FROM topics WHERE title = ? AND origin = 'agent' AND status IN ('queued', 'in_progress') ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(proposal.title)
    .first<TopicRow>();
  if (existing !== null) return toTopic(existing);

  const inserted = await db
    .prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES (?, ?, 'in_progress', 'agent') RETURNING ${TOPIC_COLUMNS}`,
    )
    .bind(proposal.title, proposal.angle)
    .first<TopicRow>();
  if (inserted === null) {
    throw new Error('findOrProposeTopic: INSERT ... RETURNING produced no row');
  }
  return toTopic(inserted);
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

/**
 * Writes one feed's candidates in a single `db.batch()` of two statements -
 * a scoped `DELETE` then an `INSERT ... SELECT ... FROM json_each(?3)` - so
 * the row count never drives the query count. Binding one parameter per
 * column per row would need 18+ chunked queries for arXiv cs.AI's 352
 * candidates alone (spec.md req. 6); `json_each` unpacks the whole array
 * inside SQLite from a single JSON parameter instead, so a gather step costs
 * exactly two of the invocation's 50 queries whatever the feed's size. Short
 * keys (`u`/`t`/`p`/`m`) because the payload is machine-only, not read
 * elsewhere.
 *
 * The `DELETE` is scoped to `(run_id, source_name)`, not `run_id` alone: a
 * run_id-wide delete in a per-feed step would wipe every earlier feed's rows
 * written by the same run. Scoping it this way is what makes the step
 * idempotent under replay without being destructive to sibling feeds - it
 * still runs when `candidates` is empty, so a feed that went empty between
 * attempts does not leave an earlier attempt's rows behind.
 *
 * Takes `ParsedItem`, not `Candidate`: `sourceName` is bound once as `?2`
 * for the whole statement, so a caller has no reason to attach it to every
 * item first. That spares the gather loop one object allocation per item -
 * up to 1,154 of them on the largest feed - in exactly the loop this
 * feature exists to make cheaper.
 *
 * Returns `items.length`, not `meta.changes`: `INSERT OR REPLACE`
 * reports replacements as changes too, and the caller wants the candidate
 * count.
 */
export async function writeRunCandidates(
  db: D1Database,
  runId: string,
  sourceName: string,
  items: ParsedItem[],
): Promise<number> {
  const payload = JSON.stringify(items.map((i) => ({ u: i.url, t: i.title, p: i.publishedAt, m: i.publishedMs })));

  await db.batch([
    db.prepare(`DELETE FROM run_candidates WHERE run_id = ? AND source_name = ?`).bind(runId, sourceName),
    db
      .prepare(
        `INSERT OR REPLACE INTO run_candidates (run_id, url, title, published_at, published_ms, source_name)
         SELECT ?1,
                json_extract(value, '$.u'),
                json_extract(value, '$.t'),
                json_extract(value, '$.p'),
                json_extract(value, '$.m'),
                ?2
           FROM json_each(?3)`,
      )
      .bind(runId, sourceName, payload),
  ]);

  return items.length;
}

interface SourceWeightRow {
  source_name: string;
  avg_items: number;
}

/**
 * Mean candidates per run per source, over whatever `run_candidates` history
 * the 7-day `RUN_CANDIDATE_RETENTION_DAYS` prune has left. Backs
 * `createGatherChildren`'s volume-balanced chunking (spec.md requirement 3,
 * amended 2026-09-01 after run `bd33248b`): parse cost scales with items,
 * not with feeds, so the chunker needs a per-feed item estimate and this is
 * the only non-perishable place to get one. A hand-maintained table would
 * rot - arXiv cs.AI went from 352 items on 2026-08-27 to 783 on 2026-09-01.
 *
 * **The average is per *distinct run*, not per row.** A plain `COUNT(*)`
 * would score a feed by how many runs it has appeared in as much as by its
 * size, so a small feed present in every run could outweigh a large one
 * added last week.
 *
 * **`excludeRunId` is load-bearing, not hygiene.** `run()` re-executes on
 * replay (spec.md fact 2) and this run's own children write into
 * `run_candidates` under this same `run_id` as they complete. Counting them
 * would make a replay of `create-gather-children` compute different weights,
 * hence different chunks, while the deterministic child ids
 * (`${parentInstanceId}-g${index}`) stayed the same - children already
 * created, silently carrying different params from the ones the replay
 * thinks it asked for.
 *
 * A source with no rows in the window is simply absent from the result. The
 * caller supplies the default; this function does not invent one, because it
 * cannot tell a brand-new feed from one that has been returning nothing.
 */
export async function readSourceWeights(db: D1Database, excludeRunId: string): Promise<Map<string, number>> {
  const result = await db
    .prepare(
      `SELECT source_name, CAST(COUNT(*) AS REAL) / COUNT(DISTINCT run_id) AS avg_items
         FROM run_candidates
        WHERE run_id != ?
        GROUP BY source_name`,
    )
    .bind(excludeRunId)
    .all<SourceWeightRow>();

  return new Map(result.results.map((row) => [row.source_name, row.avg_items]));
}

interface RunCandidateRow {
  url: string;
  title: string;
  published_at: string | null;
  published_ms: number | null;
  source_name: string;
}

/**
 * The run's whole candidate set, capped and ordered in SQL rather than
 * materialized and sorted in JS. `published_ms IS NULL` sorted first is
 * SQLite's NULLS LAST idiom: undated items sort after dated ones, so they
 * are the first `limit` drops - the same rule `dateKey`'s
 * `NEGATIVE_INFINITY` gave undated items, now applied by the database
 * instead of by re-parsing every candidate's date in JS. The `IS NULL` term
 * is not load-bearing on its own - SQLite's plain `published_ms DESC`
 * already sorts `NULL` last - it is kept as an explicit statement of that
 * intent, not as the mechanism.
 */
export async function readRunCandidates(db: D1Database, runId: string, limit: number): Promise<Candidate[]> {
  const result = await db
    .prepare(
      `SELECT url, title, published_at, published_ms, source_name
         FROM run_candidates
        WHERE run_id = ?
        ORDER BY published_ms IS NULL, published_ms DESC
        LIMIT ?`,
    )
    .bind(runId, limit)
    .all<RunCandidateRow>();

  return result.results.map((row) => ({
    url: row.url,
    title: row.title,
    publishedAt: row.published_at,
    publishedMs: row.published_ms,
    sourceName: row.source_name,
  }));
}

/**
 * `run_candidates` is per-run scratch, not the cross-run dedupe key -
 * `seen_urls` stays that. `created_at` is compared rather than joining
 * `runs`, so a run that never wrote a `runs` row still gets its rows
 * collected. Called once per run regardless of outcome; `retentionDays` is
 * the caller's constant, not this file's.
 */
export async function pruneRunCandidates(db: D1Database, retentionDays: number): Promise<void> {
  await db
    .prepare(`DELETE FROM run_candidates WHERE created_at < datetime('now', '-' || ? || ' days')`)
    .bind(retentionDays)
    .run();
}

/**
 * Creates the `runs` row when a run starts rather than when it ends (spec.md
 * req. 10), so a run that dies mid-step still leaves a row behind.
 * `INSERT OR IGNORE` on the `instance_id` primary key is replay safety: a
 * retried first step must never reset an already-finished run's row back to
 * `running`. `runs.status` has no `CHECK` constraint, so `'running'` needs
 * no migration.
 */
export async function startRun(db: D1Database, instanceId: string): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO runs (instance_id, status) VALUES (?, 'running')`).bind(instanceId).run();
}

/**
 * Separate from `startRun` because the topic is not known until
 * `select-topic` returns, and a run that dies later, in `gather`, must still
 * record which topic it stranded.
 */
export async function attachRunTopic(db: D1Database, instanceId: string, topicId: number): Promise<void> {
  await db.prepare(`UPDATE runs SET topic_id = ? WHERE instance_id = ?`).bind(topicId, instanceId).run();
}

/**
 * Returns a topic to `queued` once its claim has outlived `ttlHours` (spec.md
 * req. 8/9, "Reclaiming a stranded topic") - the unattended path `claimRow`'s
 * own retry recovery does not reach, since that only recovers a run's own
 * `in_progress` row when it names the topic via `ResearchParams.topicId`. A
 * row with `claimed_at IS NULL` predates this migration and is left alone
 * rather than guessed at - though `AND claimed_at IS NOT NULL` is not what
 * enforces that: SQL's three-valued logic already makes `claimed_at <
 * datetime(...)` evaluate to `NULL`, never true, when `claimed_at` is
 * `NULL`. The clause is kept as an explicit statement of that intent, not as
 * the mechanism. `ttlHours` is the caller's constant, not this file's.
 */
export async function reclaimStaleTopics(db: D1Database, ttlHours: number): Promise<number> {
  const update = await db
    .prepare(
      `UPDATE topics SET status = 'queued', claimed_at = NULL
        WHERE status = 'in_progress'
          AND claimed_at IS NOT NULL
          AND claimed_at < datetime('now', '-' || ? || ' hours')`,
    )
    .bind(ttlHours)
    .run();

  return update.meta?.changes ?? 0;
}
