# Probe results, 2026-08-28

Three runs of `probe/` against the deployed `research-probe` Worker. Every number below
is a step output read back with `wrangler workflows instances describe probe-workflow
<id>`, not a bench and not a document.

Feature 003's `intent.md` left two questions open. Both are now answered, and the answers
are the opposite of what this repo has assumed since feature 001.

## 1. A step boundary buys nothing. There are no invocation boundaries at all

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

## What this settles, and what it overturns

The three sub-hypotheses for the deterministic retries all resolve:

- *The feed is too expensive on its own* — **refuted** by run 3.
- *Replay of completed steps exhausts the budget* — **refuted** by runs 1 and 2. There is
  no replay to be expensive.
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

Instance state outlives the 3-day dashboard trace retention, but not `wrangler delete`:
tearing the probe down takes `probe-workflow` and its instances with it, which is why the
captures are committed rather than the ids alone.

Feed measurements are perishable — arXiv cs.SE returned 65 candidates today against the
41 recorded on 2026-08-27 — so any number carried into `spec.md` must carry its date.
