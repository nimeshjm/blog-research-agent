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
 *
 * Exported (#91) so `selectTopic` (src/workflow.ts) can claim the row
 * `reclaimAndClaim` below returns - that `SELECT` runs inside a `db.batch()`
 * that cannot also carry this `UPDATE`, because a batch's statements are all
 * bound before any of them run (`reclaimAndClaim`'s own comment).
 */
export async function claimRow(db: D1Database, row: TopicRow): Promise<Topic | null> {
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
 * else can have raced ahead of it, unlike the shared `queued` state
 * `reclaimAndClaim` drains.
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
 * Records a run's cumulative neuron spend as it becomes known, ahead of any
 * terminal `record-*` step (#91) - called from the `await-summarize-children`
 * join, on the round that reaches `done`, with the round's cumulative total.
 * That is ~4,000 of a typical ~4,300-neuron run, known well before
 * `synthesize` or `record-success` run, so a run that dies after the join
 * (inside `synthesize`, inside publish, or on the platform's own subrequest
 * ceiling) leaves a real number in `runs.neurons_spent` rather than the `0`
 * `startRun` wrote.
 *
 * A plain `UPDATE`, deliberately, not `recordRunOutcome`'s `INSERT ... ON
 * CONFLICT DO UPDATE`: this must never resurrect a row `startRun` did not
 * create (there is no `instance_id` to insert if the row is somehow gone),
 * and it must touch `neurons_spent` alone - never `status`, `finished_at` or
 * `pr_url`, which stay whatever a terminal `record-*` step or the #91 sweep
 * last wrote. Idempotent by construction: a replayed step body does not
 * re-run (the platform caches a completed step's result), and even a genuine
 * re-run would just write the same cumulative total again.
 */
export async function recordRunSpend(db: D1Database, instanceId: string, neuronsSpent: number): Promise<void> {
  await db.prepare(`UPDATE runs SET neurons_spent = ? WHERE instance_id = ?`).bind(neuronsSpent, instanceId).run();
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
 * Shared by the standalone `pruneRunCandidates` below and by
 * `recordSeenPruneAndCloseTopic`'s batch, so the DELETE's SQL text lives in
 * exactly one place regardless of which caller runs it.
 */
function pruneRunCandidatesStatement(db: D1Database, retentionDays: number): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM run_candidates WHERE created_at < datetime('now', '-' || ? || ' days')`)
    .bind(retentionDays);
}

/**
 * `run_candidates` is per-run scratch, not the cross-run dedupe key -
 * `seen_urls` stays that. `created_at` is compared rather than joining
 * `runs`, so a run that never wrote a `runs` row still gets its rows
 * collected. Called once per run regardless of outcome; `retentionDays` is
 * the caller's constant, not this file's.
 *
 * Exported and exercised standalone (test/d1.test.ts) even though the only
 * production call site now goes through `recordSeenPruneAndCloseTopic`
 * below - kept as its own function so the prune half of that batch stays
 * independently testable without a `Candidate[]` in the way.
 */
export async function pruneRunCandidates(db: D1Database, retentionDays: number): Promise<void> {
  await pruneRunCandidatesStatement(db, retentionDays).run();
}

/**
 * Marks `seen` as cross-run dedupe hits, prunes `run_candidates`, and - new
 * here, #108 - closes `topicClose`'s topic, all in one `db.batch()` call: one
 * subrequest whatever the statement count, the same `json_each` trick
 * `writeRunCandidates` above uses to unpack an array inside SQLite from a
 * single bound parameter rather than one parameter per row. `seen` is
 * typically `shortlist`, up to `SHORTLIST_TOP_N` items (spec.md req. 4,
 * amended 2026-09-04 - #100 - to say which URLs count as seen and why); the
 * empty array on the `record-no-topic` path, where no shortlist has been
 * computed yet, costs the same one call. Renamed from `recordSeenAndPrune`
 * because closing the topic is no longer a side effect this name would hide.
 *
 * `INSERT OR IGNORE`, not `ON CONFLICT(url) DO NOTHING`: D1's SQLite rejects
 * an upsert clause on an `INSERT ... SELECT` (`near "DO": syntax error`,
 * confirmed against the real binding under `cloudflare:test`, not just
 * inferred) even though the same clause is fine on the `INSERT ... VALUES`
 * form `recordRunOutcome` above uses. `INSERT OR IGNORE` gives the same
 * no-op-on-conflict behaviour `startRun`'s own comment relies on, and is
 * what makes this idempotent under replay - `run()` re-executes from the top
 * on replay (spec.md fact 2), and every terminal `record-*` step in
 * `src/workflow.ts` calls this via `recordOutcome`, so inserting a URL
 * already in `seen_urls` (this run's own earlier attempt, or an unrelated
 * run that happened to see the same article) must be a no-op rather than a
 * primary-key violation.
 *
 * **The topic-close `UPDATE` (#108) follows `claimRow`'s own pattern**: it is
 * conditional on the row's *current* status (`AND status = 'in_progress'`),
 * not a blind write, which is what makes a replay a no-op instead of a
 * state-machine violation - a run that already closed its topic to `done` on
 * an earlier attempt finds 0 rows matching `in_progress` on the next one and
 * changes nothing. `topicClose` is `null` on the `record-no-topic` path, where
 * there is no topic to close, and on any other path where a caller has
 * nothing to close (there is none today, but the parameter is not implicitly
 * "always present" the way `seen` is - see `recordOutcome`, src/workflow.ts).
 * `claimed_at` is cleared alongside the status for the same reason
 * `reclaimAndClaim`'s own reclaim `UPDATE` clears it: the column is only ever
 * read by that TTL sweep, which already requires `status = 'in_progress'`, so
 * a closed topic has no live claim to record.
 *
 * **Which status a caller passes is `recordOutcome`'s decision, not this
 * function's** - see that function's comment for the `done`/`rejected` split
 * and why an `insufficient_sources` run closes to `rejected` rather than
 * releasing the topic back to `queued`.
 *
 * Batched with the prune, deliberately not with `recordRunOutcome`
 * (src/workflow.ts's `recordOutcome`, called just before this, as its own,
 * separate D1 call - not folded in here): `db.batch()` is atomic, so folding
 * any of this into the outcome write would mean a failing statement also
 * loses the `runs` row - exactly the failure mode `recordOutcome`'s own
 * comment says the outcome-before-this ordering exists to avoid (spec.md
 * req. 10, "every run writes a runs row, including one that dies mid-step").
 * Because that write already happened and already committed by the time
 * this function runs, req. 10 cannot be violated by anything below this
 * point, whatever fails here.
 *
 * Pairing the topic close with the prune and the seen-insert instead accepts
 * a narrower version of the same trade: a failing topic `UPDATE` (there is
 * no reason one should fail - it is a single-row write by primary key with
 * no foreign constraint to violate) would also roll back this call's prune
 * and seen-insert. The cost of that, concretely: the run's `runs` row still
 * has its correct terminal status (already committed, above), but the topic
 * stays `in_progress` - exactly the pre-#108 behaviour for that one run, not
 * a regression, and it self-heals the same way it always did: the TTL sweep
 * (`reclaimAndClaim`) reclaims it after `TOPIC_CLAIM_TTL_HOURS`, at the cost
 * of one wasted cycle rather than the permanent loop #108 was filed about.
 * That is the same atomicity risk this batch already carried for the prune
 * and the insert, extended to a third statement rather than a new one - see
 * `createPublishChildren`'s comment (src/workflow.ts) for why a fourth,
 * separate call is not available at this subrequest budget.
 */
export async function recordSeenPruneAndCloseTopic(
  db: D1Database,
  retentionDays: number,
  seen: Candidate[],
  topicClose: { id: number; status: 'done' | 'rejected' } | null,
): Promise<void> {
  const payload = JSON.stringify(seen.map((c) => ({ u: c.url, t: c.title, s: c.sourceName })));

  const statements = [
    pruneRunCandidatesStatement(db, retentionDays),
    db.prepare(
      `INSERT OR IGNORE INTO seen_urls (url, title, source)
       SELECT json_extract(value, '$.u'), json_extract(value, '$.t'), json_extract(value, '$.s')
         FROM json_each(?)`,
    ).bind(payload),
  ];

  if (topicClose !== null) {
    statements.push(
      db
        .prepare(`UPDATE topics SET status = ?, claimed_at = NULL WHERE id = ? AND status = 'in_progress'`)
        .bind(topicClose.status, topicClose.id),
    );
  }

  await db.batch(statements);
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
 * How many of `topics`'s own titles feed `proposeTopic`'s dedupe check
 * (spec.md req. 3, #104). `topics` gains at most one agent-origin row per
 * scheduled run that finds the queue empty - `findOrProposeTopic` is the
 * only writer on that path - so this bound is a recency window measured in
 * runs, not a hard cap ever expected to bind soon: 300 is comfortably past a
 * year of daily empty-queue runs. It exists because the read rides
 * `select-topic`'s own step, which already tokenizes two feed reads inside
 * the same 10 ms-per-invocation CPU budget (CLAUDE.md's "Platform rules") -
 * tokenizing 300 short titles costs microseconds next to that, but an
 * unbounded `SELECT` growing forever is exactly the #75 class of bug this
 * repo has already been bitten by once (see `chunkSourcesByVolume`'s own
 * comment for that incident).
 */
export const TOPIC_DEDUPE_TITLE_LIMIT = 300;

/** What `reclaimAndClaim` below hands back: the row `selectTopic` still has to `claimRow`, plus both sweeps' counts for observability. */
export interface ReclaimAndClaimResult {
  row: TopicRow | null;
  /** `topics` rows this call returned to `queued` past `ttlHours` - see `reclaimAndClaim`'s own comment for the reclaim `UPDATE` this counts. */
  reclaimedTopics: number;
  /** `runs` rows this call swept from `running` to `failed` past the same TTL (#91) - see this function's own comment. */
  strandedRuns: number;
  /**
   * Up to `TOPIC_DEDUPE_TITLE_LIMIT` most-recent titles from `topics` in
   * status `queued`, `in_progress` or `done` - never `rejected` (#104): a
   * rejected proposal is an explicit signal that its title should be free to
   * try again, not burned forever. Excludes whichever row is already linked
   * to `currentInstanceId` via `runs.topic_id`, if any - see this function's
   * own comment on why that exclusion has to be here, not in `proposeTopic`.
   * Read unconditionally, whether or not `row` is null, because it rides the
   * same `db.batch()` call as the two sweeps above - see this function's own
   * comment for why that makes it free on every path. `selectTopic` passes
   * it straight to `proposeTopic` (src/workflow.ts) so a proposal is deduped
   * against the agent's own past proposals without a second read.
   */
  coveredTopicTitles: string[];
  /**
   * Sum of `runs.neurons_spent` over every row started today, UTC
   * (`started_at >= date('now')`) - D1's `date('now')` is UTC, and so is the
   * Workers AI free allocation's 00:00 reset, which is what makes this the
   * right boundary rather than a rolling 24h window (#111). `coalesce(...,
   * 0)` is there because SQLite's `sum()` returns NULL over zero matching
   * rows, not because `neurons_spent` itself can be NULL - the column is
   * `NOT NULL DEFAULT 0`. Every status lands in this sum (`succeeded`,
   * `failed`, `insufficient_sources`, `no_topic`, `budget_skipped`): a
   * `failed` run can have spent real neurons before dying (#102), and the
   * others always contribute 0, so summing without a status filter costs
   * nothing extra and loses nothing by including them.
   *
   * Includes the *calling* run's own row - `start-run` (src/lib/d1.ts) has
   * already inserted it, `neurons_spent = 0`, by the time `select-topic`
   * calls this - so it always adds zero for the caller's own instance. That
   * is why this field needs no `currentInstanceId` self-exclusion the way
   * `coveredTopicTitles` above does: a sum tolerates counting a zero-valued
   * row that an exact title match could not.
   *
   * A fifth, fixed-shape statement in the same `db.batch()` call as the
   * other four - no data dependency on any of them, so it costs the caller
   * nothing beyond what `reclaimAndClaim` already spent: one subrequest
   * whatever the statement count (`writeRunCandidates`'s comment is the
   * precedent this repeats). `selectTopic` (src/workflow.ts) is the only
   * reader, and only on the scheduled path - the guard this backs does not
   * run on the manually-targeted path, which never calls this function.
   */
  dailyNeuronsSpent: number;
}

interface DailySpendRow {
  total: number;
}

/**
 * Consolidates the scheduled path's reclaim sweep, the new stale-run sweep
 * (#91), the oldest-queued lookup, a read of `topics`'s own covered titles
 * (#104), and (#111) a read of today's aggregate neuron spend into one
 * `db.batch()` - one subrequest, five statements, run in order inside one
 * transaction. This is the same trick `writeRunCandidates` above uses for
 * its `DELETE`+`INSERT` pair: `db.batch()` is one subrequest whatever the
 * statement count, so folding a fourth or fifth statement in is free where a
 * standalone call would not be. Neither the fourth nor the fifth statement
 * has a data dependency on the other three - both are fixed-shape reads,
 * like the oldest-queued lookup - so both fit the same "bound before any of
 * them run" rule the third statement already does; see this function's own
 * comment on `claimRow` below for the one statement here that does *not* fit
 * it.
 *
 * **Why the daily-spend read belongs here and not in a standalone call
 * (#111).** `selectTopic`'s scheduled path needs to know today's aggregate
 * `runs.neurons_spent` before deciding whether to claim the row this same
 * batch's `SELECT` just found - a guard that ran after `claimRow` would have
 * already transitioned the topic to `in_progress` for nothing. Reading it
 * here, alongside the lookup it gates, means the guard costs the parent
 * nothing it was not already spending; see `ReclaimAndClaimResult.dailyNeuronsSpent`'s
 * own comment for the UTC boundary and why every run status is summed
 * without a filter.
 *
 * **Why the fourth statement excludes `currentInstanceId`'s own topic.**
 * `findOrProposeTopic` recovers a retried `select-topic` step's earlier
 * INSERT by exact title match - the comment on that function calls this
 * "the same run's proposal is deterministic." Without the exclusion, a
 * retry that reaches this call *after* an earlier attempt's INSERT already
 * committed would see its own just-inserted title back in
 * `coveredTopicTitles`, `proposeTopic` would reject its own deterministic
 * seed candidate as "already covered" - by itself - and the retry would
 * propose nothing instead of recovering the same topic. `AND topic_id IS
 * NOT NULL` in the subquery matters for a reason beyond tidiness: SQL's
 * `NOT IN` against a list containing NULL evaluates to NULL - never true -
 * for every row, which would silently empty `coveredTopicTitles` on any
 * call where `runs` holds an untouched row for this instance.
 *
 * **This narrows the replay window rather than closing it.** The exclusion
 * relies on `runs.topic_id` already naming this row, and `attachRunTopic`
 * sets that column in a *separate* call after `findOrProposeTopic`'s INSERT
 * returns (`selectTopic`, src/workflow.ts) - the two are not one atomic
 * write. A replay that lands between them (INSERT committed,
 * `attachRunTopic` never ran) still sees its own title here, and
 * `proposeTopic` still rejects its own candidate as self-covered - the
 * same failure this comment exists to prevent, just for that one
 * sub-window rather than every retry. Before #104 this exact window
 * degraded gracefully, because nothing yet read `coveredTopicTitles`:
 * `proposeTopic` would re-derive the same candidate and `findOrProposeTopic`
 * would recover the existing row by title. Making the INSERT and the
 * `runs.topic_id` link one atomic write would close this fully; that is a
 * larger change than #104's scope and is not made here.
 *
 * **Order is load-bearing.** The reclaim `UPDATE` has to run before the
 * `SELECT`, in the same transaction, so the `SELECT` can see topics the
 * reclaim just returned to `queued` - a topic reclaimed on this exact call
 * must be immediately selectable, not deferred to the next run. The stale-run
 * sweep sits between them because it does not touch `topics` at all and so
 * has no ordering constraint against either - it is here for the free ride,
 * not because its position matters.
 *
 * **The stale-run sweep is replay-safe by construction, on both directions
 * feature 002 requirement 9 asks about.** `WHERE status = 'running' AND
 * started_at < datetime('now', '-' || ? || ' hours')` can never touch the
 * *current* run's own row - it started seconds ago, nowhere near `ttlHours`
 * back - so a `run()` replay re-running `select-topic` can never mark a live
 * run `failed`. The `status = 'running'` guard is what stops the other
 * direction: a stale sweep can never clobber a row some other path already
 * moved to `succeeded`/`no_topic`/`insufficient_sources`. The reverse *is*
 * possible, and is correct: a run that legitimately outlives the TTL gets
 * swept to `failed` here, and its own later `recordRunOutcome` (`INSERT ...
 * ON CONFLICT DO UPDATE`) overwrites `failed` -> `succeeded` when it finally
 * finishes - a late-arriving success wins over a presumed failure, never the
 * other way round.
 *
 * **`claimRow` still runs as its own call afterwards, not folded into this
 * batch.** It needs the id the `SELECT` just returned, and every statement in
 * a `db.batch()` call is bound client-side before any of them run - there is
 * no way to feed one statement's result into a later statement's parameters
 * within the same batch. That is also why this function returns the raw row
 * rather than an already-claimed `Topic`: claiming it is the caller's next,
 * separate D1 call.
 *
 * **The reclaim `UPDATE`'s own predicate** (spec.md req. 8/9, "Reclaiming a
 * stranded topic") - the unattended path `claimRow`'s own retry recovery does
 * not reach, since that only recovers a run's own `in_progress` row when it
 * names the topic via `ResearchParams.topicId`. A row with `claimed_at IS
 * NULL` predates the claim-timestamp migration and is left alone rather than
 * guessed at - though `AND claimed_at IS NOT NULL` is not what enforces that:
 * SQL's three-valued logic already makes `claimed_at < datetime(...)`
 * evaluate to `NULL`, never true, when `claimed_at` is `NULL`. The clause is
 * kept as an explicit statement of that intent, not as the mechanism.
 */
export async function reclaimAndClaim(
  db: D1Database,
  ttlHours: number,
  // Required, not defaulted - CLAUDE.md's `tracerFor` is the precedent this
  // repo already uses for "a call site can't forget an instance id": a
  // default here would make it easy for a future caller to silently skip
  // the self-exclusion the comment above explains, reopening #104's replay
  // bug rather than merely narrowing it.
  currentInstanceId: string,
): Promise<ReclaimAndClaimResult> {
  const results = await db.batch<TopicRow>([
    db
      .prepare(
        `UPDATE topics SET status = 'queued', claimed_at = NULL
          WHERE status = 'in_progress'
            AND claimed_at IS NOT NULL
            AND claimed_at < datetime('now', '-' || ? || ' hours')`,
      )
      .bind(ttlHours),
    db
      .prepare(
        `UPDATE runs SET status = 'failed', finished_at = datetime('now')
          WHERE status = 'running'
            AND started_at < datetime('now', '-' || ? || ' hours')`,
      )
      .bind(ttlHours),
    db.prepare(`SELECT ${TOPIC_COLUMNS} FROM topics WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`),
    db
      .prepare(
        `SELECT ${TOPIC_COLUMNS} FROM topics
          WHERE status IN ('queued', 'in_progress', 'done')
            AND id NOT IN (SELECT topic_id FROM runs WHERE instance_id = ? AND topic_id IS NOT NULL)
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(currentInstanceId, TOPIC_DEDUPE_TITLE_LIMIT),
    db.prepare(`SELECT coalesce(sum(neurons_spent), 0) AS total FROM runs WHERE started_at >= date('now')`),
  ]);

  // Indexed with `?.` rather than destructured-and-cast: `db.batch()`
  // guarantees five results back in the order the five statements went in,
  // but `noUncheckedIndexedAccess` cannot see that from the array's static
  // type, and the `?? 0` / `?? null` / `?? []` fallbacks below are what this
  // needs to be total anyway - no cast required to get there, for the first
  // four statements. `db.batch()` has one type parameter for every statement
  // in the call (there is no per-statement row type), so the fifth
  // statement's actual `{ total }` shape is not what the batch's own
  // `TopicRow` type parameter says it is; the `unknown` round-trip on
  // `results[4]` is what tells TypeScript to trust the SQL over the type
  // parameter for that one result, in the one place a genuinely different
  // row shape needs it.
  return {
    row: results[2]?.results[0] ?? null,
    reclaimedTopics: results[0]?.meta?.changes ?? 0,
    strandedRuns: results[1]?.meta?.changes ?? 0,
    coveredTopicTitles: (results[3]?.results ?? []).map((r) => r.title),
    dailyNeuronsSpent: (results[4]?.results[0] as unknown as DailySpendRow | undefined)?.total ?? 0,
  };
}
