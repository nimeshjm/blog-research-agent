# Spec: Run to completion

> Stage 2. Written from `intent.md`, approved at
> [#76](https://github.com/nimeshjm/blog-research-agent/issues/76) (closed `COMPLETED`).
> Tracking [#75](https://github.com/nimeshjm/blog-research-agent/issues/75).

## Summary

A run gathers all 46 feeds and reaches `shortlist` without any step reporting `Worker
exceeded CPU time limit`, and does so repeatedly rather than once. Two changes get it
there, and they are not the same change: **step retries are turned off**, because a
retry provably inherits the exhausted budget that failed the first attempt and buys only
five minutes of backoff; and **gather is split across child Workflow instances**,
because a child instance is the only remaining candidate for a fresh CPU budget after
`step.sleep` was measured not to be one.

**"Never retry" is a directive from the requester**, recorded here so a reviewer can
reject it cheaply if it has been read too broadly. It is taken to mean: no `step.do`
retry policy anywhere in this Worker — a failing step fails the run immediately instead
of retrying. It is not read as forbidding a future feature from re-running a whole run.

**Turning retries off does not by itself complete a run.** It converts five slow minutes
into an immediate failure, which is an improvement in honesty and in wasted wall-clock,
and no improvement at all in reach. The intent's Outcome is 46 feeds reaching
`shortlist`; requirement 2 below is what delivers that, and requirement 1 is what stops
the failure mode being disguised while it is worked on.

## The measured facts this design is built on

All from the probe committed at `probe/` and its captures at `probe/captures/`, run
against the deployed `research-probe` Worker on **2026-08-28** and torn down afterwards.
Every step returned `{r, iso, seq, ms}`: `r` generated at the top of `run()`, `iso` module
scope, `seq` a module-scope counter. Nine instances, read back with `wrangler workflows
instances describe`.

| run | mode | outcome | `run()` executions | boundaries in 45 crossings |
|---|---|---|---|---|
| `52a3a5b6` | 46 feeds | ✅ all 46 | 1 | 0 |
| `b7f6c1bf` | 46 feeds | ✅ all 46 | 1 | 0 |
| `ee0d3042` | 46 feeds | ✅ all 46 | **6** | 5 |
| `e381a65f` | 46 feeds | ❌ `1102` at feed 11 | 1 | 0 |
| `3b78558c` | 46 feeds | ❌ `1102` at feed 10 | 1 | 0 |
| `523c1723` | sleep 1 s per feed | ✅ all 46 | 6 | 5 |
| `aaddf4f9` | sleep 60 s per feed | ✅ all 46, **46 min** | **1** | **0** |

1. **The failure is not deterministic.** Five identical 46-feed runs inside one hour:
   three completed, two failed around feed 10. Same feeds, same order, same version id,
   which both failed and succeeded.
2. **Invocation boundaries exist but arrive unbidden.** `ee0d3042` carried six distinct
   `r` under one `iso` with `seq` contiguous 0–45: `run()` re-entered five times with no
   isolate change. Nothing in the design asked for that and nothing predicts it.
3. **`step.sleep` does not cause one.** Across both sleep runs, 85 of 90 crossings show
   the same `r`, same `iso`, next `seq`, and `ms` grown by the sleep's own duration — an
   in-process `await`. The five real boundaries in the 1 s run fall at the same step
   indices a no-sleep control's do. The 60 s run bought **zero** boundaries in 45
   crossings, fewer than the no-sleep control.
4. **A retry inherits the exhausted budget.** In the retry probe, after two failures and
   35 s of backoff the succeeding attempt carried the same `r`, the same `iso`, and
   `seq: 2` — the very next value. In production, `gather:The Pragmatic Engineer` failed
   six times with an identical `1102` across five minutes.
5. **An instance survives at least 46 minutes on one `run()` clock.** `aaddf4f9` reported
   `ms: 2,708,901` on its last gather step. `intent.md` records that this repo has no
   number and no citation for the instance lifetime ceiling; this is a measured **floor**
   under it, not the ceiling.
6. **The feed that fails is not expensive.** The Pragmatic Engineer completes at position
   1 in 416 ms wall with 10 candidates, and failed six times at position 10.

**Not measured, and not to be assumed:** any CPU figure. The probe reads none. Every
finding above is ordinal or structural. The intent's open question about per-feed CPU
cost is therefore **still open** after this spec, and requirement 6 is written so the
design does not depend on closing it.

Feed volumes are perishable — arXiv cs.SE returned 41 raw items on 2026-08-27 and 65 on
2026-08-28 — so every number here carries its date and none is re-derivable.

## Requirements

1. **No step is retried.** `step.do` is invoked with a retry policy of zero attempts
   beyond the first, everywhere in the Worker. A step that throws fails its instance
   immediately.
2. **Gather runs in child Workflow instances**, not in the parent's own `run()`. The
   parent creates children, waits for them, and reads their results; no feed is parsed in
   the parent invocation.
3. **A child instance parses at most `GATHER_FEEDS_PER_CHILD` feeds**, a value in
   `wrangler.toml` and nowhere else, sized so that a child completes with margin against
   the observed failure range rather than at its edge.
4. **A failed child fails the run**, visibly. It does not silently contribute zero
   candidates. This is the deliberate opposite of the dead-feed rule, which stays: a feed
   that cannot be fetched still contributes zero without failing anything.
5. **The parent's own CPU cost does not grow with the number of children.** It holds
   counts, never candidates — the same rule feature 002 applied to `gather` within one
   instance, applied again one level up.
6. **The design does not depend on where the failure boundary falls.** Requirement 3's
   value may be tuned from measurement, but no requirement here asserts that N feeds fit
   and N+1 do not. The failure is not deterministic (fact 1), so any design keyed to a
   fixed reach is keyed to a coin.
7. **Candidate writes stay idempotent**, and `run_candidates`' `(run_id, url)` primary
   key stays load-bearing. Turning retries off removes one reason for idempotency but not
   the other: `run()` demonstrably re-executes (fact 2), and although a completed step's
   body does not re-run, nothing in this repo has measured what a *child* instance
   re-executes.
8. **A run that dies still leaves a `runs` row and frees its topic**, exactly as feature
   002 specified. Nothing here regresses that.

## Design

### Turning retries off, at the one seam that exists

`rules/no-bare-step-do.yml` permits `step.do(` in `src/lib/trace.ts` only, scoped to
`src/**`. `tracedStep` (`src/lib/trace.ts`) is therefore the single call site, and it
passes no options today:

```ts
return step.do(name, () => traced(name, { ...attrs, [ATTR_STEP]: stepAttr }, body));
```

The retry policy threads through there and nowhere else. This is one edit, not
forty-six, and the ast-grep rule is what keeps it that way — a future bare `step.do`
would bypass the policy silently, and the rule already fails the build on it.

**Why zero rather than a smaller number.** Fact 4 is not "retries are usually wasteful
here"; it is that the retry ran in the same `run()` execution with the same module-scope
counter, so it cannot have had a fresh budget. For a CPU failure, retry is not a slow
recovery path, it is not a recovery path. For a transient network failure it would still
be one, but `fetchFeedItems` already swallows those and returns `[]`, so the step does
not throw and there is nothing to retry.

**What this costs, stated plainly.** A genuinely transient failure that today survives on
attempt two will fail the run instead. The gather path is insulated from that by
`fetchFeedItems`; the D1 and GitHub paths are not. That is the trade the directive makes
and it should be re-examined if a run starts failing on a step that would have recovered.

**Which reading of `limit` held — measured 2026-08-31, after PR #82 deployed.**
`plan.md` question 2 recorded an ambiguity the docs do not settle: `limit` is "the total
number of attempts to make for a step" on one page and "maximum number of retries per
step" on another, and under the first reading `0` would mean the step never runs at all.
It is the second. Two probe instances triggered within a second of each other
(`probe/FINDINGS.md` §7, captures `3f5770ac` and `f95f58da`):

| | `{ retries: { limit: 0, delay: 0 } }` | platform default (control) |
|---|---|---|
| the two steps before the failing one | both completed | both completed |
| attempt rows on the failing step | **1** | **3** |
| instance | errored in 0 s | completed after 30 s of backoff |

The markers completing is what rules out the "total attempts" reading; one row against
three is the policy being honoured. **The recorded fallback to `{ limit: 1, delay: 0 }`
is not needed and is withdrawn.**

**And it covers a `1102`, not only a thrown error.** Four probe instances made to exceed
the CPU limit deliberately (`FINDINGS.md` §7.2, `da873328` / `b292794e` / `0c23546e` /
`a32b6d53`) each produced exactly one attempt row and errored the instance. That is the
case requirement 1 exists for. The default-config control did not reproduce — it took one
attempt and then sat `Running` — so this measures what the policy does, not what the
default would have done.

This is still *not* acceptance criterion 4, which names `research-workflow` itself.
Criterion 4 stays open for PR 5's captures.

### Gather in child instances

The parent workflow keeps `select-topic`, `load-sources`, `shortlist`, synthesis and the
pull request. It no longer parses feeds. Instead:

```
parent  ──create──▶  child 1   feeds 0..N-1    → writes run_candidates, returns a count
        ──create──▶  child 2   feeds N..2N-1   → ...
        ──await───▶  reads each child's status and count
        ──▶ shortlist reads run_candidates for this run_id, as it already does
```

Each child is a Workflow instance in its own right, so it has its own invocation lineage
and its own `run()`. That is the entire reason for the shape: a child is the only
remaining candidate for a fresh CPU budget now that `step.sleep` is measured not to be
one (fact 3) and a retry is measured not to be one (fact 4).

Children write to `run_candidates` under the parent's `run_id`, which is already the
schema feature 002 built, so `shortlist` is unchanged. A child returns a count; the
parent sums counts. Requirement 5 is satisfied by construction because a count is an
integer.

**The parent waits by polling child status in a step**, not by holding a promise across
`run()` — `run()` re-executes and a promise would not survive it. Polling is one
subrequest per child per poll and the parent's steps carry no parse cost.

### What is deliberately not decided here

`GATHER_FEEDS_PER_CHILD` gets a number in `plan.md`, from measurement, not here. The
observed failure range is feeds 10–11 across two failing runs, and three runs completed
46, so the honest statement is that the range is wide and the value must be chosen with
margin rather than fitted to two data points.

## Platform constraints applied

| constraint | how this design respects it |
|---|---|
| **CPU is charged per invocation and a step boundary is not a reset** | The design stops relying on boundaries arriving. A child instance is a new invocation lineage by construction rather than by hope. |
| **10,000 neurons/day** | Unchanged. Children do no inference; `NEURON_BUDGET_PER_RUN` and `neuronsFor()` stay in the parent. |
| **50 subrequests per step** | One fetch per feed per step is unchanged. Parent polling adds one subrequest per child per poll, in the parent's own steps. |
| **1,024 steps per instance** | Improved, not worsened: the parent sheds 46 gather steps and gains roughly `46 / GATHER_FEEDS_PER_CHILD` create-and-poll steps. Each child holds its own budget. |
| **Instance lifetime** | Still uncited (`intent.md` open question). Measured floor of ≥46 minutes (fact 5). A child's lifetime is a fraction of a parent's, so the design moves away from the ceiling rather than toward it. |
| **Cron wall-clock 15 min** | Not binding: orchestration remains a Workflow. The cron is paused (#64) and this feature does not restore it. |
| **Steps are retried** | **No longer true, by requirement 1.** This is a deliberate divergence from `intent.md`'s Constraints and from `CLAUDE.md`'s platform rules, recorded in "Divergences" below rather than by editing the approved intent. |

## Acceptance criteria

1. `npx wrangler deploy --dry-run` resolves every binding; `npm run typecheck`,
   `lint:ast`, `lint:ts`, `review:checks` and every mutation table pass.
2. **Five consecutive runs against the deployed Worker each gather all 46 feeds and reach
   `shortlist`, with no step reporting `Worker exceeded CPU time limit`.**

   Five, not one, and consecutive, not five of seven. Feature 002's criterion 5 was a
   single real run, and fact 1 makes a single run a coin: three of five identical probe
   runs completed while the underlying problem was untouched, so that criterion would
   have "passed" twice by luck. Five consecutive is the smallest number that makes
   passing by luck unlikely at the observed 60% completion rate (0.6⁵ ≈ 8%). It is a
   threshold chosen for cost, not a proof.
3. A `grep` for `step.do(` outside `src/lib/trace.ts` returns nothing, and the single
   call site passes an explicit zero-retry policy. `no-bare-step-do` still fails on a
   bare call inserted into `src/`.
4. A step made to throw deliberately produces exactly **one** attempt row in `wrangler
   workflows instances describe`, not six.
5. A child instance that fails leaves the parent failed, and the parent's `runs` row
   records a non-success status.
6. A gather re-run against an already-written `run_id` leaves the row count unchanged
   (feature 002's criterion 8, unchanged and still required).
7. The shortlist produced through children is identical to the shortlist the current
   in-parent gather produces for the same inputs.
8. The parent's step outputs are integers, never candidate arrays — feature 002's
   criterion 6, applied to the parent/child seam.

## Risks and mitigations

| risk | mitigation |
|---|---|
| **The premise the whole feature is built on may no longer hold.** Measured 2026-08-31 (`FINDINGS.md` §7.1): a single `run()` execution absorbed 5x10^8 arithmetic iterations in one isolate with no boundary and **no `1102`**, twice. That is ordinal, not a CPU figure — the identical loop cost 695 ms in one isolate and 149 ms in another, and a `Math.sqrt` loop does not transfer to `parseFeed`'s allocation and GC behaviour. What it does establish is one-directional: an invocation survived work that no reading of a 10 ms ceiling permits. Four days earlier the same account was measured to fail on the third feed parse in an invocation. Both cannot be true of the same platform. | **Not mitigated. This is a stop, not a risk to carry.** If the ceiling in force is not 10 ms, gather in child instances solves a problem that may not exist, and PR 3 is the wrong next PR. The cheap decisive follow-up is `map` mode over the same 46 feeds, on the real parse path: §1 and §4 record that as a coin flip on identical input, so a run now is directly comparable against committed evidence in a way the synthetic burn is not. Neither `wrangler.toml` declares `[limits]`, so a per-script `cpu_ms` difference is already ruled out; the account plan is the remaining candidate and this instrument cannot see it. |
| **A child instance is not a fresh CPU budget either.** This is the load-bearing inference in the whole design and it is **untested**. | Nothing measured it. It is adopted because it is the only remaining candidate with a mechanism story, and because `step.sleep` and retry are both measured *not* to be one. Criterion 2 is a repeated real run precisely because it is what decides — the same shape feature 002 used, and the same reason. If children do not help, the spec is wrong and the finding is worth as much as the fix would have been. |
| **Free-tier limits on concurrent or daily Workflow instances are not recorded anywhere in this repo.** A design that creates ten instances per run may hit a ceiling nobody has cited. | `plan.md` must find and cite the number before choosing `GATHER_FEEDS_PER_CHILD`, and the design tolerates sequential children if concurrency is capped — children are independent, so running them one at a time costs wall-clock and nothing else. |
| **Turning retries off removes a real recovery path** on the D1 and GitHub steps. | Accepted, and stated in the design section rather than buried. `fetchFeedItems` already insulates the gather path. Re-examine if a run fails on a step that would have recovered. |
| **Polling children costs subrequests and parent CPU.** | One subrequest per child per poll, in a parent step that parses nothing. The parent's cost is counts and status reads; requirement 5 is what keeps it that way. |
| **The failure is non-deterministic, so a green run proves less than it looks.** | Criterion 2 requires five consecutive, with the arithmetic stated. This risk is the reason that criterion is not "a run completes". |
| **Per-feed CPU cost is still unmeasured**, so `GATHER_FEEDS_PER_CHILD` cannot be derived. | Requirement 6 keeps the design independent of the number. The value is chosen with margin in `plan.md`, and criterion 2 is what validates it. |

## Divergences from `intent.md`

Recorded here rather than by editing the intent. Gate #76 is closed `COMPLETED` against
the approved text, and `scripts/plan_metrics.py` counts an `intent.md` commit landing
after `spec.md` diverges as post-spec churn — so amending it now would misreport the
process as rework.

- **"Steps are retried. Every `step.do` body added or changed must be safe to run twice."**
  No longer holds, by requirement 1 and the requester's directive. Idempotency is retained
  anyway, for the different reason given in requirement 7: `run()` re-executes even when
  step bodies do not. `CLAUDE.md`'s platform rule saying the same thing needs the same
  correction, and that edit belongs in this feature's implementation.
- **The intent's framing of the failure as happening at a feed.** It happens *around* feed
  10, non-deterministically (fact 1). #75 has been retitled to match.

## Which of the intent's open questions this closes

| question | status |
|---|---|
| What does a step boundary buy, and does a retry get one? | **Closed.** Boundaries exist and arrive unbidden; a retry gets nothing (facts 2, 4). |
| Is the reach stable run to run? | **Closed.** It is not (fact 1). |
| What is the remaining per-feed CPU cost? | **Open.** The probe reads no CPU figure. Requirement 6 exists so this does not block the design. |
| What is the instance lifetime ceiling? | **Partly.** A measured floor of ≥46 minutes (fact 5). The documented ceiling is still uncited and `plan.md` should find it. |
| How is a measurement retained as evidence? | **Closed.** `probe/captures/` is the pattern: commit the verbatim `describe` output at the moment it is taken. |

## Deferred

- **Finding what actually triggers an invocation boundary.** Boundaries demonstrably
  occur and cluster late in a run (`seq` 35+ in two separate runs). Nothing here explains
  them. Understanding the trigger might replace this whole design with a smaller one, but
  it is open-ended research and the run needs to complete first.
- **`step.sleepUntil` and `step.waitForEvent`.** Untested. Both are waits, and every wait
  measured so far — 35 s of backoff, 46 minutes of sleeping — produced no boundary, so
  the prior against them is strong enough not to spend a run on them now.
- **Sleeps longer than 60 s.** Cloudflare hibernates instances beyond some threshold that
  this repo cannot cite. Deferred for the same reason, and because a design that needs a
  hibernation-length sleep per feed is not a design anyone wants.
- **Restoring the cron (#64).** Triggered by criterion 2 passing, not by this feature
  merging.
- **Correcting `.claude/skills/cf-free-tier/SKILL.md`'s "a chance of a fresh invocation".**
  It is **untested, not false** — boundaries do occur non-deterministically, which is what
  "a chance" claims, and no probe ran the one-feed-per-step counterfactual. See
  `probe/FINDINGS.md`, which withdraws an earlier claim that it was measured false.
