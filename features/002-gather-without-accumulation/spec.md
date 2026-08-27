# Spec: Gather without accumulation

> Stage 2. Written from `intent.md`. Requirements and design; no implementation detail.
> Tracking [#61](https://github.com/nimeshjm/blog-research-agent/issues/61).

## Summary

`gather` stops parsing feed archives it is going to throw away, and stops handing its
results back through `run()`. Each feed's parse is bounded by the recency window that
already governs the result, and each feed's candidates are persisted and counted rather
than returned and accumulated. Two smaller repairs travel with it: a claimed topic
becomes reclaimable, and a run that dies leaves a `runs` row behind.

## The measured facts this design is built on

All from Cloudflare egress (`wrangler dev --remote`, a Worker importing `src/lib/feed.ts`
unmodified and streaming the live `Response` into `parseFeed`, as `fetchFeedItems` does),
2026-08-27. Reproduced in the tracking issue.

| feed | bytes | raw items | items inside the 30-day window |
|---|---|---|---|
| arXiv cs.SE | 22 KB | 41 | 41 |
| arXiv cs.AI | 743 KB | 352 | 352 |
| OpenAI | 702 KB | 1154 | 62 |
| Cloudflare | 296 KB | 20 | 20 |
| GitHub | 173 KB | 10 | 10 |

Each parses alone. Replicating `run()`'s gather loop in one invocation:
one feed ✅, two feeds ✅ (393 candidates accumulated), **three feeds ❌ `error code:
1102`** — the Workers CPU-limit error. Production reached six steps before failing, so a
step boundary buys *something*; it does not buy a fresh 10 ms per step.

The OpenAI row is the shape of the waste: **1,154 items parsed to keep 62** — 19x.

## Requirements

1. **The parse is bounded by the window.** `gather` stops reading a feed once the feed
   has demonstrably passed out of `GATHER_WINDOW_DAYS`, and cancels the response body
   rather than draining it. **That this pays for itself is not yet established** — see
   "What bounding must not cost" below. If measurement says it does not, requirement 4 and
   the deferred invocation-boundary lever carry the feature and this requirement is
   dropped rather than implemented on faith.
2. **Bounding must not change the result.** For every feed in `config/feeds.json`, the
   bounded parse yields a byte-identical candidate set to the unbounded parse. This is
   the load-bearing requirement: the bound is an optimisation, and an optimisation that
   silently drops an article is worse than the bug it fixes.
3. **A feed with no usable dates is still bounded.** The early stop keys on dated items;
   a wholly undated feed must hit a hard ceiling on raw items parsed instead, so no feed
   can be unbounded by accident.
4. **`gather` returns a count, not candidates.** A gather step persists its candidates
   and returns an integer. `run()` holds no array that grows with the number of feeds,
   so replay cost does not grow with the number of completed gathers.
5. **`shortlist` reads candidates from D1**, scoped to the current run, and produces the
   same shortlist it produces today from the in-memory array.
6. **Persisting candidates stays inside D1's budget**: 100 bound parameters per query and
   50 queries per invocation, on the assumption that up to three gather steps may share
   one invocation (measured above). `gather:arXiv cs.AI`'s 352 candidates is the number
   to size against — it is a legitimate full arXiv announcement day and must not be
   truncated (feature 001 `spec.md`, "The recency window in `gather`").
7. **Candidate persistence is idempotent.** A retried gather step leaves the same rows,
   not duplicates.
8. **A claimed topic is reclaimable by an unattended run.** A topic left `in_progress` by
   a dead instance becomes selectable again after `TOPIC_CLAIM_TTL`, without a webhook, a
   second schedule, or manual SQL. "Unattended" is the precise scope: `claimRow`
   (`src/lib/d1.ts:44`) *does* already recover an `in_progress` row — but only for a run
   that names it via `ResearchParams.topicId` (`src/workflow.ts:299`), i.e. one triggered
   by hand. The scheduled path reaches only `queued` rows, so today a stranded topic waits
   for a human who knows to pass its id.
9. **Reclaim cannot steal a live run's topic.** `TOPIC_CLAIM_TTL` exceeds the longest
   legitimate run by a margin that is stated, not implied.
10. **Every run writes a `runs` row, including one that dies mid-step.** The row is
    created when the run starts and updated with its outcome, so a hard step failure is
    distinguishable after the fact from a cycle with nothing to write about. This
    replaces feature 001 requirement 9, which the dead run of 2026-08-27 violated.
11. **The corrected CPU rule is recorded, in all three places that assert it.** Replaced
    with whatever implementation measures, in the same pull request as the code:
    - `CLAUDE.md:62` — "**10 ms CPU per step.**"
    - `features/001-scheduled-research-drafts/spec.md` — :64, :295, :383, and the
      constraints-table row at :463.
    - `.claude/skills/cf-free-tier/SKILL.md` — **the one that matters most**, because it is
      the file loaded when someone writes a new step. It already carries both halves of the
      contradiction adjacently (`:15` "10 ms per invocation" directly above `:16` "10 ms per
      step") and then asserts at `:35` that "A Workflow step gets its own 10 ms and
      unlimited wall-clock."

    A design premise this wrong, left in place, produces the same bug again — and correcting
    the two prose files while leaving the skill intact is the version of that failure that
    looks fixed.
12. **No change to which drafts are opened.** The recency window, grounding gate,
    `draft: true`, branch-only rule, neuron ceiling, and shortlist ranking are untouched.

## Design

### Bounding the parse

The window cutoff moves *into* the parse as a stopping condition, while
`applyGatherWindow` stays the authoritative filter. The bound never decides what is
kept — it only decides when to stop reading — which is what makes requirement 2 testable
by differential comparison rather than by inspection.

Every allowlisted feed lists newest first (asserted in feature 001 `spec.md`). That
assertion is load-bearing here in a way it was not before, so it is not trusted
unconditionally: the stop fires only after `GATHER_STALE_RUN` consecutive *dated* items
fall outside the window, so a single out-of-order stale item cannot end the parse. Undated
items neither increment nor reset the counter — they are governed by
`GATHER_UNDATED_MAX_PER_FEED`, which already exists.

Two bounds, both required:

| bound | fires on | purpose |
|---|---|---|
| `GATHER_STALE_RUN` consecutive out-of-window dated items | archives (OpenAI: 1154 → ~10 read) | the actual saving |
| `GATHER_RAW_ITEM_MAX` raw items | a feed with no parseable dates | requirement 3's backstop |

On either bound the response body is **cancelled**, not drained. `parseFeed` currently
finishes with `pipeTo(new WritableStream())`; a bound that stops accumulating but keeps
tokenizing saves nothing, because tokenizing is the cost.

`GATHER_STALE_RUN` and `GATHER_RAW_ITEM_MAX` are named constants in `src/workflow.ts`
alongside `GATHER_WINDOW_DAYS`, passed into the parser. `src/lib/feed.ts` defines neither,
consistent with how it already treats the window constants.

#### What bounding must not cost

Two implementations were measured against a patched copy of `src/lib/feed.ts` under
`wrangler dev --remote` (issue #61, comment of 2026-08-27) and **both were worse than no
bound at all**: bookkeeping alone dropped the loop from two feeds to one, and adding a JS
`getReader()` loop dropped it to failing on the first feed. Two causes, both avoidable and
both now constraints on the implementation:

- **No second `Date.parse` per item.** `applyGatherWindow` already parses every item's
  date. A staleness check that parses again doubles exactly the per-item work the bound
  exists to avoid; the parsed value has to be threaded through, not recomputed.
  `applyGatherWindow` now returns the epoch-ms it parses on each item (`WindowedItem`,
  `publishedMs`), so this requirement's mechanism already exists — a bounded parse
  implementing requirement 1 has a value to read rather than one to add.
- **The drain stays native.** `pipeTo(new WritableStream())` costs no per-chunk JS.
  Replacing it with a read loop costs more than the tokenizing an early stop skips.
  Stopping early has to come from cancelling the source (an `AbortController` on the
  fetch), not from JS deciding per chunk whether to continue.

A third variant doing both correctly was inconclusive: by then the harness's own variance
was about one feed wide — the same size as the effect. **So this cannot be settled by
pass/fail against the CPU limit.** It needs per-request CPU numbers; `wrangler dev`'s local
observability API (`POST /cdn-cgi/local/explorer/api/local/observability/query`, `spans`
table) is the instrument, read as a bounded-vs-unbounded ratio rather than as an absolute.

### Candidates in D1, not in `run()`

New table, migration `0002`:

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
```

`(run_id, url)` as the primary key is what makes requirement 7 free: a retried gather
step re-inserts its own rows over themselves. `run_id` is the Workflow instance id, the
same key `runs` uses, so a run's candidate set is addressable without a join.

`published_ms` is the epoch-ms `applyGatherWindow` already parses per item, carried
through rather than recomputed, so `shortlist` can order newest-first in SQL instead of
re-parsing every candidate's date in JS. `created_at` is what makes pruning
self-contained: it compares a timestamp rather than joining `runs`, so a run that died
before ever writing a `runs` row still gets its scratch rows collected.

Flow, per feed: fetch → bounded parse → `applyGatherWindow` → write in one statement →
return `count`. `run()` keeps only the running total.

`shortlist` reads `WHERE run_id = ?` — one query, no bound-parameter pressure, because the
row count lives in the result set rather than in the statement. This is a straight
improvement on today's chunked `seen_urls` batch, which stays as it is.

**The query-budget question was open and is now closed, by measurement rather than by
reading the limit.** Five columns at 100 bound parameters would be 20 rows per statement,
so arXiv cs.AI's 352 candidates would need 18 statements; three such steps sharing an
invocation would exceed 50. That arithmetic assumed one bound parameter per column per
row. D1 supports SQLite's `json1` extension instead: a whole feed's candidates are written
by **one statement with three bound parameters**, whatever the row count, by unpacking a
single JSON array parameter with `json_each` inside SQLite rather than binding a parameter
per cell. Probed against the real `blog_research` database, 2026-08-27:

```
npx wrangler d1 execute blog_research --remote \
  --command "SELECT json_extract(value,'\$.url') AS url FROM json_each('[{\"url\":\"a\"},{\"url\":\"b\"}]')"
→ [{"url":"a"},{"url":"b"}]   success: true, rows_read: 2
```

So a gather step costs exactly two of the invocation's 50 queries (one `DELETE`, one
`INSERT ... SELECT ... FROM json_each`) whatever the feed's size — three gather steps
sharing an invocation cost 6 of 50, not 57. arXiv cs.AI's 352-candidate day is written
whole in that one statement, which is what requirement 6 forbids trading away.

Retention: a run deletes its own `(run_id, source_name)` rows before writing them —
scoped to the feed the step is writing, not to `run_id` alone, because a `run_id`-wide
delete inside a per-feed step would wipe every earlier feed's rows written by the same
run. This is what makes the step idempotent under replay without being destructive to
sibling feeds. Rows for runs older than `RUN_CANDIDATE_RETENTION_DAYS` are pruned in the
same step that records the outcome. `seen_urls` remains the cross-run dedupe key;
`run_candidates` is per-run scratch and must not become a second one.

### Reclaiming a stranded topic

`topics` gains `claimed_at TEXT` (migration `0002`). `claimTopic` sets it. Selection
becomes: reclaim first, then claim.

```sql
UPDATE topics SET status = 'queued', claimed_at = NULL
 WHERE status = 'in_progress'
   AND claimed_at IS NOT NULL
   AND claimed_at < datetime('now', '-' || ? || ' hours');
```

`TOPIC_CLAIM_TTL = 6 hours`. The margin is explicit both ways: the longest legitimate run
is bounded by 46 gather steps plus 15 article steps plus inference, minutes rather than
hours, and the cron gap is 48 hours — so 6 hours cannot reclaim a live run's topic and
cannot leave a topic stranded across a cycle. A row with `claimed_at IS NULL` is a
pre-migration claim and is left alone rather than guessed at.

### The `runs` row

Today `recordOutcome` writes the row at the end, so a run that dies writes nothing. The
row is instead created in the run's first step with status `running` (`INSERT OR IGNORE`
on the `instance_id` primary key, so replay is safe) and updated by `recordOutcome`. A
`running` row with an old `started_at` is then the durable signal that a run died — the
same signal `TOPIC_CLAIM_TTL` acts on, from the other side.

**Measured, and worse than "a run that dies writes nothing" suggests:** `SELECT count(*)
FROM runs` on the remote database returns **0**, and `wrangler workflows instances list`
shows **two** instances, both failed:

| instance | trigger | outcome |
|---|---|---|
| `8808602a` (27/08 06:00 UTC) | cron | `NotImplemented: selectTopic`, 6 attempts |
| `956de9f8` (27/08 16:11 UTC) | api | `Worker exceeded CPU time limit` in `gather:GitHub`, 5 attempts |

So feature 001 requirement 9 ("every run writes exactly one row to `runs`, whatever the
outcome") has **never once held**, and the reason it went unnoticed is exactly the reason
this requirement exists: with no row, a failed run is invisible unless someone thinks to
list Workflow instances. The two failures are also unrelated to each other — the first was
an unimplemented `selectTopic` in the then-deployed version — which is the point: the
`runs` table is meant to be where that distinction is legible after the fact.

## Platform constraints applied

| Constraint | How this design respects it |
|---|---|
| Workers CPU limit — **per invocation, not per step** (measured: 2 feeds pass, 3 fail) | The dominant cost, feed-archive parsing, is cut at the source: OpenAI 1154 items → ~10 read. Accumulation in `run()` is removed so replay cost is flat in the number of completed gathers |
| 50 subrequests per step | Unchanged: one fetch per gather step |
| D1 100 bound params/query, 50 queries/invocation | Requirement 6, sized against arXiv cs.AI's 352 candidates and up to 3 gather steps per invocation; `shortlist` moves from a chunked batch to one scoped read |
| 1,024 steps per instance | Step count unchanged (~67) |
| 10,000 neurons/day | Unchanged — this feature adds no inference |
| Steps are retried | `(run_id, url)` primary key; `INSERT OR IGNORE` on `runs`; delete-then-write per feed |
| Cron 15 min wall-clock | Unchanged: cron only creates the instance |

## Acceptance criteria

1. `npx wrangler deploy --dry-run` resolves every binding; `npm run typecheck`,
   `lint:ast`, `lint:ts`, `review:checks` and every mutation table pass.
2. **Differential parse test**: for all 46 feeds, bounded and unbounded parses produce
   identical candidate sets. This runs against live feeds and is the test that fails if
   the newest-first assumption is wrong for any source.
3. A feed fixture with no parseable dates parses at most `GATHER_RAW_ITEM_MAX` raw items.
4. A feed fixture with one stale item followed by fresh ones loses nothing — the stop
   requires `GATHER_STALE_RUN` consecutive stale dated items.
5. A full run against the deployed Worker completes through `shortlist` with all 46
   feeds gathered, and no step reports `Worker exceeded CPU time limit`. This is the
   criterion the 2026-08-27 run failed.
6. `gather` step outputs in the Workflow instance view are integers, not candidate
   arrays.
7. The shortlist produced from `run_candidates` is identical to the shortlist the
   in-memory array produces for the same inputs.
8. A gather step re-run against an already-written `run_id` leaves the row count
   unchanged.
9. A terminated instance's topic returns to `queued` on its own after
   `TOPIC_CLAIM_TTL`, and a topic claimed by a run still in flight does not.
10. A terminated instance leaves a `runs` row whose status is not a success status.
11. `CLAUDE.md`, feature 001 `spec.md`, and `.claude/skills/cf-free-tier/SKILL.md` no
    longer assert a per-step CPU budget, and the number they assert instead is one this
    feature measured. Grepping the tree for "per step" alongside a CPU figure returns
    nothing stale.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A feed is not newest-first and the bound drops articles | The whole point of acceptance criterion 2 — differential over all 46 feeds, against live responses. `GATHER_STALE_RUN` tolerance absorbs local disorder; a feed that genuinely interleaves fails the test and is a finding against the allowlist, not a reason to loosen the bound |
| A feed reorders *later*, after the test passed | The differential test is cheap and feed-only. It belongs on the same review cadence as the allowlist audit feature 001 already asks for. Consequence is bounded: a dropped article is a missed candidate, never a wrong draft |
| `db.batch()` does not amortise against the 50-query budget | Resolved: D1's `json1` support means the write never needed per-row amortisation in the first place — one statement with three bound parameters (`json_each` unpacking a single JSON array) handles any row count, so the stated fallback (a per-invocation statement ceiling, remainder deferred) was never needed |
| Bounding the parse costs more than it saves | Measured for two implementations, and it did (#61). The two causes are named as implementation constraints under "What bounding must not cost", and requirement 1 is explicitly droppable if per-request CPU measurement does not support it. The feature does not depend on it: requirement 4 removes the growth term independently |
| Bounding the parse is not enough on its own | It attacks the dominant measured cost, and requirement 4 attacks the growth term independently. If a full 46-feed run still fails, the remaining lever is forcing an invocation boundary per gather step, which is why acceptance criterion 5 is a real run rather than a bench |
| `run_candidates` becomes a second cross-run dedupe key | It is per-run scratch, pruned, and `shortlist` reads it scoped to `run_id`. `seen_urls` stays the only cross-run key |
| Reclaim races a live run | `TOPIC_CLAIM_TTL` of 6 hours against a minutes-long run and a 48-hour cron gap; both margins stated in the design rather than left to be inferred |
| `shortlist`'s scoped read relocates the problem rather than removing it | Substantially reduced, not eliminated. The cap and ordering moved into SQL via `published_ms` (`readRunCandidates`'s `LIMIT`/`ORDER BY`), so `shortlist` does zero `Date.parse` calls where it did up to 678 before. It still materializes the capped set — up to `SHORTLIST_MAX_CANDIDATES` candidates — in one step and ranks it in JS, so the risk is not gone: acceptance criterion 5, a real run, is still the check that decides whether that remaining JS work fits |
| The prose is corrected and the skill is not | The skill is what an author loads before writing a step, so a stale premise there survives every correction elsewhere and is re-derived on the next feature. Requirement 11 names it explicitly and acceptance criterion 11 greps for the stale phrasing rather than checking the three files by hand |
| The corrected CPU rule is itself wrong | It is measured and the measurement is recorded with it. The failure mode being avoided is an *unmeasured* number derived from documentation, which is what produced this feature |

## Deferred

- **Forcing an invocation boundary per gather step** (e.g. `step.sleep`) — the heavier
  lever, and **more likely to be load-bearing than this spec first assumed**, now that
  bounding the parse has failed twice in measurement. Still deferred rather than adopted:
  it costs wall-clock on every run, and acceptance criterion 5 is what decides. If
  requirement 1 is dropped, this is what replaces it.
- **Curating the allowlist down** — would hide the shape rather than fix it
  (`intent.md`, non-goals).
- **A conditional-request cache** (`ETag` / `If-Modified-Since` per feed) — would cut
  work further on unchanged feeds, but adds cross-run state and is a different feature.
- **Alerting on a died run** — requirement 10 makes it *recordable*; telling anyone is
  out of scope per `intent.md`.
