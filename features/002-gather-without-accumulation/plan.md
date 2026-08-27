# Plan: Gather without accumulation

> Stage 3. Produced from the approved `spec.md`. Committed alongside the code.

## Context

`gather` cannot get past the fifth of forty-six feeds: the Workers CPU limit is per
*invocation*, not per step, and `run()` accumulates every feed's candidates into one array
that is rebuilt on every replay ([#61](https://github.com/nimeshjm/blog-research-agent/issues/61),
[`intent.md`](intent.md), [`spec.md`](spec.md)). This plan removes the growth term
(requirement 4), moves the candidate set into D1 (requirements 5-7), makes a stranded
topic and a dead run legible (requirements 8-10), corrects the premise that produced the
bug (requirement 11), and only then decides whether bounding the parse pays at all
(requirement 1, explicitly droppable).

The stack is ordered so that the load-bearing requirement lands second and the
still-unmeasured one lands last. `M = 6` is pinned before the first PR opens, and holds
whichever way requirement 1's measurement goes, because PR 6 exists either way — as the
implementation or as the recorded decision not to implement it.

### Two spec questions this plan closes before any code is written

1. **`db.batch()` and the 50-query budget.** `spec.md` leaves open whether a chunked
   batch amortises to one query, with a per-invocation statement ceiling as the fallback.
   Neither is needed: D1 supports SQLite's `json1` extension, so a whole feed's
   candidates are written by **one statement with three bound parameters**, whatever the
   row count. Probed against the real `blog_research` database, 2026-08-27:

   ```
   npx wrangler d1 execute blog_research --remote \
     --command "SELECT json_extract(value,'\$.url') AS url FROM json_each('[{\"url\":\"a\"},{\"url\":\"b\"}]')"
   → [{"url":"a"},{"url":"b"}]   success: true, rows_read: 2
   ```

   Two queries per gather step (one `DELETE`, one `INSERT`), so three gather steps in one
   invocation cost 6 of 50 rather than 57. arXiv cs.AI's 352-candidate day is written
   whole, which is what requirement 6 forbids trading away. `spec.md`'s design section is
   corrected in PR 3, the PR that implements it, per `REVIEW.md` pass 4.

2. **`shortlist`'s own CPU.** `spec.md` names it as an open risk: 678 candidates
   materialized in one step, against a bench that failed at 393. Rather than re-sorting
   them in JS, `run_candidates` carries a `published_ms INTEGER` column, computed from the
   date `applyGatherWindow` **already parses**, so the newest-first ordering and the
   `SHORTLIST_MAX_CANDIDATES` cap both happen in SQL. `shortlist` then does zero
   `Date.parse` calls where today it does one per candidate. This is the same
   "thread the parsed value through, never recompute it" constraint `spec.md` imposes on
   requirement 1, applied to the step the spec says might relocate the problem.

### A fourth file asserts the wrong CPU premise

`spec.md` requirement 11 names three files. There is a fourth, and acceptance criterion
11's grep will find it: `src/workflow.ts:31-36`, the `ResearchWorkflow` class doc comment
— *"a Workflow gets 10 ms of CPU per \*step\* with no wall-clock cap"*. It is corrected in
PR 5 with the other three.

## Files

### PR 1 — `61-plan-md` (Part 1 of 6)

| file | change |
|---|---|
| `features/002-gather-without-accumulation/plan.md` | this file; replaces the unfilled template |

### PR 2 — `61-migration-0002` (Part 2 of 6)

| file | change |
|---|---|
| `migrations/0002_run_candidates_and_claims.sql` | new: `run_candidates`, `topics.claimed_at` |
| `src/lib/d1.ts` | new exports: `writeRunCandidates`, `readRunCandidates`, `pruneRunCandidates`, `startRun`, `attachRunTopic`, `reclaimStaleTopics`; `claimRow` also stamps `claimed_at` |
| `src/lib/types.ts` | `Candidate` gains `publishedMs: number \| null` |

Nothing calls the new functions yet. That is deliberate: the migration and its query layer
are reviewable on their own, and `typecheck` covers unused exports.

### PR 3 — `61-gather-returns-count` (Part 3 of 6)

| file | change |
|---|---|
| `src/lib/feed.ts` | `applyGatherWindow` returns `WindowedItem[]`, carrying the epoch-ms it already parsed |
| `src/lib/types.ts` | new `WindowedItem` |
| `src/workflow.ts` | `gatherCandidates` persists and returns a count; `run()` holds an integer; `shortlistCandidates` reads from D1; `dateKey` deleted; `RUN_CANDIDATE_RETENTION_DAYS` added |
| `features/002-gather-without-accumulation/spec.md` | design section: `json_each` write, `published_ms`, both open questions closed |

### PR 4 — `61-run-row-and-reclaim` (Part 4 of 6)

| file | change |
|---|---|
| `src/workflow.ts` | new `start-run` step; `selectTopic` reclaims before claiming and attaches `topic_id`; `TOPIC_CLAIM_TTL_HOURS` added |

### PR 5 — `61-cpu-premise` (Part 5 of 6)

| file | change |
|---|---|
| `CLAUDE.md` | `:62` — per-invocation, with the measured number |
| `features/001-scheduled-research-drafts/spec.md` | `:64`, `:295`, `:383`, `:463` |
| `.claude/skills/cf-free-tier/SKILL.md` | `:15`, `:16`, `:35` — the file loaded when someone writes a new step |
| `src/workflow.ts` | the class doc comment at `:31-36` |
| `scripts/review-checks.mjs` | new check `cpu-premise-is-per-invocation` |
| `scripts/review-checks.test.mjs` | mutation rows proving it fires |
| `REVIEW.md` | pass 1 marker naming the new check id |

### PR 6 — `61-bound-parse` (Part 6 of 6, `Closes #61`)

Either the bounded parse (`src/lib/feed.ts`, `src/workflow.ts`, `src/lib/types.ts`) plus
its differential test, **or** a `spec.md` amendment recording the measurement and dropping
requirement 1. The PR exists either way, so `M = 6` never has to be revised.

## Work order

### 1. `plan.md` — PR 1

This file. Opened as a stack of one, so the stage-3 gate is a reviewable artifact before
any `src/` change exists.

### 2. Migration and query layer — PR 2

**`migrations/0002_run_candidates_and_claims.sql`**

```sql
CREATE TABLE IF NOT EXISTS run_candidates (
  run_id       TEXT    NOT NULL,
  url          TEXT    NOT NULL,
  title        TEXT,
  published_at TEXT,
  published_ms INTEGER,
  source_name  TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, url)
);

ALTER TABLE topics ADD COLUMN claimed_at TEXT;
```

- `(run_id, url)` is the primary key, so a retried gather re-inserts its own rows over
  themselves — requirement 7 for free. The PK's leading column is `run_id`, so
  `WHERE run_id = ?` needs no second index.
- `published_ms` is the parsed epoch-ms, `NULL` for an undated item. It exists so
  `shortlist` orders in SQL — see step 3.
- `created_at` makes pruning self-contained: it does not have to join `runs`, so a run
  that never wrote a `runs` row still gets its scratch rows collected.
- `ALTER TABLE` has no `IF NOT EXISTS` in SQLite, unlike everything in `0001`. That is
  fine and deliberate: `wrangler d1 migrations apply` records what it has run, `0002` has
  never been applied anywhere, and a hand-run second apply should fail loudly rather than
  look like a no-op.

**`src/lib/d1.ts`** — six new exports. Keep the file's existing shape: a doc comment per
export saying *why*, and no constant that belongs in `src/workflow.ts`.

```ts
export async function writeRunCandidates(
  db: D1Database,
  runId: string,
  sourceName: string,
  candidates: Candidate[],
): Promise<number>
```

Two statements in one `db.batch()`:

```sql
DELETE FROM run_candidates WHERE run_id = ? AND source_name = ?;

INSERT OR REPLACE INTO run_candidates (run_id, url, title, published_at, published_ms, source_name)
SELECT ?1,
       json_extract(value, '$.u'),
       json_extract(value, '$.t'),
       json_extract(value, '$.p'),
       json_extract(value, '$.m'),
       ?2
  FROM json_each(?3);
```

- Three bound parameters, any row count. This is what closes `spec.md`'s open
  query-budget question; the reasoning belongs in the doc comment, not only here.
- Short JSON keys (`u`/`t`/`p`/`m`) rather than `url`/`title`/…: the payload is machine-only
  and 352 candidates is a ~50 KB string either way, well inside D1's 2 MB value ceiling,
  but the shorter keys cost less to serialise and are what the reader is told to expect.
- The `DELETE` is scoped to `(run_id, source_name)`, **not** to `run_id` alone as
  `spec.md`'s prose reads — a `run_id`-wide delete in a per-feed step would wipe every
  earlier feed's rows. Scoping it is what makes the step idempotent without making it
  destructive. Say so in the doc comment.
- Returns `candidates.length`. Do not read `meta.changes`: `INSERT OR REPLACE` reports
  replacements too, and the caller wants the candidate count, not a row delta.
- `candidates.length === 0` returns `0` and still runs the `DELETE`, so a feed that went
  empty between attempts does not leave an earlier attempt's rows behind.

```ts
export async function readRunCandidates(db: D1Database, runId: string, limit: number): Promise<Candidate[]>
```

```sql
SELECT url, title, published_at, published_ms, source_name
  FROM run_candidates
 WHERE run_id = ?
 ORDER BY published_ms IS NULL, published_ms DESC
 LIMIT ?
```

One query. `published_ms IS NULL` first in the `ORDER BY` is SQLite's `NULLS LAST`: undated
items sort after dated ones, matching what `dateKey`'s `NEGATIVE_INFINITY` did in JS, so
they remain the first the cap drops.

```ts
export async function pruneRunCandidates(db: D1Database, retentionDays: number): Promise<void>
```

`DELETE FROM run_candidates WHERE created_at < datetime('now', '-' || ? || ' days')`.

```ts
export async function startRun(db: D1Database, instanceId: string): Promise<void>
export async function attachRunTopic(db: D1Database, instanceId: string, topicId: number): Promise<void>
export async function reclaimStaleTopics(db: D1Database, ttlHours: number): Promise<number>
```

- `startRun`: `INSERT OR IGNORE INTO runs (instance_id, status) VALUES (?, 'running')`.
  `INSERT OR IGNORE` on the `instance_id` primary key, so replay is safe and a completed
  run's row is never reset to `running` by a retried first step. `runs.status` has no
  `CHECK` constraint, so `'running'` needs no migration.
- `attachRunTopic`: `UPDATE runs SET topic_id = ? WHERE instance_id = ?`. Separate from
  `startRun` because the topic is not known until `select-topic` returns, and a run that
  dies in `gather` must still record *which* topic it stranded.
- `reclaimStaleTopics`: the `UPDATE` from `spec.md`, verbatim, returning
  `meta.changes ?? 0` so the caller can put it on a span.
- `claimRow`'s existing `UPDATE` gains `claimed_at = datetime('now')`. Its
  already-`in_progress` early return does **not** re-stamp: a retry recovering its own row
  must not extend the TTL of a claim it did not make.
- `TOPIC_COLUMNS` and the `Topic` type stay unchanged. `claimed_at` is never read into JS.

**`src/lib/types.ts`**: `Candidate` gains `publishedMs: number | null`.

### 3. `gather` returns a count — PR 3

This is the load-bearing PR. Requirements 4, 5, 6, 7.

**`src/lib/feed.ts`** — `applyGatherWindow` already calls `Date.parse` on every item and
throws the result away. Return it instead:

```ts
export function applyGatherWindow(
  items: FeedItem[],
  opts: { windowDays: number; undatedMax: number; now?: Date },
): WindowedItem[]
```

`publishedMs` is the parsed value for a dated item and `null` for an undated one. The
filtering logic is otherwise untouched — dated items filtered by window, undated kept in
feed order up to `undatedMax`, dated-but-stale dropped. `WindowedItem` goes in
`src/lib/types.ts` as `FeedItem & { publishedMs: number | null }`.

**`src/workflow.ts`**

```ts
export async function gatherCandidates(env: Env, runId: string, source: Source): Promise<number> {
  const items = await fetchFeedItems(source.feedUrl);
  const windowed = applyGatherWindow(items, {
    windowDays: GATHER_WINDOW_DAYS,
    undatedMax: GATHER_UNDATED_MAX_PER_FEED,
  });
  const candidates = windowed.map((item) => ({ ...item, sourceName: source.name }));
  return writeRunCandidates(env.DB, runId, source.name, candidates);
}
```

The existing "one dead feed must not fail the run" behaviour is unchanged: `fetchFeedItems`
already swallows fetch and parse failures and returns `[]`. A D1 write failure *does*
still fail the step, and should — that is not a dead feed, it is a dead database.

`run()`'s loop keeps an integer:

```ts
let gathered = 0;
for (const source of sources) {
  gathered += await traceStep(`gather:${source.name}`, {}, async (span) => {
    const count = await gatherCandidates(this.env, event.instanceId, source);
    span.setAttribute(ATTR_SOURCES_GATHERED, count);
    return count;
  });
}
```

`ATTR_SOURCES_GATHERED` keeps its name and stays an integer, so no `trace.ts` change and
no new attribute to allowlist. `gathered` is not read by anything downstream today; keep it
anyway and set it on the `shortlist` span — it is the number that makes acceptance
criterion 5 readable from the trace alone.

`shortlistCandidates` loses its array parameter and its JS sort:

```ts
export async function shortlistCandidates(env: Env, runId: string, topic: Topic): Promise<Candidate[]> {
  const capped = await readRunCandidates(env.DB, runId, SHORTLIST_MAX_CANDIDATES);
  const seen = await findSeenUrls(env.DB, capped.map((c) => c.url));
  const unseen = capped.filter((c) => !seen.has(c.url));
  return unseen
    .map((candidate) => ({ candidate, score: relevanceScore(candidate, topic) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST_TOP_N)
    .map((r) => r.candidate);
}
```

Delete `dateKey` — nothing else calls it. Its comment ("undated items sort last, so they
are the first the ceiling drops") moves to `readRunCandidates`'s `ORDER BY`.

Add, next to `GATHER_WINDOW_DAYS`:

```ts
/** Per-run scratch, not a dedupe key: `seen_urls` stays the only cross-run one. */
export const RUN_CANDIDATE_RETENTION_DAYS = 7;
```

Call `pruneRunCandidates(env.DB, RUN_CANDIDATE_RETENTION_DAYS)` inside `recordOutcome`,
after `recordRunOutcome`, so every terminal path prunes and none of them adds a step.

**`spec.md`** is corrected in this PR, per `REVIEW.md` pass 4:

- "Candidates in D1, not in `run()`": the `CREATE TABLE` gains `published_ms` and
  `created_at`; the chunked-write paragraph is replaced by the `json_each` statement and
  the probe that proves it; the delete is scoped to `(run_id, source_name)` with the
  reason.
- The two "open" entries in the risk table — `db.batch()` amortisation and `shortlist`'s
  own budget — become closed, each with what closed it. Neither is deleted: what was open
  and how it was settled is the record.

### 4. The `runs` row and the reclaim — PR 4

Requirements 8, 9, 10.

A new first step, before `select-topic`:

```ts
await traceStep('start-run', {}, async () => startRun(this.env.DB, event.instanceId));
```

`selectTopic` reclaims before it claims, and attaches the topic to the run row:

```ts
export async function selectTopic(env: Env, instanceId: string, topicId: number | undefined): Promise<Topic | null> {
  if (topicId !== undefined) {
    const named = await claimTopicById(env.DB, topicId);
    if (named !== null) await attachRunTopic(env.DB, instanceId, named.id);
    return named;
  }

  await reclaimStaleTopics(env.DB, TOPIC_CLAIM_TTL_HOURS);

  const queued = await claimOldestQueuedTopic(env.DB);
  if (queued !== null) {
    await attachRunTopic(env.DB, instanceId, queued.id);
    return queued;
  }

  const proposal = await proposeTopic(env);
  if (proposal === null) return null;
  const proposed = await findOrProposeTopic(env.DB, proposal);
  await attachRunTopic(env.DB, instanceId, proposed.id);
  return proposed;
}
```

The reclaim runs only on the scheduled path. A run that names a `topicId` is already the
manual recovery `spec.md` requirement 8 says exists; making it also reclaim other runs'
topics would widen a hand-triggered run's blast radius for no gain.

```ts
/**
 * How long a claim survives its claimant. Six hours against a run bounded by
 * 46 gather steps plus 15 article steps plus inference - minutes, not hours -
 * and a 48-hour cron gap: too long to race a live run, too short to strand a
 * topic across a cycle (spec.md req. 9, which asks for the margin to be stated
 * rather than implied).
 */
export const TOPIC_CLAIM_TTL_HOURS = 6;
```

### 5. The CPU premise — PR 5

Requirement 11, plus the fourth file this plan found.

The corrected rule, in the words each file needs:

> **10 ms of CPU per invocation.** A Workflow step is not a fresh budget: Workflows packs
> consecutive fast steps into one invocation and only the wall-clock cap is per step.
> Measured 2026-08-27 (#61): one feed parse passes, two pass, **three fail** with Workers
> error `1102`, all in one invocation. One feed per step is necessary but not sufficient —
> what a step buys is a *chance* of a fresh invocation, not a guarantee of one.

Then a mechanical check, because acceptance criterion 11 asks for a grep rather than a
hand-checked list of files, and a list goes stale:

- `scripts/review-checks.mjs`, new check `cpu-premise-is-per-invocation`, pass 1. Walks
  the tracked tree — `*.md` and `src/**/*.ts`, `features/002-*` excluded, since this
  feature's own artifacts quote the wrong premise in order to correct it — and fails on any
  line matching a CPU figure adjacent to "per step". Sentinel: it must find at least one
  line asserting the *right* rule, so a matcher that stops matching fails rather than
  passes vacuously, in the same style as the existing `>= 11` / `>= 8` sentinels.
- `scripts/review-checks.test.mjs`: mutation rows — reintroduce the stale phrasing in a
  markdown file, reintroduce it in a `.ts` comment, and remove the corrected assertion —
  each must go red. A row that passes with its guard removed is dead, and this one is
  verified by hand, not by the implementer's report.
- `REVIEW.md`: pass 1 gains the bullet and its `(mechanical: cpu-premise-is-per-invocation)`
  marker. `checks-and-docs-in-sync` fails otherwise, which is the point.

### 6. Bound the parse, or record that it does not pay — PR 6

Requirement 1. `Closes #61`.

**Measure first, cheaply, and stop.** Two implementations already measured *worse* than no
bound, and a third was inconclusive because harness variance had reached the size of the
effect (`spec.md`, "What bounding must not cost"). Two attempts, in this order:

1. **Re-run the `?upto=N` bench with accumulation gone.** PR 3 deletes the growth term, so
   the baseline should sit well above two feeds and *feeds survived, bounded vs unbounded,
   repeated* may be readable again in the unit the variance is measured in.
2. **Per-request CPU from `wrangler dev`'s local observability API** —
   `POST /cdn-cgi/local/explorer/api/local/observability/query`, `spans` table — read as a
   bounded-vs-unbounded **ratio**, never an absolute.

If neither yields a signal larger than its variance, requirement 1 is **dropped** and this
PR records the measurement and the decision. That is `spec.md`'s own stated fallback, not a
shortfall: requirement 4 removes the growth term independently, and the deferred
invocation-boundary lever is what replaces requirement 1 if acceptance criterion 5 still
fails.

If it is implemented, two constraints from `spec.md` are hard:

- **No second `Date.parse` per item.** PR 3 already threads the parsed value out of
  `applyGatherWindow`; the stop condition must use that, not re-parse.
- **The drain stays native.** `pipeTo(new WritableStream())` costs no per-chunk JS; a
  `getReader()` loop costs more than the tokenizing an early stop skips. Stopping early
  comes from cancelling the source — an `AbortController` on the fetch — not from JS
  deciding per chunk.

Plus `GATHER_STALE_RUN` and `GATHER_RAW_ITEM_MAX` in `src/workflow.ts`, and acceptance
criteria 2, 3 and 4: the differential test over all 46 live feeds, the undated fixture, and
the one-stale-item-then-fresh fixture.

## Reuse

- **`findSeenUrls` (`src/lib/d1.ts`)** — the chunked `seen_urls` batch stays exactly as it
  is. `shortlist` feeds it from D1 instead of from memory; the chunking is not
  reimplemented, and `SEEN_URLS_CHUNK_SIZE` / `SEEN_URLS_MAX_QUERIES` are not touched.
- **`claimRow` (`src/lib/d1.ts`)** — already the retry-safe claim, including recovery of an
  `in_progress` row. It gains a `claimed_at` stamp and nothing else; the reclaim is a
  separate statement, not a rewrite of the claim.
- **`recordRunOutcome`'s `ON CONFLICT(instance_id) DO UPDATE`** — already the right shape
  for a row that `startRun` created. It needs no change.
- **`tracerFor` / `traceStep`** — every new step goes through the binding, never a bare
  `step.do` (`REVIEW.md` pass 3, `rules/no-bare-step-do.yml`).
- **`ATTR_SOURCES_GATHERED`** — already an integer count. No new span attribute, so
  `trace.ts`'s allowlist and `span-attributes-allowlisted` are untouched.
- **`applyGatherWindow`** — stays the authoritative filter. `published_ms` is a value it
  already computes, surfaced; the bound in PR 6, if it happens, is a stopping condition
  layered on top and never a second filter.
- **`fetchFeedItems`** — already swallows a dead feed. `gatherCandidates` keeps using it
  rather than growing its own error handling.
- **`migrations/0001_init.sql`'s style** — `IF NOT EXISTS`, a comment saying why a column
  exists rather than what it is, and the schema transcribed from the spec rather than
  designed in the migration.

## Verification

### Per PR, before pushing

```bash
npm run typecheck
npm run lint:ast && npm run test:ast
npm run lint:ts
npm run review:checks && npm run test:checks
npm run test:plan-metrics
npx wrangler deploy --dry-run
```

The pre-push hook runs these; `branch-carries-issue` means they must run on a branch, not
on `main`. A clean baseline was recorded on `61-plan-md` at `c8bed71` so any later red is
attributable.

### The migration, applied

```bash
npm run migrate:local
npm run migrate:remote
npx wrangler d1 execute blog_research --remote --command \
  "SELECT name FROM pragma_table_info('run_candidates')"
npx wrangler d1 execute blog_research --remote --command \
  "SELECT name FROM pragma_table_info('topics') WHERE name = 'claimed_at'"
```

Seven columns and one `claimed_at` prove `0002` landed. **`migrate:remote` runs after the
stack merges, not before** — a schema the deployed Worker does not yet use is harmless, but
a Worker deployed against a schema that is not there is not.

### Each guard, by removing it

For every new mutation-table row in PR 5: delete the guard, confirm the row goes red,
restore it. A row that stays green with its guard removed is dead. This is done by hand and
reported as such, not taken from a subagent's summary (`CONVENTIONS.md`, "Model
delegation").

### Acceptance criteria, by number

| # | how it is proved | when |
|---|---|---|
| 1 | the command block above, on every PR | each PR |
| 2 | differential parse over 46 live feeds | PR 6, only if requirement 1 is implemented |
| 3 | undated fixture parses at most `GATHER_RAW_ITEM_MAX` | PR 6, same condition |
| 4 | one-stale-then-fresh fixture loses nothing | PR 6, same condition |
| 5 | **a real run against the deployed Worker**, 46 gathers, no `1102` | after the stack merges |
| 6 | `wrangler workflows instances describe <id>` shows integer `gather` outputs | with criterion 5 |
| 7 | shortlist from `run_candidates` matches the in-memory shortlist for the same inputs | PR 3 |
| 8 | re-trigger a gather step against an existing `run_id`; `SELECT count(*)` unchanged | PR 3 |
| 9 | a terminated instance's topic returns to `queued` after the TTL; a live one's does not | PR 4 |
| 10 | a terminated instance leaves a `runs` row that is not a success status | PR 4 |
| 11 | `cpu-premise-is-per-invocation` green, and its mutation rows red without it | PR 5 |

### The real run

```bash
npx wrangler workflows trigger research-workflow \
  '{"triggeredAt":"<utc-now>","topicId":1}'
npx wrangler workflows instances describe research-workflow <id>
```

Criterion 5 is the only thing that unblocks
[#64](https://github.com/nimeshjm/blog-research-agent/issues/64). Restoring the cron on
spec approval, or on the stack merging, just resumes the silent topic-eating on a schedule.
If the run fails it leaves topic 1 `in_progress`; with PR 4 merged that now heals itself
after `TOPIC_CLAIM_TTL_HOURS`, which is the first time this repo has had that property.

Timestamps: `wrangler` prints **local** time, not UTC. Cross-check against `date -u` and
against D1's own `created_at`, which is UTC.
