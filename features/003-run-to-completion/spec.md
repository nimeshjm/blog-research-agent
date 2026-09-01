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

### Per-feed item volumes, measured 2026-09-01

The calibration table requirement 3's volume-balanced distribution was designed against.
Read from run `bd33248b`'s own gather step outputs, committed at `probe/captures/`: the
failed child `g0`'s first three steps plus its four completed siblings' 36 are 39 of the
46. Two throwaway probe children covered the seven feeds `g0` died before reaching —
Cloudflare, GitHub, Stack Overflow, Martin Fowler, Will Larson, Simon Willison, The
Pragmatic Engineer. Those two were read on 2026-09-01 and **not retained**, so alone among
the numbers here they have no committed capture behind them.

| feed | items | feed | items |
|---|---|---|---|
| arXiv cs.AI | **783** | Anthropic Research | 6 |
| arXiv cs.SE | 80 | OpenAI Developer | 5 |
| OpenAI | 54 | Ollama | 4 |
| Simon Willison | 30 | Pinecone | 4 |
| Claude | 29 | Surge AI | 4 |
| Cloudflare | 20 | AI FIRST Podcast | 3 |
| Stack Overflow | 16 | Weaviate | 3 |
| GitHub | 10 | OpenAI Engineering | 2 |
| Google Developers — AI | 10 | UK AI Safety Institute | 2 |
| Cursor | 9 | Will Larson | 2 |
| The Pragmatic Engineer | 9 | Dagster | 1 |
| DX | 8 | Goodfire | 1 |
| Honeycomb | 8 | *the other 19 feeds* | 0 |
| Anthropic News | 7 | | |
| Martin Fowler | 7 | **total** | **1,117** |

**cs.AI alone is 783 of the 1,117 — 70%.** Everything else in the allowlist combined is
334. That single number is why chunking by feed count decided the run: whichever of five
children drew cs.AI carried 70% of the whole parse, and a feed count cannot say which
child that is or that it matters.

**This table is perishable and is not the design.** cs.AI returned 352 items on
2026-08-27 and 783 five days later, which is the whole reason the implementation reads
its weights out of `run_candidates` (`readSourceWeights`, `src/lib/d1.ts`) rather than
carrying a copy of this table in code. It is recorded here as the calibration the design
was checked against on one dated day, not as an input to it.

### What run `0357f119` settled, 2026-09-01

Deployed run `0357f119-a281-4053-8876-3099e5a8b152`, 13:56 UTC, capture at
`probe/captures/0357f119-a281-4053-8876-3099e5a8b152.txt`. It is the furthest any run in
this build has reached, and it died at the last step.

**What it proved.** Volume-balanced chunking works: five gather children returned **1,118
candidates from all 46 feeds** with no `1102` anywhere, where `bd33248b` had lost a child
to CPU the day before against the same allowlist. Every step from `start-run` through
`synthesize` then worked, in order and once each — `shortlist` survived 1,118 candidates,
three summarize children returned real summaries, and `synthesize` produced a **real
draft**: a slug, a title, a description, four tags, a brief citing its sources, and a
body. Nothing in the pipeline between the topic and the draft is unproven any more.

**What it exposed.** The parent's residue against 50. `Last Successful Step:
synthesize-1`, then `open-pull-request` failed on the platform's own `Too many
subrequests by single Worker invocation.` The accounting, from that capture's own step
list: ~3 D1 calls for `start-run` and `select-topic`, 2 for `create-gather-children`
(`createBatch` plus `readSourceWeights`), **13 for `shortlist`** (one
`readRunCandidates` plus `ceil(1118 / 100) = 12` `findSeenUrls` chunks), 1 for
`create-summarize-children`, 1 inference for `synthesize` — 20 — plus **19 spent
polling children** (2 gather rounds x 5 children, 3 summarize rounds x 3), which is ~39
before a step whose own cost is 7 GitHub calls.

**Ten of those 19 polls could not have found anything.** Both loops polled before they
slept, so round 0 fired about a second after `createBatch`: `await-gather-children:0` at
13:56:44 against children created at 13:56:44, `await-summarize-children:0` at 13:57:17
against children created at 13:57:17. Both returned `{"done": false}` necessarily. The
same capture also dates the convergence the poll cadence is now sized against: gather was
complete by the 13:57:16 poll, and summarize was still running at 62 s (13:58:19) and
complete at 122 s (13:59:19).

**The parent's bill after both halves of that run's fix.** Cheaper polling took the 19 to
about 11 on this run's shape; moving publication into a child (requirement 2's third
extension) takes the 7 out of the parent entirely and puts `create-publish-children`'s 1
in. Re-counting the same terms:

| term | subrequests |
|---|---|
| `start-run` + `select-topic` | ~3 D1 |
| `load-sources` | 0 |
| `create-gather-children` | 2 |
| **`shortlist`** | **13** at 1,118 candidates (1 read + `ceil(1118 / 100) = 12`) |
| `create-summarize-children` | 1 |
| `synthesize` | 1 AI call |
| `create-publish-children` | 1 |
| `record-success` | 2 (still an estimate — no run has reached it) |
| **fixed total** | **23**, where it was ~29 |
| both existing poll loops, this run's shape | ~11 |
| publish poll, one child past a seconds-long convergence | 1 |
| **expected total** | **~35 of 50** |

The pessimal figure is the one the backstops actually permit: 23 fixed plus every poll
budget exhausted (10 + 9 + 4) is **46 of 50**, which fits where 29 + 10 + 9 would not
have. Four spare is not margin, and is not meant to be — a run that reaches all three
backstops has a worse problem than four subrequests.

**`shortlist`'s 13 is now the largest single term and the only one that follows the feed
allowlist.** It was 4 at run `6f75e460`'s 264 candidates. The risk table below records it
rather than tuning it, and the reason is unchanged: D1 caps a statement at 100 bound
parameters, so `ceil(candidates / 100)` is the platform's floor, not a knob here.

## Requirements

1. **No step is retried.** `step.do` is invoked with a retry policy of zero attempts
   beyond the first, everywhere in the Worker. A step that throws fails its instance
   immediately.
2. **Gather, article summarisation *and publication* run in child Workflow instances**,
   not in the parent's own `run()`. The parent creates children, waits for them, and reads
   their results; no feed is parsed, no article is fetched and no pull request is opened in
   the parent invocation.

   **Extended 2026-08-31 (#75) after measuring the half of it that shipped.** Run
   `6f75e460` moved gather into five children — all complete in 5-8 seconds, 264
   candidates — and the parent went from summarising **0 articles to 14** before failing
   the 15th with `Too many subrequests by single Worker invocation.` Children are
   therefore confirmed to be a fresh subrequest budget, which was this design's
   load-bearing untested inference; and moving *only* gather is confirmed insufficient,
   which the arithmetic predicted before the run rather than after.

   The parent's residue is what overflows: 15 articles cost a fetch plus a model call
   each, roughly 30 subrequests, on top of `shortlist`'s D1 traffic, `synthesize` and
   `open-pull-request`'s seven GitHub calls. That is over 50 with gather already gone, so
   the same mechanism has to cover articles. This is an extension of the requirement, not
   a new design: the child shape, the deterministic ids, the polling and the validated
   integer return are all reused.

   **Extended again 2026-09-01 (#75), and again by measurement rather than by design.**
   Run `0357f119` moved article summarisation out as well, reached `open-pull-request`
   with a real draft in hand, and failed *inside it* on the same
   `Too many subrequests by single Worker invocation.` The parent's residue was ~39
   subrequests before a step whose own cost is 7 GitHub calls. So the third and last
   per-item block of work leaves the parent's invocation too, by the same mechanism a
   third time: `PublishWorkflow` (`src/publish-workflow.ts`), one instance per run, created
   and polled exactly as the other two are.

   Two things make this the cheapest of the three extensions rather than a third design.
   There is **one** child, so there is nothing to chunk and requirement 3 gains no third
   value — `wrangler.toml` gets a `[[workflows]]` block and no new var. And the child
   returns a **single URL string**, which satisfies requirement 5's size reading by
   construction rather than by an argument about caps.

   What stays in the parent: `select-topic`, `load-sources`, `shortlist`, `synthesize` and
   the `runs`-row bookkeeping. Those are bounded and do not grow with the allowlist.
   `record-success` in particular stays here **and stays last**: the `pr_url` it writes is
   what the publish child returns, so the row cannot be written before the child completes.
3. **A child instance parses at most `GATHER_FEEDS_PER_CHILD` feeds**, a value in
   `wrangler.toml` and nowhere else, sized so that a child completes with margin against
   the observed failure range rather than at its edge.

   **Extended 2026-08-31 (#75), alongside requirement 2's own amendment.** A summarize
   child processes at most `SUMMARIZE_ARTICLES_PER_CHILD` shortlisted candidates, the
   same value shape one requirement earlier, sized against the same 50-subrequest ceiling
   (`createSummarizeChildren`'s comment in `src/workflow.ts`) rather than the feed count.

   **Amended 2026-09-01 (#75) after run `bd33248b`.** The feed count is no longer what
   decides a child's workload. `GATHER_FEEDS_PER_CHILD` keeps its name and both of its
   remaining jobs — it caps a child's *feed count*, which is that child's own
   50-subrequest bound (one fetch plus one D1 `batch()` per feed), and `ceil(46 / 10)`
   still derives how many children there are. What it never was is a CPU knob, and that
   is the bug: child `g0` drew both arXiv feeds, parsed 917 items across three of them,
   and died on its fourth (20 items) with `Worker exceeded CPU time limit.` while its
   four siblings carried light chunks and completed.

   So *which* feeds go to which child is now decided by measured **item volume**: sources
   are distributed greedily, heaviest first, into the least-loaded child with room
   (`chunkSourcesByVolume`, `src/workflow.ts`), weighted by per-source averages read from
   `run_candidates` (`readSourceWeights`, `src/lib/d1.ts`) rather than from a table
   written down here, which the section above shows would rot within a week.

   **The number of children stays at five, and not only by arithmetic.**
   `pollChildBatch` derives `max(1, floor(GATHER_POLL_SUBREQUEST_BUDGET / childCount))`
   poll rounds from the parent's subrequest share, so a sixth child would leave the
   parent a single round with no retry after its first sleep. Volume is therefore fixed
   by rebalancing a fixed number of children rather than by adding children.

   **This does not weaken requirement 6, and the distinction is the whole argument.** The
   obvious alternative — cap a child at N items — asserts exactly what requirement 6
   forbids: that N items fit and N+1 do not. Balancing across a fixed number of children
   asserts no boundary at all. It bounds a *growth term*: the worst child's volume falls
   from "whatever the heaviest feeds happen to sum to" toward the allowlist's mean, and
   it does so wherever the platform's real ceiling turns out to sit. That is the same
   argument feature 002 made for bounding the parse rather than fitting it to a measured
   limit, one level up. There is deliberately **no per-child item cap** in the
   implementation, and adding one later would be the regression.

   The durable reason for the change is not this run. Parse cost scales with items
   parsed; the knob counted feeds. That mismatch holds regardless of where today's
   boundary sat, which matters because the risk table below records that two runs
   disagree about where it sits.
4. **A failed child fails the run**, visibly. It does not silently contribute zero
   candidates. This is the deliberate opposite of the dead-feed rule, which stays: a feed
   that cannot be fetched still contributes zero without failing anything.
5. **The parent's own CPU cost does not grow with the number of children.** It holds
   counts, never candidates — the same rule feature 002 applied to `gather` within one
   instance, applied again one level up.

   **Extended 2026-08-31 (#75).** A summarize child cannot return a bare count the way a
   gather child does — `synthesize` needs the summaries themselves, not just how many
   there are. The reading this requirement is held to is the *size* claim, not the literal
   word: a step's output must not grow with the number of feeds or the number of
   children, whatever shape it takes. It holds under that reading because the parent's
   `await-summarize-children` step output is bounded by `SHORTLIST_TOP_N` (15 candidates,
   fixed regardless of the allowlist's size or how many children the run happens to split
   into) — see `createSummarizeChildren`'s comment for the 1 MiB arithmetic this stays
   two orders of magnitude under.
6. **The design does not depend on where the failure boundary falls.** Requirement 3's
   value may be tuned from measurement, but no requirement here asserts that N feeds fit
   and N+1 do not. The failure is not deterministic (fact 1), so any design keyed to a
   fixed reach is keyed to a coin.
7. **Candidate writes stay idempotent**, and `run_candidates`' `(run_id, url)` primary
   key stays load-bearing. Turning retries off removes one reason for idempotency but not
   the other: `run()` demonstrably re-executes (fact 2), and although a completed step's
   body does not re-run, nothing in this repo has measured what a *child* instance
   re-executes.

   **Extended 2026-09-01 (#75) to the *blog repo's* writes, which have a second reason
   nothing else here has.** Publication is not atomic — it pushes a branch, commits a
   file, then opens a pull request — so a run that dies part-way leaves state behind in a
   repository the next run also writes to. Run `0357f119` proved it: it pushed
   `research/2026-09-01-modular-silent-trials-...` and committed the draft, then died
   before the pull request, and `research/2026-08-31-...` survives from the run before it.
   The branch name is `research/<draft.date>-<draft.slug>`, so a later run deriving the
   same slug meets its own leftover. Branch creation therefore has to tolerate an
   already-existing ref for *two* reasons — replay (fact 2) and a previous run's debris —
   and it already did, via a 422 treated as success.

   What that 422 did **not** do is check. GitHub answers 422 to `Reference already exists`,
   to `Reference update failed` (branch protection) and to `Object does not exist` (an
   unknown base sha), so returning on any of them turned a ref that was never created into
   a silent success whose first symptom was a 404 further down the call chain.
   `createBranch` now confirms the ref with a GET before treating a 422 as idempotent —
   the same "verified against reality rather than assumed" rule `childExists` applies to a
   duplicate instance id, and one extra subrequest only on the exceptional path.
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
case requirement 1 exists for. The default-config control did not reproduce — one attempt, then
`Running` for at least 14 minutes with no second attempt — so this measures what the
policy does, not what the default would have done.

This is still *not* acceptance criterion 4, which names `research-workflow` itself.
Criterion 4 stays open for PR 5's captures.

### Gather in child instances

> **Amended 2026-08-31 (#75).** This section was written to buy a fresh **CPU** budget.
> That rationale is dead: run `0199648c` completed all 46 gather steps with no `1102`,
> and `probe/FINDINGS.md` §7.1 measured an invocation surviving work two orders of
> magnitude past the documented 10 ms. The design survives on a different resource. The
> same run failed every one of its 15 article fetches with `Too many subrequests by
> single Worker invocation.`, and a child instance is a separate invocation with its own
> 50. Moving 46 gathers out leaves the parent roughly 15 article fetches, 16 model calls
> and its D1 traffic — inside 50, where 46 + 15 never was.
>
> Read every CPU justification below as the reason this was *first* proposed, not as the
> reason it is still wanted. Requirement 6 (the design must not depend on the per-child
> feed count) is unaffected. Acceptance criterion 2 was **not** unaffected and has been
> rewritten — see it for why its original wording would have passed the very run that
> exposed all of this.
>
> **"Dead" was too strong, recorded 2026-09-01 (#75).** Run `bd33248b` killed a gather
> child with `Worker exceeded CPU time limit.` the day after this amendment was written.
> The risk table below now carries both runs and the contradiction between them rather
> than either verdict. The design is untouched either way — a child instance is a
> separate invocation, so it is a fresh budget for whichever of the two resources binds.


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

**The shape generalised to all three children, and that is the finding of the three
extensions taken together.** `createChildBatch` / `pollChildBatch`
(`src/lib/workflow-children.ts`) hold the create-poll-validate mechanism once; what each
caller supplies is its params, its output validator and how to combine results. Gather
returns a count, summarize an object of summaries and neuron spend, publish a URL — and
each is a separate `WorkflowEntrypoint` class with its own binding, deliberately, because
the binding is typed `Workflow<TParams>` and one class for all three would mean one
binding carrying a three-way union the parent must narrow before it can validate any of
it.

### What is deliberately not decided here

`GATHER_FEEDS_PER_CHILD` gets a number in `plan.md`, from measurement, not here. The
observed failure range is feeds 10–11 across two failing runs, and three runs completed
46, so the honest statement is that the range is wide and the value must be chosen with
margin rather than fitted to two data points.

## Platform constraints applied

| constraint | how this design respects it |
|---|---|
| **CPU is charged per invocation and a step boundary is not a reset** | The design stops relying on boundaries arriving. A child instance is a new invocation lineage by construction rather than by hope. **Extended 2026-09-01 (#75, run `bd33248b`):** a fresh invocation is not enough on its own, because the cost charged to it drains cumulatively across every feed in the chunk. Requirement 3 now balances that cost across children instead of counting feeds into them. |
| **10,000 neurons/day** | Unchanged. Children do no inference; `NEURON_BUDGET_PER_RUN` and `neuronsFor()` stay in the parent. |
| **50 subrequests per *invocation*** | Corrected 2026-08-31 (#75, run `0199648c`) from "per step", which is what this row said. One fetch per feed per step is unchanged and is no longer sufficient: 46 gather steps exhausted the budget before a single article fetch, all 15 failing with `Too many subrequests by single Worker invocation.` This, not CPU, is now the measured reason gather has to leave the parent's invocation. Parent polling adds one subrequest per *pending* child per poll. **Extended 2026-09-01 (#75, run `0357f119`):** it is also the reason article summarisation and then publication had to leave it - the parent's fixed bill is 23 with all three gone, against the ~48 that killed that run. See "What run `0357f119` settled" for the table. |
| **1,024 steps per instance** | Improved, not worsened: the parent sheds 46 gather steps, then 15 `summarize` steps, then `open-pull-request`, and gains three create-and-poll pairs. Each child holds its own budget, and the publish child holds exactly one step. |
| **Instance lifetime** | Still uncited (`intent.md` open question). Measured floor of ≥46 minutes (fact 5). A child's lifetime is a fraction of a parent's, so the design moves away from the ceiling rather than toward it. |
| **Cron wall-clock 15 min** | Not binding: orchestration remains a Workflow. The cron is paused (#64) and this feature does not restore it. |
| **Steps are retried** | **No longer true, by requirement 1.** This is a deliberate divergence from `intent.md`'s Constraints and from `CLAUDE.md`'s platform rules, recorded in "Divergences" below rather than by editing the approved intent. |

## Acceptance criteria

1. `npx wrangler deploy --dry-run` resolves every binding; `npm run typecheck`,
   `lint:ast`, `lint:ts`, `review:checks` and every mutation table pass.
2. **Five consecutive runs against the deployed Worker each gather all 46 feeds and reach
   a successful terminal state — a `runs` row with `status = 'succeeded'` and a non-null
   `pr_url` — with no step failing on a platform limit and no `summarize` step recording
   a `fetch-threw` skip.**

   **Rewritten 2026-08-31 (#75). The original wording would have graded a failing run a
   pass**, and it is worth being exact about how, because the same trap will be there for
   the next criterion someone writes against a symptom.

   It read: *"gather all 46 feeds and reach `shortlist`, with no step reporting `Worker
   exceeded CPU time limit`."* Run `0199648c` gathered all 46 feeds, reached `shortlist`,
   and reported no CPU error — and then skipped every one of its 15 articles with `Too
   many subrequests by single Worker invocation.`, spent zero neurons, and recorded
   `insufficient_sources`. Two independent faults: the named error is no longer the one
   that occurs, and `shortlist` is upstream of where the run now dies.

   So the criterion is stated against the **outcome** rather than a symptom. A run that
   opens a pull request cannot have been starved of CPU, subrequests or articles,
   whatever the platform's failure message says next month. The `fetch-threw` clause is
   the one symptom kept, because #85 made it self-reporting and because a run can reach
   `succeeded` on a thin set of articles without it being visible in the `runs` row.

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

   **Extended 2026-08-31 (#75).** Two of the parent's own step outputs were never
   literally integers even before this extension: `create-gather-children` and
   `create-summarize-children` both output `string[]` (child ids), not an integer — that
   was already true when this criterion was written and is not a regression. What it
   guards against is a candidate (or now a summary) array whose size scales with the feed
   allowlist or the child count. `await-summarize-children`'s own output is an object
   carrying a `summaries: ArticleSummary[]` capped at `SHORTLIST_TOP_N`, which is bounded
   for the same reason requirement 5's amendment gives — sized once against `SHORTLIST_TOP_N`,
   not against feed count or child count, and small enough in practice that the `create-*`
   steps' own id arrays are a closer comparison than "an integer" ever was.

   **Extended again 2026-09-01 (#75).** A poll round that is *not* the last one now
   outputs a `ChildPollState` — the child ids still pending, plus the validated output of
   every child that has already finished — because that is what lets a later round skip
   the children it already has and still hand `combine` all of them
   (`pollChildBatch`, `src/lib/workflow-children.ts`). It is held to the same size claim
   and passes it for the same reason: both fields are keyed by child id, and the carried
   outputs are the very same per-child results the terminal round already contained. What
   changed is how many step outputs hold them, not how large the largest one is — the
   ceiling is still `SHORTLIST_TOP_N`, and it stays that way only while summarize children
   partition a capped shortlist rather than sharing an uncapped one.

   **Extended a third time 2026-09-01 (#75), and this one needs no argument.** Publication
   in a child adds two more parent step outputs: `create-publish-children`'s one-element
   `string[]` of child ids, and `await-publish-children`'s pull request URL — a single
   bounded string, GitHub's own `html_url`. Neither follows the feed allowlist or the child
   count, and unlike the summaries there is no cap to keep holding: one run publishes one
   draft. Going the *other* way — the whole `Draft` the parent hands the child — is a
   Workflow **event payload**, not a step output, and is capped by the platform at the same
   1 MiB (`PublishParams`' doc comment sizes a draft against it at two orders of magnitude
   under, every field either fixed-size or bounded by `SHORTLIST_TOP_N`).

## Risks and mitigations

| risk | mitigation |
|---|---|
| **`shortlist` can exhaust the parent's invocation on its own, and nothing upstream stops it.** `findSeenUrls` chunks 100 URLs per D1 query; at `SHORTLIST_MAX_CANDIDATES`'s 4,000-row ceiling that is **40 queries — 40 subrequests — in the parent's invocation before a single child is polled.** Gather, summarize and (since 2026-09-01) publication all leaving the parent does not touch this. **Partly fired 2026-09-01 on run `0357f119`: 1,118 candidates, 13 subrequests in `shortlist`, and the parent died at `open-pull-request`.** | **Still not mitigated, and still deliberately not tuned — but no longer hypothetical.** The estimate this row was filed with (3 queries at run `6f75e460`'s 264 candidates) went stale in five days: `0357f119` gathered 1,118 and spent 13, and `shortlist` is now the largest single term in the parent's fixed cost. That did not kill the run on its own — 13 of 50 is not 40 — but it is what made the poll loops' 19 unaffordable, so the mitigations this run actually motivated are **cheaper polling** (`pollChildBatch`, and the wait-then-poll ordering in `run()`) and **publication in a child**, neither of them a change to `shortlist`. With both landed it is 13 of a fixed 23 - the largest term in the parent's bill, where it used to be one of several. **The 12 queries are a floor, not a knob:** D1 caps a prepared statement at 100 bound parameters, so the chunk size is the platform's and `findSeenUrls` cannot be tuned below `ceil(candidates / 100)` without a different dedupe strategy altogether. The number to watch is still candidates per run, and it quadrupled in five days; `findSeenUrls` throws rather than truncating past 50 chunks, so the ceiling itself stays loud. Recorded here so the next person to widen `GATHER_WINDOW_DAYS` — or to wonder why the parent's fixed cost moved — finds it. |
| **Two runs contradict each other about the CPU premise, and neither settles it.** On 2026-08-31 run `0199648c` parsed all **46 feeds in the parent's own steps** with no `1102`, and `FINDINGS.md` §7.1 measured a single `run()` execution absorbing 5x10^8 arithmetic iterations in one isolate with no boundary, twice — three survivals at that size across two builds (114, 149, 695 ms of wall for the burn) against deaths at 10^9 and above, on a **Free** account with `[limits]` set in neither `wrangler.toml`, which reads as an enforced ceiling above ~115 ms of arithmetic and below ~230 ms. This row previously concluded from that pair that the premise was dead. On 2026-09-01 run `bd33248b` then killed a gather **child** on its fourth feed with `Worker exceeded CPU time limit.`, 917 items already parsed in that invocation (`probe/captures/bd33248b-0fab-4abc-abce-92246a40b1b1-g0.txt`). Both cannot describe the same enforced ceiling, and fact 1 says the failure is non-deterministic, so neither run settles it alone. The candidate explanation is **volume**: cs.AI returned 352 items on 2026-08-27 and 783 on 2026-09-01, so the two runs were not parsing the same workload even though they were parsing the same 46 feeds. | **Not mitigated, and the contradiction is itself the finding — it is the evidence requirement 3's volume-balanced distribution is argued from.** Whatever the ceiling is, chunking that counts feeds while cost scales with items decides its own outcome by which chunk the heaviest feed lands in, and that holds on either reading of these two runs; the amendment therefore does not rest on `bd33248b` alone, which fact 1 forbids. The synthetic burn stays a bound rather than a CPU figure — a `Math.sqrt` loop does not transfer to `parseFeed`'s allocation and GC behaviour, which is exactly the gap the two real runs sit in. Neither `wrangler.toml` declares `[limits]`, so a per-script `cpu_ms` difference is ruled out; the account plan remains uninspectable from here. Criterion 2's five consecutive runs are what decide. |
| ~~**A child instance is not a fresh subrequest budget either.**~~ **Closed 2026-08-31 by run `6f75e460`:** five gather children completed in 5-8 seconds and the parent, relieved of 46 feed fetches, summarised 14 articles where the previous run summarised 0. A child is a fresh budget. What remains open is narrower — whether the parent's residue (`shortlist`, `synthesize` and its poll loops) stays inside 50 now that gather, the articles *and* the pull request have all left it. That is arithmetic rather than inference: those are bounded and do not grow with the allowlist — but the resource in question changed on 2026-08-31. CPU is no longer what bites (`FINDINGS.md` §7.1, and run `0199648c` completed all 46 gathers with no `1102`); the 50-subrequest-per-invocation ceiling is. | Nothing measured it. It is adopted because it is the only remaining candidate with a mechanism story, and because `step.sleep` and retry are both measured *not* to be one. Criterion 2 is a repeated real run precisely because it is what decides — the same shape feature 002 used, and the same reason. If children do not help, the spec is wrong and the finding is worth as much as the fix would have been. |
| **Free-tier limits on concurrent or daily Workflow instances are not recorded anywhere in this repo.** A design that creates ten instances per run may hit a ceiling nobody has cited. | `plan.md` must find and cite the number before choosing `GATHER_FEEDS_PER_CHILD`, and the design tolerates sequential children if concurrency is capped — children are independent, so running them one at a time costs wall-clock and nothing else. |
| **Turning retries off removes a real recovery path** on the D1 and GitHub steps. | Accepted, and stated in the design section rather than buried. `fetchFeedItems` already insulates the gather path. Re-examine if a run fails on a step that would have recovered. |
| **Polling children costs subrequests and parent CPU**, and there are now three loops paying it. **Fired 2026-09-01 on run `0357f119`: 19 of the parent's 50 subrequests, 10 of them on rounds that could not have found anything.** | One subrequest per *pending* child per poll, in a parent step that parses nothing. Two things changed on 2026-09-01 (#75), and neither is a tuning of the cadence: each loop now waits before its first poll, so round 0 lands past the point children are measured to converge rather than a second after `createBatch`; and a child that has already completed is not polled again, its validated output being carried in the poll step's own output instead (`pollChildBatch`, `src/lib/workflow-children.ts`). Together those take the two loops from 19 subrequests to about 11 on the same run's shape. `SUMMARIZE_POLL_INTERVAL` then goes 60 s → 90 s as a consequence rather than a lever: a smaller round cap shortens the slowest child the loop tolerates, and a longer wait gives that back at no subrequest cost. A third loop then joined them the same day, for publication - at one child it costs one subrequest per round, and `PUBLISH_POLL_SUBREQUEST_BUDGET` is the cheapest of the three backstops per round of tolerance bought, because `max(1, floor(budget / childCount))` divides by one. The parent's cost is still counts, status reads and one bounded URL; requirement 5 is what keeps it that way, and the carried outputs are held to it explicitly. |
| **The failure is non-deterministic, so a green run proves less than it looks.** | Criterion 2 requires five consecutive, with the arithmetic stated. This risk is the reason that criterion is not "a run completes". |
| **Per-feed subrequest cost, not CPU, is what sizes `GATHER_FEEDS_PER_CHILD`** — corrected 2026-08-31 (#75); CPU is no longer the binding resource. | Requirement 6 keeps the design independent of the number. Unlike CPU, this one *is* measurable ahead of a run: a feed costs one fetch plus its D1 write. Criterion 2 still validates the choice. |

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
