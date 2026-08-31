# Plan: Run to completion

> Stage 3. Written from `spec.md`, which was written from `intent.md` (gate
> [#76](https://github.com/nimeshjm/blog-research-agent/issues/76), closed `COMPLETED`).
> Tracking [#75](https://github.com/nimeshjm/blog-research-agent/issues/75).

## Context

`spec.md` asks for two things that are not the same thing: **no step retries**, because a
retry was measured to inherit the exhausted budget that failed the first attempt; and
**gather in child Workflow instances**, because a child is the only remaining candidate
for a fresh CPU budget after `step.sleep` and retry were both measured not to be one. The
measurements are at [`probe/FINDINGS.md`](../../probe/FINDINGS.md) with verbatim captures
at `probe/captures/`.

The acceptance criterion is five consecutive completing runs, not one, because three of
five identical probe runs completed while the underlying problem was untouched.

## Four questions this plan closes before any code is written

### 1. The free-tier numbers `spec.md` said to find and cite

From Cloudflare's [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
page, read 2026-08-28. Every row here is `documented`, not inferred.

| limit | Workers Free | bearing on this design |
|---|---|---|
| Concurrent instances | **100** | 10 children per run is comfortably inside it |
| Instances waiting (`step.sleep`, retry, `waitForEvent`) | **do not count** toward concurrency | polling parents are cheap |
| Instance lifetime | **no ceiling** — "can run forever" | closes `intent.md`'s open question in the opposite direction from the way it was asked |
| Executions per day | 100,000, shared with the Workers daily request limit | ~11 instances per run is nothing |
| Creation rate | 100/sec | irrelevant at this scale |
| Steps per instance | **1,024** confirmed | see the budget below |
| `step.sleep` / `sleepUntil` | **do not count** toward the step limit | polling can sleep between rounds for free |
| Max non-stream step result | 1 MiB | a child returns an integer |

**`intent.md` asked for the instance lifetime ceiling and there is none.** Footnote 1:
*"A Workflow instance can run forever, as long as each step does not take more than the
CPU time limit and the maximum number of steps per Workflow is not reached."* The 3-day
Free figure is **retention of completed state**, not a lifetime cap. The 46-minute floor
this repo measured was never near anything.

**One caveat, recorded rather than smoothed over.** That page contradicts itself: prose
under the concurrency table says "only actively `running` instances count toward the
10,000 concurrent instance limit" while the table says 100 (Free) / 50,000 (Paid). This
plan uses the table. At this design's scale — 10 children — the two readings do not
differ in consequence, and past the limit extra children go `queued`, not failed.

### 2. `retries: { limit: 0 }` typechecks, but nothing says it is honoured

From `node_modules/@cloudflare/workers-types/index.d.ts:15397` — primary evidence, since
this is what actually compiles:

```ts
export type WorkflowStepConfig = {
  retries?: { limit: number; delay: WorkflowDelayDuration | number | WorkflowDelayFunction; backoff?: WorkflowBackoff };
  timeout?: WorkflowTimeoutDuration | number;
  sensitive?: WorkflowStepSensitivity;
};
```

`limit` is a plain `number`, so `0` compiles. **`delay` is required, not optional**, so
`{ retries: { limit: 0 } }` alone does not typecheck — it must be `{ limit: 0, delay: 0 }`.

The docs describe `limit` two ways on two pages: "the total number of attempts to make for
a step" (prose and sample comment) and "maximum number of retries per step" (limits table).
Under the first reading `0` might mean *no attempt at all*. **Nothing documents whether `0`
is accepted.** Work order step 2 therefore verifies it on the deployed Worker before the
value is trusted, and `spec.md`'s acceptance criterion 4 — exactly one attempt row in
`wrangler workflows instances describe`, not six — is that verification. If `0` is rejected
or means "never run", the fallback is `{ limit: 1, delay: 0 }`, whose worst case under the
"total attempts" reading is the behaviour we want and under the "retries" reading is one
pointless retry at zero delay. Record which reading held.

`NonRetryableError` is **not** a substitute: it suppresses retries for errors your own code
throws, not platform step failures like `1102`.

### 3. A child's return value is retrievable, so results need no side channel

`index.d.ts:17165` and `:17242`:

```ts
type InstanceStatus = { status: "queued"|"running"|...|"complete"; error?: {...}; output?: unknown; rollback: ... };
declare abstract class WorkflowInstance { public id: string; public status(): Promise<InstanceStatus>; ... }
```

So `(await env.GATHER_WORKFLOW.get(id)).status()` yields `.output` — whatever the child's
`run()` returned. A child returns a count, which is an integer, far inside the 1 MiB
step-result cap. `output` is typed `unknown`, so the parent validates rather than casts.

**There is no blocking join.** Cloudflare documents that a parent "will not block waiting
for the child Workflow to complete". Polling is the only documented mechanism, which is
why work order step 4 has a poll loop rather than an await.

**Do not return a `WorkflowInstance` from a step body.** The docs' own examples do, while
the same docs say objects containing functions cannot be serialized. Return
`instance.id`, a string, and re-`get()` it. (Inferred from the contradiction, not
documented — but a string costs nothing and the failure mode is a replay-time throw.)

### 4. Two files still assert the premise feature 002 existed to purge, and the guard misses both

```
src/index.ts:8       "so each step gets its own CPU budget"
src/workflow.ts:167  "Keeps each parse inside its own CPU budget"
```

`cpu-premise-is-per-invocation` only matches when a CPU figure sits within 50 characters
of a per-step phrase, or in one fixed "its own <figure>" form. Neither line above carries
a figure, so both pass. Feature 002's requirement 11 — "grepping the tree for a per-step
phrase alongside a CPU figure returns nothing stale" — is satisfied while the premise
survives in two places, one of them the Worker entrypoint.

**This paragraph is itself the demonstration.** Writing it with the regex's literal
trigger strings in it made `review:checks` fail on `plan.md`, a document that asserts the
corrected premise throughout. It had to be reworded to describe the pattern instead of
quoting it. That is #77 exactly: a guard that cannot tell a subject from a mention, and
whose cost falls on whoever writes carefully about it.

Also stale: `CLAUDE.md` says "Workflows is in open beta". Workflows went
[GA on 2025-04-07](https://developers.cloudflare.com/workflows/reference/changelog/); only
*Python* Workflows is still beta.

Both are corrected in PR 2, along with the widened guard. That widening is also the
natural place to fix [#77](https://github.com/nimeshjm/blog-research-agent/issues/77) —
the same check firing on prose that asserts the premise correctly — because the two edits
touch the same regex and each needs its own mutation row.

## Files

### PR 1 — `75-plan-md` (Part 1 of 5)

| file | change |
|---|---|
| `features/003-run-to-completion/plan.md` | this file; replaces the unfilled template |

### PR 2 — `75-no-retries` (Part 2 of 5)

| file | change |
|---|---|
| `src/lib/trace.ts` | `tracedStep` passes an explicit retry policy to its single `step.do` call |
| `src/index.ts` | `:8` — the class doc comment's per-step CPU premise |
| `src/workflow.ts` | `:167` — same premise in the map-step comment |
| `CLAUDE.md` | "steps are retried" platform rule; "Workflows is in open beta" |
| `.claude/skills/cf-free-tier/SKILL.md` | the retry premise, and the limits table rows this plan now cites |
| `scripts/review-checks.mjs` | `cpu-premise-is-per-invocation`: catch figure-less per-step phrasings; stop firing on a subrequest `per step` near a CPU figure (#77) |
| `scripts/review-checks.test.mjs` | mutation rows for both directions |
| `rules/no-step-retry-config.yml` | new ast-grep rule: a `retries` config outside `src/lib/trace.ts` |
| `rule-tests/no-step-retry-config-test.yml` | its fixture |
| `test/trace.test.ts` | the policy is passed, with the exact shape |
| `REVIEW.md` | pass 1 and pass 3 markers naming the new check ids |

### PR 3 — `75-verify-no-retries` (Part 3 of 5)

Not in the original table. Work order step 2 gates PR 3 on verifying the retry policy on
a deployed Worker, and that verification produced both a record and a finding large
enough to be reviewable on its own.

| file | change |
|---|---|
| `probe/probe.ts` | `noretry`, `noretry-cpu` and `cpu` modes; an unrecognised mode is now a 400 rather than a silent fall-through to `map` |
| `probe/README.md` | the new modes, and the per-mode pass conditions, which differ and must not be swapped |
| `probe/FINDINGS.md` | §7: which reading of `limit` held. §7.1: the CPU premise this feature is built on, measured not to hold |
| `probe/captures/` | the instances, verbatim |
| `features/003-run-to-completion/spec.md` | the measured reading, and the CPU finding as a stop in the risk table |
| `features/003-run-to-completion/plan.md` | this entry, and `M` 4 → 5 |

### PR 4 — `75-gather-children` (Part 4 of 5)

| file | change |
|---|---|
| `src/gather-workflow.ts` | new: `GatherWorkflow`, one `gather:<feed>` step per feed, returns a count |
| `src/index.ts` | exports `GatherWorkflow` alongside `ResearchWorkflow` |
| `src/workflow.ts` | `run()` creates children and polls them; no feed is parsed in the parent |
| `src/lib/types.ts` | `Env` gains `GATHER_WORKFLOW`; new `GatherParams`, `GatherResult` |
| `src/lib/trace.ts` | new `agent.gather.*` attribute constants, allowlisted |
| `wrangler.toml` | second `[[workflows]]` block; `GATHER_FEEDS_PER_CHILD` var |
| `test/workflow.test.ts` | parent creates the right children, sums counts, fails on a failed child |
| `test/gather-workflow.test.ts` | new: the child's own behaviour |

### PR 5 — `75-five-runs` (Part 5 of 5, closes the tracking issue)

| file | change |
|---|---|
| `features/003-run-to-completion/spec.md` | the measured record of the five runs; `GATHER_FEEDS_PER_CHILD`'s final value and why |
| `wrangler.toml` | that value, if step 5 tunes it |
| `probe/captures/` | the five instance captures, committed as evidence |

The PR exists whatever the runs show, so its own existence never depends on the result —
the same device feature 002 used for its PR 6.

**`M` was revised anyway, 4 → 5, and by the case the device does not cover.** It protects
against a PR whose *result* is unknown; it does not protect against a step of the work
order turning out to need a PR of its own. Work order step 2's platform verification did,
so it is PR 3 and the two implementation PRs shifted down. Recorded here rather than
backdated, because the point of fixing `M` is that changing it is visible.

## Work order

### 1. `plan.md` — PR 1

This file. Nothing else.

### 2. No retries — PR 2

**The policy.** `src/lib/trace.ts` is the only permitted `step.do(` call site
(`rules/no-bare-step-do.yml`, scoped to `src/**` by #79), so this is one edit:

```ts
const NO_RETRIES: WorkflowStepConfig = { retries: { limit: 0, delay: 0 } };
```

passed as `step.do(name, NO_RETRIES, () => ...)`. `delay` is required by the type even
though nothing will wait.

**Verify it on the platform before trusting it.** The reading of `limit` is ambiguous
(question 2 above), so:

1. Deploy.
2. Trigger a run whose first step throws deliberately, or wait for a real `1102`.
3. `npx wrangler workflows instances describe research-workflow <id>` and count the
   attempt rows for that step.

**One row is the pass.** Six is the current behaviour and means the policy was ignored.
Zero completed steps at all means `0` was read as "no attempts" — fall back to
`{ limit: 1, delay: 0 }` and record which reading held, in `spec.md`. Do not proceed to
the children until this is settled: building them on a Worker that still retries would
make five consecutive runs take half an hour of backoff to fail.

**This became step 3 and PR 3.** It was measured on the probe rather than on
`research-workflow`, because answering it on production would have meant shipping a fault
injector in `src/`. `limit` is "maximum retries": one attempt row against a same-sitting
control's three, with the steps before it completing. See `probe/FINDINGS.md` §7 and
`spec.md`. The fallback is withdrawn.

### 3. Verify the policy on the platform — PR 3

The block above, carried out. It also produced a finding this plan did not anticipate and
which now gates step 4: `FINDINGS.md` §7.1 measures one `run()` execution absorbing
5x10^8 arithmetic iterations with no `1102`, four days after the same account was measured
to fail on the third feed parse in an invocation. If the ceiling in force is not 10 ms,
step 4 solves a problem that may not exist. `spec.md`'s risk table records it as a stop.

**A new guard, because the seam is only a seam while nothing bypasses it.**
`no-bare-step-do` stops a second `step.do`; nothing stops someone passing a *different*
retry config at the one permitted site. `rules/no-step-retry-config.yml` fires on a
`retries:` key outside `src/lib/trace.ts`, and `rule-tests/` proves it fires.

**The stale premises.** Fix `src/index.ts:8`, `src/workflow.ts:167`, `CLAUDE.md`'s "steps
are retried" and "open beta". Then widen `cpu-premise-is-per-invocation` so a figure-less
"its own CPU budget" is caught, and narrow it so a *subrequest* per-step phrase sitting
near a CPU figure is not (#77). Both directions need a mutation row in `scripts/review-checks.test.mjs`;
a row that passes with its guard removed is dead, so remove each and confirm red.

`CLAUDE.md`'s idempotency rule changes meaning, not existence: steps are no longer
retried, but `run()` still re-executes, so `step.do` bodies stay idempotent for the
reason `spec.md` requirement 7 gives. Rewrite the rule to say that rather than deleting it.

### 4. Gather in children — PR 4

**The child.** `src/gather-workflow.ts`:

```ts
export interface GatherParams { runId: string; sources: Source[] }
export class GatherWorkflow extends WorkflowEntrypoint<Env, GatherParams> {
  async run(event, step): Promise<number>   // total candidates written
}
```

One `gather:<feed name>` step per feed, each calling the existing `gatherCandidates`
unchanged. `runId` is the **parent's** instance id, so children write into the parent's
`run_candidates` rows and `shortlist` needs no change at all.

The child's `run()` returns the summed count. That is the value the parent reads back
through `InstanceStatus.output` (question 3).

**The parent.** In `src/workflow.ts`, the 46-iteration gather loop becomes two steps:

- `create-gather-children` — chunks `sources` by `GATHER_FEEDS_PER_CHILD`, calls
  `env.GATHER_WORKFLOW.create({ params })` per chunk, returns **the child ids as
  strings**. Idempotency: pass an explicit deterministic `id` per chunk
  (`${event.instanceId}-g${index}`) so a replay of this step re-creates nothing —
  `create` throws on a duplicate id, which the step must treat as success, and
  `createBatch` skips existing ids outright. Prefer `createBatch`; it is capped at 100
  per call and 10 children is one call.
- `await-gather-children` — polls. Each round is one `step.do` that reads every child's
  `status()`; `step.sleep` between rounds costs neither a step nor concurrency. Returns
  the summed counts once every child is `complete`. Any child `errored` or `terminated`
  fails the step, which now fails the run immediately (requirement 4, and PR 2 made that
  immediate).

`gathered` stays an integer in `run()`, as feature 002 made it. Requirement 5 holds by
construction.

**`GATHER_FEEDS_PER_CHILD` starts at 5.** The two failing runs died at feeds 10 and 11;
three runs reached 46. Five is half the lowest observed failure point, which is margin
chosen against a non-deterministic boundary rather than fitted to two points
(requirement 6). 46 feeds gives 10 children. Step budget for the parent: 1 create +
roughly 10 polls + the existing ~11 = far inside 1,024. Concurrency: 10 of 100.

**Attributes.** `agent.gather.children` (count) and `agent.gather.child_index` go on the
new spans, added to the allowlist in `src/lib/trace.ts` so
`span-attributes-allowlisted` passes. Keep to the ~8-per-span rule: attributes are CPU.

### 5. Five runs, and the record — PR 5

Deploy, then trigger five runs **consecutively**, each to a terminal state, capturing
`wrangler workflows instances describe` for the parent and at least one child of each.
Commit all captures.

Five consecutive completions is the pass. Any failure resets the count — the criterion is
five in a row, not five of seven, because the failure being measured is intermittent and
"best of" would launder exactly the luck the criterion exists to exclude.

If a run fails, read whether it failed in a child (the chunk is still too big — lower
`GATHER_FEEDS_PER_CHILD`, restart the five) or in the parent (children are not a fresh
budget after all — the spec's top risk row fired, and the finding is written up rather
than tuned around).

## Reuse

- `gatherCandidates` (`src/workflow.ts`) moves into the child **unchanged**. It already
  does one fetch, one bounded parse, one D1 write, and returns a count.
- `writeRunCandidates` / `readRunCandidates` (`src/lib/d1.ts`) unchanged. Children write
  under the parent's `run_id`; `(run_id, url)` still dedupes across children exactly as it
  dedupes across feeds today.
- `tracedStep` / `tracerFor` (`src/lib/trace.ts`) for every step in the child, same as the
  parent. `no-bare-step-do` covers `src/**`, so the child is inside it.
- `loadFeeds` (`src/lib/feeds.ts`) stays in the parent; the child receives its chunk as a
  param rather than re-reading the file.
- `probe/captures/` is the evidence pattern: commit the verbatim `describe` output at the
  moment it is taken, because feed volumes are perishable and dashboard traces expire in
  3 days (#22).
- The `Part N of M of #75` marker on PRs 1–3, `Closes` on PR 4 only. Never
  `--body-file -` (`CLAUDE.md`, "Repeated mistakes").

## Verification

### Per PR, before pushing

```bash
rtk npm run typecheck
rtk npm run lint:ast && rtk npm run test:ast
rtk npm run lint:ts
rtk npm run review:checks && rtk npm run test:checks
rtk npx vitest run
rtk npx wrangler deploy --dry-run
```

### Each new guard, by removing it

A guard that passes with its subject removed is dead. For each of
`no-step-retry-config` and both new `cpu-premise-is-per-invocation` rows: delete the
guard, confirm the check goes red, restore, confirm green. Record the pair in the PR body
— this is what `CONVENTIONS.md` means by verification re-deriving rather than believing.

### Acceptance criteria, by number

| # | how |
|---|---|
| 1 | the command block above |
| 2 | five consecutive deployed runs, captures committed (work order 5) |
| 3 | `grep -rn 'step\.do(' src/` returns only `src/lib/trace.ts`; a bare call inserted into `src/workflow.ts` fails `lint:ast` |
| 4 | one attempt row in `describe` for a deliberately failing step (work order 3). Measured on the probe, not on `research-workflow`, so this criterion stays open for PR 5 |
| 5 | terminate a child mid-run; parent errors, `runs` row status is not a success |
| 6 | re-run a child against a written `run_id`; `SELECT count(*)` unchanged |
| 7 | vitest parity case: shortlist from children == shortlist from the current path, same inputs |
| 8 | every parent step output in `describe` is an integer or an id array, never candidates |

### What would falsify the design

A parent that still fails with `1102` while its children succeed means a child instance
is not a fresh CPU budget, which `spec.md`'s risk table names as the load-bearing
untested inference. That result gets written into `spec.md` and `probe/FINDINGS.md`
rather than tuned away, and feature 003 goes back to Stage 2.
