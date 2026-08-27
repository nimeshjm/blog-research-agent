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
| OpenAI | 702 KB | 1154 | ~5 |
| Cloudflare | 296 KB | 20 | 20 |
| GitHub | 173 KB | 10 | 10 |

Each parses alone. Replicating `run()`'s gather loop in one invocation:
one feed ✅, two feeds ✅ (393 candidates accumulated), **three feeds ❌ `error code:
1102`** — the Workers CPU-limit error. Production reached six steps before failing, so a
step boundary buys *something*; it does not buy a fresh 10 ms per step.

The OpenAI row is the shape of the waste: **1,154 items parsed to keep about five.**

## Requirements

1. **The parse is bounded by the window.** `gather` stops reading a feed once the feed
   has demonstrably passed out of `GATHER_WINDOW_DAYS`, and cancels the response body
   rather than draining it.
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
8. **A claimed topic is reclaimable.** A topic left `in_progress` by a dead instance
   becomes selectable again after `TOPIC_CLAIM_TTL`, without a webhook, a second
   schedule, or manual SQL.
9. **Reclaim cannot steal a live run's topic.** `TOPIC_CLAIM_TTL` exceeds the longest
   legitimate run by a margin that is stated, not implied.
10. **Every run writes a `runs` row, including one that dies mid-step.** The row is
    created when the run starts and updated with its outcome, so a hard step failure is
    distinguishable after the fact from a cycle with nothing to write about. This
    replaces feature 001 requirement 9, which the dead run of 2026-08-27 violated.
11. **The corrected CPU rule is recorded.** `CLAUDE.md`'s "10 ms CPU per step" and
    feature 001 `spec.md`'s constraints-table row are both replaced with whatever
    implementation measures, in the same pull request as the code. A design premise this
    wrong, left in place, produces the same bug again.
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

### Candidates in D1, not in `run()`

New table, migration `0002`:

```sql
CREATE TABLE IF NOT EXISTS run_candidates (
  run_id       TEXT NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT,
  published_at TEXT,
  source_name  TEXT NOT NULL,
  PRIMARY KEY (run_id, url)
);
```

`(run_id, url)` as the primary key is what makes requirement 7 free: a retried gather
step re-inserts its own rows over themselves. `run_id` is the Workflow instance id, the
same key `runs` uses, so a run's candidate set is addressable without a join.

Flow, per feed: fetch → bounded parse → `applyGatherWindow` → attach `sourceName` →
write chunked → return `count`. `run()` keeps only the running total.

`shortlist` reads `WHERE run_id = ?` — one query, no bound-parameter pressure, because the
row count lives in the result set rather than in the statement. This is a straight
improvement on today's chunked `seen_urls` batch, which stays as it is.

**The query-budget question is open and must be settled by measurement, not by reading
the limit.** Five columns at 100 bound parameters is 20 rows per statement, so arXiv
cs.AI's 352 candidates needs 18 statements; three such steps sharing an invocation would
exceed 50. Whether `db.batch()` amortises a batch to one query against that budget is
**not** established here. If it does not, the fallback is a stated per-invocation
statement ceiling with the remainder deferred to the next step, not a truncated arXiv day
— requirement 6 forbids trading the day away.

Retention: a run deletes its own `run_id` rows before writing them (making the step
idempotent under replay from an earlier attempt's partial write), and rows for runs older
than `RUN_CANDIDATE_RETENTION_DAYS` are pruned in the same step that records the outcome.
`seen_urls` remains the cross-run dedupe key; `run_candidates` is per-run scratch and must
not become a second one.

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
11. `CLAUDE.md` and feature 001 `spec.md` no longer assert a per-step CPU budget, and
    the number they assert instead is one this feature measured.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A feed is not newest-first and the bound drops articles | The whole point of acceptance criterion 2 — differential over all 46 feeds, against live responses. `GATHER_STALE_RUN` tolerance absorbs local disorder; a feed that genuinely interleaves fails the test and is a finding against the allowlist, not a reason to loosen the bound |
| A feed reorders *later*, after the test passed | The differential test is cheap and feed-only. It belongs on the same review cadence as the allowlist audit feature 001 already asks for. Consequence is bounded: a dropped article is a missed candidate, never a wrong draft |
| `db.batch()` does not amortise against the 50-query budget | Named as open in the design; the fallback (a per-invocation statement ceiling, remainder deferred) is stated so implementation cannot quietly choose truncation instead |
| Bounding the parse is not enough on its own | It attacks the dominant measured cost, and requirement 4 attacks the growth term independently. If a full 46-feed run still fails, the remaining lever is forcing an invocation boundary per gather step, which is why acceptance criterion 5 is a real run rather than a bench |
| `run_candidates` becomes a second cross-run dedupe key | It is per-run scratch, pruned, and `shortlist` reads it scoped to `run_id`. `seen_urls` stays the only cross-run key |
| Reclaim races a live run | `TOPIC_CLAIM_TTL` of 6 hours against a minutes-long run and a 48-hour cron gap; both margins stated in the design rather than left to be inferred |
| The corrected CPU rule is itself wrong | It is measured and the measurement is recorded with it. The failure mode being avoided is an *unmeasured* number derived from documentation, which is what produced this feature |

## Deferred

- **Forcing an invocation boundary per gather step** (e.g. `step.sleep`) — the heavier
  lever. Not adopted pre-emptively: it costs wall-clock on every run and acceptance
  criterion 5 will say whether it is needed.
- **Curating the allowlist down** — would hide the shape rather than fix it
  (`intent.md`, non-goals).
- **A conditional-request cache** (`ETag` / `If-Modified-Since` per feed) — would cut
  work further on unchanged feeds, but adds cross-run state and is a different feature.
- **Alerting on a died run** — requirement 10 makes it *recordable*; telling anyone is
  out of scope per `intent.md`.
