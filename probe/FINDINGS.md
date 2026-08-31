# Probe results, 2026-08-28 and 2026-08-31

Runs of `probe/` against the deployed `research-probe` Worker. Every number below is a
step output read back with `wrangler workflows instances describe probe-workflow <id>`,
not a bench and not a document.

Sections 1–3 are the first three runs, 2026-08-28 morning. Sections 4–6 are a second
sitting the same day that answered feature 002's deferred question — does `step.sleep`
force an invocation boundary? **It does not** — and, in the control run fired first,
**refuted section 1**. Sections 1–3 are left as they were written and annotated where
they are now known to be wrong; the corrections are the record, not the embarrassment.

Section 7 is a third sitting, **2026-08-31**, after PR #82 turned step retries off. It
closes `plan.md`'s question 2 — and, unplanned, puts the CPU premise all six earlier
sections were written against in question.

## 1. A step boundary buys nothing. There are no invocation boundaries at all

> **Refuted in part by section 4**, measured an hour later. Boundaries do occur; this
> run did not get one. Read this section as what one run showed, not as the rule.

`3b78558c-357a-4e39-b9c5-5f2647a7d1d2` — all 46 feeds in `config/feeds.json` order.

| step | `r` | `iso` | `seq` | `ms` | candidates |
|---|---|---|---|---|---|
| `p00:arXiv cs.SE` | `8c26c3ce` | `d94a5ba8` | 0 | 440 | 65 |
| `p01:arXiv cs.AI` | `8c26c3ce` | `d94a5ba8` | 1 | 587 | 312 |
| `p02:OpenAI` | `8c26c3ce` | `d94a5ba8` | 2 | 1802 | 60 |
| `p03:Cloudflare` | `8c26c3ce` | `d94a5ba8` | 3 | 2007 | 20 |
| `p04:GitHub` | `8c26c3ce` | `d94a5ba8` | 4 | 2541 | 10 |
| `p05:Stack Overflow` | `8c26c3ce` | `d94a5ba8` | 5 | 2917 | 19 |
| `p06:Martin Fowler` | `8c26c3ce` | `d94a5ba8` | 6 | 4301 | 9 |
| `p07:Will Larson` | `8c26c3ce` | `d94a5ba8` | 7 | 4417 | 2 |
| `p08:Simon Willison` | `8c26c3ce` | `d94a5ba8` | 8 | 4521 | 30 |
| `p09:The Pragmatic Engineer` | — | — | — | — | **6 × `1102`** |

**One `r`. One `iso`. `seq` 0–8 with no gap.** Nine consecutive `step.do` calls executed
inside a single `run()` execution, in a single isolate, with the module-scope counter
never resetting: **no replay, no isolate change, and — given the tenth step failed — no
budget reset.**

Stated that way deliberately. `r` and `iso` cannot rule out an invocation that was
suspended and resumed, so the mechanism stays unnamed; what is measured is that whatever
happened between those nine steps did not reset the CPU budget.

`src/workflow.ts` and `.claude/skills/cf-free-tier/SKILL.md` both say one feed per step
buys "a *chance* of a fresh invocation". Measured, it bought none.

**The probe reproduced production exactly** — same ninth feed survived, same tenth feed
failed, same error — while carrying **no D1 write** (see `README.md`, "The one deliberate
divergence"). So the per-gather D1 write is not what creates boundaries and not what
causes the failure. That candidate explanation is dead.

## 2. A retry is not a fresh invocation, and does not reset the budget

`4ee0f759-5867-4bae-9696-b00e9a5d569c` — `mode: "retry"`. Two marker steps, then a step
that throws for the first 25 s of instance life.

| step | `r` | `iso` | `seq` | `ms` |
|---|---|---|---|---|
| `retry:before-1` | `2f414070` | `4f1e6823` | 0 | 301 |
| `retry:before-2` | `2f414070` | `4f1e6823` | 1 | 321 |
| `retry:fails-then-passes` (attempt 1) | — | — | — | threw at 5,407 ms |
| `retry:fails-then-passes` (attempt 2) | — | — | — | threw at 15,414 ms |
| `retry:fails-then-passes` (attempt 3) | `2f414070` | `4f1e6823` | **2** | 30,357 |
| `retry:after` | `2f414070` | `4f1e6823` | 3 | 30,378 |

After two failures and **35 seconds** of backoff, the succeeding attempt carries the same
`r`, the same `iso`, and `seq: 2` — the very next value. `run()` did not re-execute and
the isolate was not replaced.

This fully explains the six identical `1102`s on `gather:The Pragmatic Engineer` in
production, and it disposes of #61's explanation for the pre-002 deterministic retries
(replay rehydrating persisted candidates) a second time and more directly: **there is no
replay.** Retry has never been a recovery path for a CPU failure. The five minutes of
default backoff are five wasted minutes.

## 3. The feed that kills the run is not expensive

`a67f0fb2-ea43-4da5-a07b-c5f61b7bfec0` — The Pragmatic Engineer at position 1, then DX,
then arXiv cs.AI. **Completed.**

| step | `seq` | `ms` | candidates |
|---|---|---|---|
| `p00:The Pragmatic Engineer` | 0 | 416 | 10 |
| `p01:DX` | 1 | 729 | 10 |
| `p02:arXiv cs.AI` | 2 | 916 | 312 |

The feed that failed six times at position 10 passes trivially at position 1. Its cost is
not the problem; its position is. The repo had no measurement of this feed at all.

## 4. The map result is not deterministic. Finding 1 was one observation

Four more `map` runs over the same 46 feeds in the same order, all on 2026-08-28 between
11:52 and 11:56. They were fired as a **control before the sleep runs**, because a sleep
run reaching feed 46 could not otherwise be told apart from the feeds simply being
cheaper today.

| instance | queued | outcome | feeds | `run()` executions |
|---|---|---|---|---|
| `3b78558c` (section 1) | 11:11:22 | ❌ `1102` | 9 | 1 |
| `52a3a5b6` | 11:52:24 | ✅ completed | 46 | 1 |
| `b7f6c1bf` | 11:53:43 | ✅ completed | 46 | 1 |
| `ee0d3042` | 11:53:56 | ✅ completed | 46 | **6** |
| `e381a65f` | 11:55:03 | ❌ `1102` | 10 | 1 |

Two of five errored around feed 10 and three completed all 46, on identical input in
identical order inside one hour — `n` matches section 1's for every feed both runs
reached, so the feeds had not changed. **The failure is not deterministic.** Every
statement in sections 1–3, and in `intent.md`, that reads the tenth feed as a fixed wall
is describing a coin that had landed the same way three times.

The redeploy is not the variable: `e381a65f` failed on the new Version Id that three of
the completions also ran on, and `3b78558c` failed on the old one.

`ee0d3042` is the sharper result. It carried **six distinct `r` values under one `iso`**,
with `seq` running 0–45 unbroken:

| first step of the execution | `r` | `seq` | `ms` |
|---|---|---|---|
| `p00:arXiv cs.SE` | `bf4a0973` | 0 | 367 |
| `p35:Surge AI` | `e113d8d3` | 35 | 4,961 |
| `p37:UK AI Safety Institute` | `746cdea9` | 37 | 4,970 |
| `p39:Goodfire` | `a901dc01` | 39 | 5,010 |
| `p41:Timaeus` | `6b9012b2` | 41 | 5,007 |
| `p45:AI FIRST Podcast` | `303af2ca` | 45 | 5,006 |

`run()` re-executed five times inside one instance. `seq` continuing across each break
means the isolate was reused; `ms` falling back to ~5,000 means the clock at the top of
`run()` was reset, i.e. `run()` genuinely re-entered rather than the step being resumed.
**Section 1's "there are no invocation boundaries at all" is refuted.**

That claim was true of the run it was measured on and false of the next one. It is the
same over-generalisation from a single observation that feature 002 exists to correct,
committed inside the instrument built to correct it — which is why the control run
mattered and why it was run first.

What survives from section 1 is narrower and still holds: on `3b78558c`, nine steps ran
in one `run()` execution with no boundary and the tenth died. What does not survive is
the general claim.

**Not measured:** why a boundary happens on one run and not the next, or why the
post-boundary `ms` is ~5,000 every time regardless of how many completed steps precede
it (35 in one case, 43 in another). A constant rather than a growing figure is evidence
*against* the natural reading that those 5 seconds are `run()` replaying the completed
steps, but the instrument cannot see what they are instead, so this record does not name
them.

## 5. `step.sleep` does not create an invocation boundary — measured at 1 second

`523c1723-d3ba-4076-9e63-9b227f95f3e7` — `mode: "sleep"`, all 46 feeds, `everyN: 1`,
`sleepFor: "1 second"`. 46 gather steps, 46 sleeps, **completed**.

With `everyN: 1` a single run yields 45 sleep crossings, which is the power this question
needs: whether the instance completed is now a weak signal (section 4), but 45 crossings
is not.

**40 of the 45 crossings show no boundary at all.** They read like this:

| step | `r` | `iso` | `seq` | `ms` |
|---|---|---|---|---|
| `p00:arXiv cs.SE` | `346e068b` | `e2396676` | 0 | 380 |
| `s00:sleep` | | *(a sleep step persists no output)* | | |
| `p01:arXiv cs.AI` | `346e068b` | `e2396676` | 1 | **1,482** |
| `s01:sleep` | | | | |
| `p02:OpenAI` | `346e068b` | `e2396676` | 2 | **3,051** |

Same `r`, same `iso`, next `seq`, and `ms` grown by roughly 1,100 ms per crossing against
the 88 ms and 389 ms the same two crossings cost in the `map` control `52a3a5b6`. **The
sleep's own second is charged to the same `run()` clock.** That is what an in-process
`await` looks like and it is the opposite of a boundary: the clock at the top of `run()`
was never reset, so nothing ended the execution the CPU budget is charged against.

The other 5 crossings do carry a new `r` — and they fall at the step indices where the
control did the same thing with no sleeps in it at all:

| run | sleeps? | `run()` re-entered before `seq` |
|---|---|---|
| `ee0d3042` (control) | no | 35, 37, 39, 41, 45 |
| `523c1723` (run A) | 45 of them | 35, 37, 39, 41, 43 |

The two are the same pattern, and the sleeps did not move it. Wall clock says the same:
run A reached `seq` 34 at `ms` 41,342 against the control's 11,150 — four times the
elapsed time before the first boundary, at the identical step index. Whatever produces
those boundaries is counting something other than time, and `step.sleep` is not an input
to it.

### What this settles

**A 1-second `step.sleep` does not create an invocation boundary and does not reset the
CPU budget.** The prior from section 2 held: 35 seconds of retry backoff did not reset
the budget, and a 1-second sleep does not either. The wait is not the mechanism.

### What it does not settle

- **Nothing about longer sleeps.** Cloudflare hibernates instances for sleeps past some
  threshold and 1 second is plainly below it. That is run B, below.
- **Nothing quantitative.** No CPU figure is read here, only ordinal facts.
- **Not "the lever is dead"** — only that this is not how to pull it. A mechanism that
  genuinely ends the `run()` execution would still be worth having; `step.sleep` at one
  second is measured not to be one.
- The run **completed**, and that is deliberately not offered as evidence for anything:
  three of five control runs completed too.

## 6. Nor at 60 seconds. Zero boundaries in 45 crossings

`aaddf4f9-20f9-48c6-bfb1-48db00b4dbda` — same payload as run A with `sleepFor: "60
seconds"`. 46 gather steps, 46 sleeps, 46 minutes wall clock, **completed**.

| | |
|---|---|
| distinct `r` | **1** (`3dce6867`) |
| distinct `iso` | **1** (`ad125917`) |
| `seq` | 0–45, contiguous, no gap |
| `r` transitions across 45 crossings | **0** |
| `ms` delta per crossing | 60,074 – 60,550, every one of the 45 |
| `ms` on the final gather step | **2,708,901** |

That last number is the whole finding in one figure. `ms` is `Date.now()` minus a `t0`
taken at the top of `run()`. **One `run()` execution stayed live for forty-five minutes
of sleeping**, and every second of it was charged to its clock. The instance did not
hibernate, `run()` did not re-enter, the isolate was not replaced, and the module-scope
counter never skipped.

Run B got **fewer** boundaries than the no-sleep control `ee0d3042`, which got five.
Sleeping did not merely fail to create a boundary; this run crossed none at all while a
run with no sleeps in it crossed five.

### The answer

**No. `step.sleep` does not create an invocation boundary and does not reset the CPU
budget.** Across runs A and B, **85 of 90 sleep crossings show the same `r`, the same
`iso`, the next `seq`, and an `ms` grown by the sleep's own duration** — an in-process
`await`. The five that did cross fell at the step indices where the control crossed with
no sleeps in it.

The prior held. Section 2 measured that 35 seconds of retry backoff did not reset the
budget and predicted that a sleep is the same shape of wait. It is. Waiting is not the
mechanism, at either 1 second or 60.

### What this kills

**The lever feature 002 deferred, as named.** `spec.md`'s "Deferred" section reads:

> **Forcing an invocation boundary per gather step** (e.g. `step.sleep`) — the heavier
> lever ... If requirement 1 is dropped, this is what replaces it.

`step.sleep` cannot force one. A feature 003 spec that adopts it would buy 46 minutes of
wall clock per run and nothing else — and the cost is not hypothetical, it is the
measured duration of run B.

### What this does not kill, and does not measure

- **Not "no boundary can be forced".** Only that `step.sleep` is not how. Boundaries
  demonstrably exist (section 4); nothing here found their trigger, so nothing here rules
  out some other mechanism reaching it. A spec may still pursue the lever — it may not
  pursue it *via `step.sleep`*.
- **Nothing past 60 seconds.** Cloudflare hibernates instances for long enough sleeps and
  60 s is measured to be below that threshold. Where the threshold is, and whether a
  sleep past it would reset the budget, is unmeasured. A design resting on it would be
  resting on an inferred platform behaviour, which is the mistake feature 002 exists to
  correct — and it would have to justify a sleep longer than a minute per feed against a
  46-feed run.
- **Nothing quantitative.** No CPU figure is read anywhere in this file.
- **Not that sleeping made run B complete.** Three of five `map` controls completed with
  no sleeps at all (section 4). Completion is a coin here and is not offered as evidence.
- **Nothing about `step.sleepUntil`, `step.waitForEvent`, or a second Workflow instance.**
  Untried.

### One number a Stage 2 spec should not miss

In runs A and `ee0d3042`, the first gather step after each boundary reports `ms` between
4,961 and 5,010 — **constant**, whether 35 or 43 completed steps precede it. Whatever
those ~5 seconds are, they do not grow with the number of completed steps, which is
evidence against the natural reading that they are `run()` replaying them. It is also the
reason a per-step forced boundary would not obviously cost O(n²) — but that is inference
from a flat five-run series, not a measurement of replay cost, and no design should lean
on it without measuring it.

## 7. `retries: { limit: 0, delay: 0 }` is honoured, and `0` does not mean "no attempts"

> Third sitting, 2026-08-31, against `research-probe` redeployed at version
> `7dee9a84-d28b-4501-b4bf-0888d959e775`. Sections 1-6 are 2026-08-28 and are untouched.

The gate `plan.md` work order step 2 puts in front of PR 3. PR
[#82](https://github.com/nimeshjm/blog-research-agent/pull/82) made
`src/lib/trace.ts` pass `NO_RETRIES` at production's one `step.do` call site, but the
docs describe `limit` as "the total number of attempts" on one page and "maximum number
of retries" on another, and under the first reading `0` could mean *never run*. Nothing
documented settles it. Two instances, triggered within one second of each other, do.

`noretry` and `retry` run the same shape — two cheap markers, then a step that fails —
and differ only in whether `{ retries: { limit: 0, delay: 0 } }` is passed. The probe
writes that value out rather than importing it from `src/lib/trace.ts`, so this measures
the platform, not this repo's constant.

| | `noretry` `3f5770ac` (policy passed) | `retry` `f95f58da` (control, default config) |
|---|---|---|
| markers before the failing step | `nr:before-1` ✅ `seq` 0, `nr:before-2` ✅ `seq` 1 | `retry:before-1` ✅, `retry:before-2` ✅ |
| attempt rows on the failing step | **1** — errored 11:06:58 | **3** — threw at 4,001 ms, threw at 14,011 ms, succeeded at 34,019 ms |
| step after it | never ran | `retry:after` ✅ |
| instance | ❌ Errored, **0 seconds** | ✅ Completed, 30 seconds |

Both halves of the pass condition hold, and they answer different questions:

- **One attempt row against the control's three** — same instrument, same sitting, same
  step shape — is the policy being honoured. Six was the number to fear
  (`spec.md` acceptance criterion 4); three is what this account's default actually
  produces on a step that stops throwing.
- **`nr:before-1` and `nr:before-2` completed.** That is what rules out the "total
  attempts" reading under which `0` would mean no step ever runs. Read this evidence off
  the `noretry` run only — see 7.1, where the markers share an invocation with a step
  that could have killed it.

So `plan.md` question 2 resolves to the **"maximum number of retries"** reading.
`{ limit: 0, delay: 0 }` is the right value and the recorded fallback to
`{ limit: 1, delay: 0 }` is not needed.

**What this does not establish.** The failure here is a thrown `Error`. Production's
failure is `1102`, a platform CPU kill, and 7.1 is the run that was supposed to test
whether the policy reaches that too. It did not get that far: no `1102` was produced.
Whether a CPU kill honours `retries` is **untested**, and `spec.md` acceptance criterion
4 — one attempt row on `research-workflow` itself — stays open for PR 4's captures.

*(Amended by 7.2: the ramp in 7.1 did eventually produce a real `1102`, and it too got
exactly one attempt row. So the policy is measured to cover a CPU kill; what stays open
is only that criterion 4 names `research-workflow`, not the probe.)*

### 7.1 A single `run()` execution absorbed ~700 ms of arithmetic without a `1102`

The instrument for the paragraph above: `noretry-cpu` and `cpu` are the same two markers
plus a step running 5x10^8 iterations of `x += Math.sqrt(i)`, with and without the retry
policy. **Both completed.**

| instance | mode | `r` / `iso` | `seq` 0-3 `ms` | burn |
|---|---|---|---|---|
| `ed80e52c` | `noretry-cpu` | `b80b547e` / `b2ea679f` | 305, 320, **336**, **1031** | ~695 ms |
| `b90a43b6` | `cpu` | `c64c7361` / `aaede366` | 252, 271, **290**, **439** | ~149 ms |

The loop ran: both return `sink` = `7453559913819.172`, which is the sum it computes
(2/3 x (5x10^8)^1.5), so nothing elided it. The two burns differ by 4.6x, which is JIT
warm-up or scheduling and is not what this section is about.

**All four steps of each run carry one `r` and one `iso` with `seq` 0-3.** By this
document's own reading rules that is *one* `run()` execution in *one* isolate — no
boundary, nothing packed around. That execution absorbed the burn and kept going.

`ms` is wall-clock, not CPU, and this instrument has never read a CPU figure. But the
loop contains no `await` and no I/O, and 5x10^8 floating-point iterations do not cost
10 ms on any hardware — that is inference from the operation count, not a measurement,
and it is the only step in this reading that is not read off a capture.

Neither `wrangler.toml` declares a `[limits]` block and both use
`compatibility_date = "2025-01-01"`, so a per-script `cpu_ms` difference between the
probe and production is ruled out. The remaining candidate this instrument cannot see is
the account plan.

**A ramp, and what it is not.** Redeployed with the iteration count as a payload field
(`b1e14d18`), the same burn was run at larger sizes:

| instance | mode | `iters` | burn |
|---|---|---|---|
| `b90a43b6` / `ed80e52c` | `cpu` / `noretry-cpu` | 5x10^8 | ✅ survived, twice |
| `da873328` | `noretry-cpu` | 1x10^9 | ❌ `Worker exceeded CPU time limit` |
| `b292794e` | `noretry-cpu` | 2x10^9 | ❌ same |
| `0c23546e` | `noretry-cpu` | 5x10^9 | ❌ same |
| `a32b6d53` | `noretry-cpu` | 5x10^10 | ❌ same |

**This is not a CPU figure and must not be read as one.** The identical 5x10^8 loop cost
695 ms in one isolate and 149 ms in another — 4.6x — so iteration count does not map to
CPU consumed, and "somewhere between 5x10^8 and 10^9" is a JIT-dependent ordinal
threshold, not a ceiling. This instrument has never read a CPU number and still has not.
What it establishes is one-directional and enough: **an invocation survived 5x10^8
iterations of arithmetic**, which no reading of a 10 ms ceiling permits.

Nor does the burn transfer to production's failure. `parseFeed` allocates, builds strings
and pressures GC; a tight floating-point loop over a flat heap does not. A threshold
measured on `Math.sqrt` says nothing about where `parseFeed` dies.

**This contradicts a load-bearing premise in the tree.** `CLAUDE.md` and
`.claude/skills/cf-free-tier/SKILL.md` say, measured 2026-08-27 under #61: one feed parse
in an invocation passes, two pass, three fail with `1102`. Four days later one invocation
took two orders of magnitude more arithmetic than that and did not fail. Both cannot
describe the same platform. Either the ceiling in force changed between those dates, or
production's `1102` has a cause other than accumulated arithmetic CPU.

**Not resolved here, and deliberately not tuned around.** The cheap decisive follow-up is
`map` mode over the same 46 feeds: sections 1 and 4 record that as a coin flip on
identical input, so a clean completion now is directly comparable against committed
evidence. Until that is run, feature 003's children design rests on a premise this
section puts in question, and `plan.md`'s PR 3 should not start.

### 7.2 A real `1102` gets one attempt too

Section 7 could not answer whether the policy reaches a *platform* kill rather than a
thrown `Error`, because the burn it had was under the ceiling. 7.1's ramp supplies the
missing failure. Every instance that died did so with `Worker exceeded CPU time limit` —
production's `1102`, produced deliberately — and under `{ retries: { limit: 0, delay: 0 } }`:

| instance | `iters` | attempt rows on the burn step | instance |
|---|---|---|---|
| `da873328` | 1x10^9 | **1** | ❌ Errored |
| `b292794e` | 2x10^9 | **1** | ❌ Errored |
| `0c23546e` | 5x10^9 | **1** | ❌ Errored |
| `a32b6d53` | 5x10^10 | **1** | ❌ Errored |

Four for four. **The policy covers a CPU kill, not only a thrown error**, which is the
case `spec.md` requirement 1 exists for. Counted off the burn step's own attempt table in
each capture — a `grep` for the error string also matches the instance header line and
returns 2 for a single-attempt step.

**The control did not reproduce, and that is recorded rather than left implied.**
`2831f91e` is the same 5x10^9 burn under the platform default. It took one attempt and
then stayed `Running` for **at least 14 minutes** with no second attempt row and no
terminal state — polled once a minute throughout. Production's run in
[#75](https://github.com/nimeshjm/blog-research-agent/issues/75) got six attempts across
five minutes on a real `1102`; this control got one and then sat. So the table above says
what the policy does, and **nothing here establishes what the default would have done to
the same step** — the contrast with `retry`'s clean 1-against-3 in section 7 is not
available on the CPU side.

Times in this section are as `wrangler` prints them, which is local (UTC+1), not UTC.

## What this settles, and what it overturns

The three sub-hypotheses for the deterministic retries all resolve:

- *The feed is too expensive on its own* — **refuted** by run 3.
- *Replay of completed steps exhausts the budget* — **refuted** by runs 1 and 2. There is
  no replay to be expensive. *(Section 4 corrects this: replay does happen, just not on
  the run this was measured on. What runs 1 and 2 actually showed is that no replay
  occurred **there** — which is still enough to refute replay as the cause of the
  deterministic retries in that run, but not the general claim made here.)*
- *A retry does not get a fresh budget* — **confirmed** by run 2.

So the CPU budget is charged cumulatively across an entire `run()` execution, nothing in
the current architecture ever ends that execution, and a retry inherits it exhausted.
*(Sections 4–6 amend the middle clause: something does end that execution, sporadically
and by a trigger this instrument cannot see. What is now measured is that neither a retry
nor a `step.sleep` is that something.)* The
parse bound helped for exactly the reason that now makes sense: it did not buy more
invocations, it fit more feeds inside the only one there is. Pre-002 four feeds fitted,
post-002 nine do.

**Assertions in the tree that are now measured false**, and which a Stage 2 change should
correct rather than leave standing:

- `src/workflow.ts` — "What a step boundary buys is a *chance* of a fresh invocation".
  *(Withdrawn on the same grounds as the entry below — see section 4.)*
- `.claude/skills/cf-free-tier/SKILL.md` and `CLAUDE.md` — "one feed per step ... is still
  what buys a *chance* of a fresh invocation, which is the only lever there is."
  *(Section 4 withdraws this entry. Fresh `run()` executions do occur and they occur
  non-deterministically, which is what "a chance" claims. And the probe runs one feed per
  step in every mode, so it has never run the counterfactual and cannot say what that
  choice buys either way. The sentence is **untested**, not measured false; only the "no
  boundaries at all" reading of it was, and that reading was the over-generalisation.
  A Stage 2 change should not edit `SKILL.md` or `CLAUDE.md` on the strength of this
  line.)*

**Still not measured:** the size of the budget. Nothing here reads a CPU figure — the
findings are ordinal (nine fit, ten do not), not quantitative. The documented 10 ms sits
awkwardly against nine feed parses fitting, but the local bench's "elapsed is CPU"
premise is itself unverified, so this record does not assert a number.

*(Section 7.1 does not close this either, but it moves it: a single `run()` execution
absorbed 5x10^8 arithmetic iterations without a `1102`. Still no CPU figure — only a
lower bound on what one invocation survived, and one that sits two orders of magnitude
above the documented 10 ms.)*

## Reproducing

The verbatim `wrangler workflows instances describe` output for every run is committed
under `probe/captures/<instance-id>.txt`. **That is the citable copy**, and after the
teardown below it is the only one.

| instance | section | mode | outcome |
|---|---|---|---|
| `3b78558c-357a-4e39-b9c5-5f2647a7d1d2` | 1 | `map`, 46 feeds | ❌ `1102` at feed 10 |
| `4ee0f759-5867-4bae-9696-b00e9a5d569c` | 2 | `retry` | ✅ |
| `a67f0fb2-ea43-4da5-a07b-c5f61b7bfec0` | 3 | `map`, 3 feeds reordered | ✅ |
| `52a3a5b6-86bf-420f-8fc5-553a8948d53c` | 4 | `map`, 46 feeds | ✅ 46 |
| `b7f6c1bf-97a7-4307-b733-5b513b963718` | 4 | `map`, 46 feeds | ✅ 46 |
| `ee0d3042-0296-4cd5-91ca-1bf442650409` | 4 | `map`, 46 feeds | ✅ 46, six `run()` executions |
| `e381a65f-7638-40c1-bed4-c85745d73535` | 4 | `map`, 46 feeds | ❌ `1102` at feed 11 |
| `523c1723-d3ba-4076-9e63-9b227f95f3e7` | 5 | `sleep`, `everyN` 1, 1 s | ✅ 46 |
| `aaddf4f9-20f9-48c6-bfb1-48db00b4dbda` | 6 | `sleep`, `everyN` 1, 60 s | ✅ 46, 46 min |
| `3f5770ac-c12b-4f8f-a561-0eef472a164c` | 7 | `noretry` | ❌ 1 attempt, instance errored in 0 s |
| `f95f58da-ee6c-4059-8e31-728db3ace65a` | 7 | `retry` (control) | ✅ 3 attempts |
| `ed80e52c-9204-49f3-b9cd-13301e5e0846` | 7.1 | `noretry-cpu` | ✅ no `1102` |
| `b90a43b6-bcd6-4c8d-89b5-37031c265891` | 7.1 | `cpu` (control) | ✅ no `1102` |
| `da873328-5052-488f-9217-d1223b2ff597` | 7.1, 7.2 | `noretry-cpu`, 1x10^9 | ❌ `1102`, 1 attempt |
| `b292794e-10c9-466c-820c-c239c72bf4e2` | 7.1, 7.2 | `noretry-cpu`, 2x10^9 | ❌ `1102`, 1 attempt |
| `0c23546e-368e-42c4-94c7-b00694fbc7d1` | 7.1, 7.2 | `noretry-cpu`, 5x10^9 | ❌ `1102`, 1 attempt |
| `a32b6d53-f0d5-4d65-8c6f-8ec88712bb73` | 7.1, 7.2 | `noretry-cpu`, 5x10^10 | ❌ `1102`, 1 attempt |
| `2831f91e-f016-4fd6-98d0-a88f113dacc7` | 7.2 | `cpu` (control), 5x10^9 | ⚠ 1 attempt, then stayed `Running` |

Live readback works only while the probe Worker and its workflow exist:

```bash
npx wrangler workflows instances describe probe-workflow <instance-id>
```

Instance state outlives the 3-day dashboard trace retention. It does not outlive
`wrangler workflows delete probe-workflow`, which takes the instances with it. (Deleting
the *Worker* alone does not — measured 2026-08-28: the URL 404s while the workflow and
its instances remain.) Either way the captures are committed rather than the ids alone.

Feed measurements are perishable — arXiv cs.SE returned 65 candidates today against the
41 recorded on 2026-08-27 — so any number carried into `spec.md` must carry its date.
