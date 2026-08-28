# Probe results, 2026-08-28

Runs of `probe/` against the deployed `research-probe` Worker. Every number below is a
step output read back with `wrangler workflows instances describe probe-workflow <id>`,
not a bench and not a document.

Sections 1–3 are the first three runs, 2026-08-28 morning. Sections 4 onward are a
second sitting the same day that answered feature 002's deferred question — does
`step.sleep` force an invocation boundary — and, in the control run fired first,
**refuted section 1**. Sections 1–3 are left as they were written and annotated where
they are now known to be wrong; the corrections are the record, not the embarrassment.

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

**35 of the 45 crossings show no boundary at all.** They read like this:

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

The other 10 crossings do carry a new `r` — and they fall at the step indices where the
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
the current architecture ever ends that execution, and a retry inherits it exhausted. The
parse bound helped for exactly the reason that now makes sense: it did not buy more
invocations, it fit more feeds inside the only one there is. Pre-002 four feeds fitted,
post-002 nine do.

**Assertions in the tree that are now measured false**, and which a Stage 2 change should
correct rather than leave standing:

- `src/workflow.ts` — "What a step boundary buys is a *chance* of a fresh invocation".
- `.claude/skills/cf-free-tier/SKILL.md` and `CLAUDE.md` — "one feed per step ... is still
  what buys a *chance* of a fresh invocation, which is the only lever there is."

**Still not measured:** the size of the budget. Nothing here reads a CPU figure — the
findings are ordinal (nine fit, ten do not), not quantitative. The documented 10 ms sits
awkwardly against nine feed parses fitting, but the local bench's "elapsed is CPU"
premise is itself unverified, so this record does not assert a number.

## Reproducing

The verbatim `wrangler workflows instances describe` output for all three runs is
committed under `probe/captures/<instance-id>.txt`. **That is the citable copy.** Live
readback works only while the probe Worker exists:

```bash
npx wrangler workflows instances describe probe-workflow 3b78558c-357a-4e39-b9c5-5f2647a7d1d2
npx wrangler workflows instances describe probe-workflow 4ee0f759-5867-4bae-9696-b00e9a5d569c
npx wrangler workflows instances describe probe-workflow a67f0fb2-ea43-4da5-a07b-c5f61b7bfec0
```

Instance state outlives the 3-day dashboard trace retention. It does not outlive
`wrangler workflows delete probe-workflow`, which takes the instances with it. (Deleting
the *Worker* alone does not — measured 2026-08-28: the URL 404s while the workflow and
its instances remain.) Either way the captures are committed rather than the ids alone.

Feed measurements are perishable — arXiv cs.SE returned 65 candidates today against the
41 recorded on 2026-08-27 — so any number carried into `spec.md` must carry its date.
