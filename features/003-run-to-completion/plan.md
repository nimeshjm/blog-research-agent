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

**The second half of that sentence names the wrong resource, recorded 2026-08-31 (#75)
rather than quietly rewritten.** Work order step 3 measured one `run()` execution absorbing
work two orders of magnitude past the documented ceiling (`FINDINGS.md` §7.1), and run
`0199648c` then completed all 46 gather steps without a single `1102`. The premise children
were proposed to relieve does not hold. What binds is 50 subrequests shared across whatever
steps the runtime packs into one invocation: that same run failed every one of its 15
article fetches with the platform's own `Too many subrequests by single Worker
invocation.`, and a child instance is a separate invocation with its own 50. Read every CPU
justification below as the reason children were *first* proposed, not the reason they are
still wanted; `spec.md` carries the same amendment. The correction was only legible because
work order step 5 first made fifteen identical `summary: null` step outputs tell themselves
apart.

**And then CPU came back, 2026-09-01.** Run `bd33248b` killed a gather child with
`Worker exceeded CPU time limit.` after 917 items across three feeds. So the paragraph
above is not the last word either: `spec.md`'s risk table now carries both that run and
`0199648c` rather than a verdict, and work order step 8 exists because the chunking was
counting feeds while the cost being spent is items — a mismatch that holds whichever of
those two runs describes the ceiling in force.

The acceptance criterion is five consecutive completing runs, not one, because three of
five identical probe runs completed while the underlying problem was untouched.

## Four questions this plan closes before any code is written

### 1. The free-tier numbers `spec.md` said to find and cite

From Cloudflare's [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
page, read 2026-08-28. Every row here is `documented`, not inferred.

| limit | Workers Free | bearing on this design |
|---|---|---|
| Concurrent instances | **100** | 8 children per run is comfortably inside it |
| Instances waiting (`step.sleep`, retry, `waitForEvent`) | **do not count** toward concurrency | polling parents are cheap |
| Instance lifetime | **no ceiling** — "can run forever" | closes `intent.md`'s open question in the opposite direction from the way it was asked |
| Executions per day | 100,000, shared with the Workers daily request limit | ~9 instances per run is nothing |
| Creation rate | 100/sec | irrelevant at this scale |
| Steps per instance | **1,024** confirmed | see the budget below |
| `step.sleep` / `sleepUntil` | **do not count** toward the step limit | polling can sleep between rounds for free |
| Max non-stream step result | 1 MiB | a gather child returns an integer; a summarize child returns summaries bounded by `SHORTLIST_TOP_N` |

**`intent.md` asked for the instance lifetime ceiling and there is none.** Footnote 1:
*"A Workflow instance can run forever, as long as each step does not take more than the
CPU time limit and the maximum number of steps per Workflow is not reached."* The 3-day
Free figure is **retention of completed state**, not a lifetime cap. The 46-minute floor
this repo measured was never near anything.

**One caveat, recorded rather than smoothed over.** That page contradicts itself: prose
under the concurrency table says "only actively `running` instances count toward the
10,000 concurrent instance limit" while the table says 100 (Free) / 50,000 (Paid). This
plan uses the table. At this design's scale — 8 children — the two readings do not
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
`run()` returned. A gather child returns a count, which is an integer, far inside the 1 MiB
step-result cap. A summarize child cannot, because `synthesize` needs the summaries
themselves; it returns an array bounded by `SHORTLIST_TOP_N`, still two orders of magnitude
under the cap. `output` is typed `unknown`, so the parent validates rather than casts.

**There is no blocking join.** Cloudflare documents that a parent "will not block waiting
for the child Workflow to complete". Polling is the only documented mechanism, which is
why work order step 6 has a poll loop rather than an await.

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

### PR 1 — `75-plan-md` (Part 1 of 9)

| file | change |
|---|---|
| `features/003-run-to-completion/plan.md` | this file; replaces the unfilled template |

### PR 2 — `75-no-retries` (Part 2 of 9)

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

### PR 3 — `75-verify-no-retries` (Part 3 of 9)

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
| `features/003-run-to-completion/plan.md` | this entry, and `M` 4 → 5; then, in the same PR and once the rest of the work order had actually run, 5 → 8 |

### PR 4 — `75-parse-failure-modes` (Part 4 of 9)

Not in the original table, and not a deferred piece of one either. A deployed run
(`972cea0c`) died on `synthesize-draft` with "model response was not valid JSON in the
expected shape", a message true of six distinct rejections. The completion pulled from the
AI Gateway log was valid, untruncated JSON: the parser broke it. `stripCodeFence` ran
unconditionally and its regex searched anywhere in the text, so it matched a fenced `bash`
block sitting legitimately inside the draft's markdown `body` and handed `JSON.parse` a
fragment. PR 2 is what makes that fatal rather than merely wasteful — with retries off a
run dies on the first occurrence — and the five-run criterion cannot be attempted through
a step that never reaches `open-pull-request`.

| file | change |
|---|---|
| `src/lib/prompts.ts` | parse the raw text first and strip a fence only if that throws, with the fallback regex anchored so it must wrap the *whole* response; `parseMapResponse` / `parseReduceResponse` return a named failure reason instead of `null`; `normaliseCitations` makes the citation shape deterministic rather than merely requested |
| `src/workflow.ts` | `synthesizeDraft` folds the reason, the response length and the top-level key names into the thrown error — never the response text, which would reach a span |
| `test/prompts.test.ts` | every failure mode, and the one deliberate narrowing: JSON wrapped in prose used to parse by accident and now does not |
| `test/workflow.test.ts` | the diagnosis survives into the error message |

### PR 5 — `75-summarize-skip-reasons` (Part 5 of 9)

Not in the original table, and the reason the two PRs after it are shaped the way they
are. A 46-feed run (`525a5386`) completed all 46 gather steps with no `1102` and then
returned `{"summary": null, "neurons": 0}` from every one of its 15 `summarize` steps —
`insufficient_sources`, zero inference spent, and no way to tell one shared cause from
fifteen unrelated ones, because `summarizeArticle`'s five early returns were byte-identical
to the caller. Naming them is what made the next fact readable: all fifteen skipped on the
platform's own `Too many subrequests by single Worker invocation.`, which is how the
50-subrequest ceiling turned out to be charged per invocation rather than per step. PR 6
rests on that fact and was planned against a different one.

| file | change |
|---|---|
| `src/workflow.ts` | `SummarizeSkipReason` — `fetch-threw`, `http-error`, `empty-extract`, `truncated`, `unparseable` — reaches the step output, with a truncated message or an HTTP status where one exists |
| `src/lib/trace.ts` | `agent.summarize.skip_reason`, allowlisted; the finer diagnostics stay in the step output, which is a permitted channel where a span attribute is not |
| `CLAUDE.md` | the 50-subrequest platform rule, "per step" → per invocation, with the run that measured it |
| `.claude/skills/cf-free-tier/SKILL.md` | the same correction |
| `features/003-run-to-completion/spec.md` | the amendment: the design survives, on a different resource than the one it was argued from |
| `test/workflow.test.ts` | each of the five skip paths is distinguishable |

### PR 6 — `75-gather-children` (Part 6 of 9)

The rationale changed under this entry; the substance did not. Children were proposed to
buy a fresh CPU budget, and run `0199648c`'s 46 clean gather steps killed that premise
(PR 3, and `FINDINGS.md` §7.1). What binds is 50 subrequests per invocation, and a child
instance is a separate invocation. The mechanism in the table is unaffected. What moves is
`GATHER_FEEDS_PER_CHILD`'s justification and, with it, its value — 10 rather than 5, for
the arithmetic in work order step 6.

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

### PR 7 — `75-summarize-children` (Part 7 of 9)

Not in the original table, because the original table assumed moving gather out was
enough. Run `6f75e460` settled both halves of that in one sitting. Gather in children
works — five children complete in 5-8 seconds, 264 candidates, and a parent that had
summarised 0 articles summarised 14 — so a child instance **is** a fresh subrequest
budget, and the load-bearing untested inference `spec.md`'s risk table named is closed by
measurement rather than by argument. The same run then failed its 15th article with `Too
many subrequests by single Worker invocation.` and never reached `synthesize`, so moving
only gather is insufficient. Article summarisation moves the same way, through a second
child class rather than one parameterised child: `createBatch` is typed on its params and
each child's `output` needs its own validator, so a class per shape keeps both call sites
monomorphic, which is worth more than the file it costs.

| file | change |
|---|---|
| `src/summarize-workflow.ts` | new: `SummarizeWorkflow`, one `summarize:<url>` step per candidate — the parent's own step name, moved unchanged so the replay key is the same — returning the summaries and this child's neuron spend |
| `src/lib/workflow-children.ts` | new: `childExists`, `createChildBatch`, `pollChildBatch` — the create-and-poll seam both child classes share, with the gather helpers refactored onto it rather than a second copy left to drift |
| `src/workflow.ts` | `run()` creates and polls summarize children; no article is fetched or summarised in the parent |
| `src/lib/types.ts` | `Env` gains `SUMMARIZE_WORKFLOW` and `SUMMARIZE_ARTICLES_PER_CHILD`; new `SummarizeParams`, `SummarizePollResult` |
| `src/lib/trace.ts` | `agent.summarize.children` and `agent.summarize.child_index`, allowlisted |
| `src/index.ts` | exports `SummarizeWorkflow` |
| `wrangler.toml` | third `[[workflows]]` block; `SUMMARIZE_ARTICLES_PER_CHILD` var |
| `test/summarize-workflow.test.ts` | new: the child's own behaviour, including its slice of the neuron budget |
| `test/workflow.test.ts` | the parent's second create-and-poll pair, and the bound on what it returns |

### PR 8 — `75-volume-chunking` (Part 8 of 9)

Not in the original table. Run `bd33248b` killed gather child `g0` with `Worker exceeded
CPU time limit.` while its four siblings completed: `GATHER_FEEDS_PER_CHILD` chunks by
feed count, and one chunk drew both arXiv feeds. Parse cost scales with items, so the
knob was never measuring the thing that binds — arXiv cs.AI alone is 783 of the
allowlist's 1,117 items. Step 8 of the work order below is what this PR is.

| file | change |
|---|---|
| `src/lib/d1.ts` | `readSourceWeights` — mean candidates per source per distinct run, excluding the run being chunked |
| `src/workflow.ts` | `chunkSourcesByVolume` (greedy LPT over a fixed child count) replaces the count-based slicing; `DEFAULT_SOURCE_WEIGHT`; the fixed-cost recount for the parent's extra D1 call |
| `wrangler.toml` | `GATHER_FEEDS_PER_CHILD`'s changed role — a feed-count cap and the child-count divisor, not a CPU knob |
| `features/003-run-to-completion/spec.md` | requirement 3's amendment, the dated calibration table, and the CPU-premise risk row rewritten to carry both runs |
| `features/003-run-to-completion/plan.md` | this entry, `M` 8 → 9, and the work-order step |
| `probe/captures/` | the failed run's parent and all five gather children, verbatim |
| `CLAUDE.md` | the CPU platform bullet gains today's measurement: items, not feeds |
| `.claude/skills/cf-free-tier/SKILL.md` | the same correction, as PRs 2 and 5 both did |
| `test/workflow.test.ts`, `test/d1.test.ts` | the chunker's cases, and the weight query's |

### PR 9 — `75-five-runs` (Part 9 of 9, closes the tracking issue)

| file | change |
|---|---|
| `features/003-run-to-completion/spec.md` | the measured record of the five runs; `GATHER_FEEDS_PER_CHILD` and `SUMMARIZE_ARTICLES_PER_CHILD`'s final values and why |
| `wrangler.toml` | those values, if step 9 tunes them |
| `probe/captures/` | the five instance captures, committed as evidence |

The PR exists whatever the runs show, so its own existence never depends on the result —
the same device feature 002 used for its PR 6.

**`M` was revised anyway, 4 → 5 → 8 → 9, and every time by the case the device does not
cover.** It protects against a PR whose *result* is unknown; it does not protect against a
step of the work order turning out to need a PR of its own. Work order step 2's platform
verification did, so it is PR 3 and the two implementation PRs shifted down. Then it
happened three more times, each for the same reason and each found by deploying rather than
by reading: a parser bug a real run surfaced and that no requirement here covers (PR 4);
the summarize instrumentation that bug's fix made necessary before the *next* failure could
be read at all (PR 5); and article summarisation, once run `6f75e460` measured
gather-in-children to be necessary but not sufficient (PR 7). Recorded here after the fact
rather than backdated, because the point of fixing `M` is that changing it is visible — a
plan that quietly said 8 all along would have hidden three findings.

**8 → 9 on 2026-09-01, and this one is not a new case — it is the same one a fifth time.**
Run `bd33248b` died in a gather child, and the fix is not a tuning of a number the
five-runs step could have made on the way past: `GATHER_FEEDS_PER_CHILD` was measuring
feeds while the cost being spent is items, so the chunking itself changes. That is a PR
(8), and the five runs shift to 9. What is worth noticing is which of the two PRs before it found this:
neither. Both were green on every check and both deployed; the run is what found it, the
fourth time in this build that a step of the work order turned into a PR of its own by
being deployed rather than by being read.

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
which now gates step 6: `FINDINGS.md` §7.1 measures one `run()` execution absorbing
5x10^8 arithmetic iterations with no `1102`, four days after the same account was measured
to fail on the third feed parse in an invocation. If the ceiling in force is not 10 ms,
step 6 solves a problem that may not exist. `spec.md`'s risk table records it as a stop.

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

### 4. Parse failure modes — PR 4

Not planned, and it had to come before the children: `synthesize-draft` was failing on a
*valid* completion, and a run that dies there never reaches `open-pull-request`, so the
five-run criterion cannot be attempted through it. Fix `stripCodeFence` — parse the raw
text first, strip a fence only if that throws, and anchor the fallback so a fence must
wrap the whole response rather than merely appear inside it — and give every rejection a
name, because one message covering six of them is what made the deployed failure
unreadable.

The narrowing this accepts is deliberate and verified rather than assumed: JSON surrounded
by prose used to parse by accident under the search-anywhere regex and now returns
`invalid-json`, which is the shape the reduce prompt has always asked for. None of the
eight requirements covers parse diagnosability, so `spec.md` is untouched by this step —
the honest reading rather than an omission, because the bug was in a step this feature does
not move.

### 5. Summarize skip reasons — PR 5

Also not planned, and the step that produced the fact step 6 now rests on. Five early
returns in `summarizeArticle` shared one `{ summary: null, neurons: 0 }`, so a run that
skipped all fifteen articles looked identical whether that was one shared cause or fifteen
separate ones. Name them, and put the name where a `describe`d step output carries it —
after run `525a5386` that was the only channel left to read, since the span attributes
deliberately carry no message and no URL.

The answer contradicted what step 6 was planned for. All fifteen skips were the platform's
own subrequest error, so the ceiling in force is 50 subrequests shared across whatever
steps the runtime packs into one invocation, and CPU is not what bites. Correct
`CLAUDE.md`, the `cf-free-tier` skill and `spec.md` in the same PR, on the principle step 3
used for the CPU premise: a sentence measured wrong is replaced by the measurement, not
softened.

### 6. Gather in children — PR 6

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
  per call and a handful of children is one call.
- `await-gather-children` — polls. Each round is one `step.do` that reads every child's
  `status()`; `step.sleep` between rounds costs neither a step nor concurrency. Returns
  the summed counts once every child is `complete`. Any child `errored` or `terminated`
  fails the step, which now fails the run immediately (requirement 4, and PR 2 made that
  immediate).

`gathered` stays an integer in `run()`, as feature 002 made it. Requirement 5 holds by
construction.

**`GATHER_FEEDS_PER_CHILD` shipped at 10, not 5.** The 5 this plan chose was half the
lowest observed *CPU* failure point — the two failing runs died at feeds 10 and 11, three
reached 46 — margin against a boundary step 5 then measured not to be the binding one.
Against subrequests the number is arithmetic rather than empirical: `gatherCandidates`
costs one fetch plus one D1 `batch()` per feed, two subrequests, so 10 feeds is 20 of a
child's 50 with room left for redirects. 46 feeds gives 5 children. Requirement 6 is
untouched by the change, which is the point of it: no requirement asserts that N feeds fit
and N+1 do not.

**What sizes the number is the parent, not the child.** Every `instance.status()` poll is a
subrequest charged to the *parent's* invocation, so fewer, fatter children mean fewer
status reads per round while more feeds ride on each round.
`GATHER_POLL_SUBREQUEST_BUDGET` fixes the parent's share at 10, which at 5 children is 2
rounds; past its cap the poll step throws, rather than letting the platform's own opaque
subrequest error be the first sign anything is stuck. Step budget for the parent: 1 create
plus roughly 2 poll rounds for gather, 1 create plus roughly 5 for summarize, on top of the
residue — far inside 1,024. Concurrency: 5 gather children and 3 summarize children, 8 of
100.

**Attributes.** `agent.gather.children` (count) and `agent.gather.child_index` go on the
new spans, added to the allowlist in `src/lib/trace.ts` so
`span-attributes-allowlisted` passes. Keep to the ~8-per-span rule: attributes are CPU.

### 7. Summarize in children — PR 7

Step 6 was written as though the parent's residue once gather left — roughly 15 article
fetches, 16 model calls and its D1 traffic — fit inside 50. Run `6f75e460` measured it not
to: the 15th article failed with the platform's subrequest error and `synthesize` was never
reached. The same run closed the question step 6 rests on, in the design's favour — five
gather children completed in 5-8 seconds and the parent went from summarising 0 articles to
14 — so a child instance is a fresh budget, and the answer is to use another one rather
than to tune the first.

**A second class, not a parameter.** `SummarizeWorkflow` repeats `GatherWorkflow`'s shape
rather than generalising it, because `createBatch` is typed on its params and each child's
`output` needs its own validator; one parameterised child would make both of those
polymorphic in order to save a file. What the two genuinely share — `childExists`,
`createChildBatch`, `pollChildBatch` — moves to `src/lib/workflow-children.ts`, and the
gather helpers are refactored onto it in the same PR so there is one create-and-poll story
rather than two that drift.

**A summarize child cannot return a count.** `synthesize` needs the summaries themselves.
Requirement 5 is therefore held to its size claim rather than to its literal word:
`await-summarize-children`'s output is bounded by `SHORTLIST_TOP_N`, fixed regardless of
how large the allowlist is or how many children the run splits into. `spec.md`'s extension
records that reading, and acceptance criterion 8 below is restated against it — two of the
parent's step outputs were already arrays of child ids before this step, so "an integer"
was never the literal test.

**`SUMMARIZE_ARTICLES_PER_CHILD` is 5.** One article fetch plus one AI binding call per
candidate is two subrequests, so 5 candidates is 10 of 50 — more margin than gather's 20,
deliberately: an article's host is whatever a feed happened to link to, not an RSS host
this run has already reached once. `SHORTLIST_TOP_N`'s 15 gives 3 children.

### 8. Volume-balanced chunking — PR 8

Step 6 sized `GATHER_FEEDS_PER_CHILD` against subrequests and left CPU to requirement 6.
Run `bd33248b` (2026-09-01) then killed child `g0` with `Worker exceeded CPU time limit.`
after it had parsed 917 items across three feeds — cs.SE (80), cs.AI (783), OpenAI (54) —
and died on its fourth, Cloudflare, at 20. Its four siblings completed. Chunking by feed
count gave one child 70% of the allowlist's items, and no feed count could have said so.

**What changes.** `chunkSourcesByVolume` (`src/workflow.ts`) distributes sources across
the *same* number of children — `ceil(sources.length / GATHER_FEEDS_PER_CHILD)`, still 5
— greedy longest-processing-time-first: heaviest source into the least-loaded child with
room. `GATHER_FEEDS_PER_CHILD` keeps its name and loses its implied job: it is the
per-child feed-count cap (the child's own 50 subrequests) and the child-count divisor,
never a CPU knob.

**What does not change, deliberately.** The child count. `pollChildBatch` derives
`max(1, floor(GATHER_POLL_SUBREQUEST_BUDGET / childCount))` rounds, so six children leave
the parent one poll round and no retry — raising the count to spread volume would trade a
child-side failure for a parent-side one. And there is **no per-child item cap**: that
would assert N items fit and N+1 do not, which requirement 6 forbids. See `spec.md`'s
amendment for why balancing across a fixed count asserts no boundary at all.

**Where the weights come from.** `readSourceWeights` (`src/lib/d1.ts`) averages
`run_candidates` per source per *distinct run*, not per row — a plain `COUNT(*)` would
score a feed by how many runs it appeared in. It excludes the current `run_id`, which is
load-bearing rather than tidy: this run's own children write under it as they complete, so
counting them would make a replay of `create-gather-children` compute different weights
and different chunks behind child ids that stayed identical. A source with no history
takes `DEFAULT_SOURCE_WEIGHT`; with every weight equal, greedy placement is round-robin,
which is what the count-based chunking did and is a fine floor for a first run.

**Cost to the parent.** One D1 call, so `create-gather-children` is 2 subrequests rather
than 1 and the fixed-cost recount in `createSummarizeChildren`'s comment goes from ~21 to
~22 of 50, ~47 with both poll budgets.

### 9. Five runs, and the record — PR 9

Deploy, then trigger five runs **consecutively**, each to a terminal state, capturing
`wrangler workflows instances describe` for the parent and at least one child of each.
Commit all captures.

Five consecutive completions is the pass. Any failure resets the count — the criterion is
five in a row, not five of seven, because the failure being measured is intermittent and
"best of" would launder exactly the luck the criterion exists to exclude.

If a run fails, read where. A failure inside a gather child means its chunk is still too
big — and after step 8 the lever is no longer only `GATHER_FEEDS_PER_CHILD`. Read the
child's per-step outputs: if the volumes came out balanced and the chunk still died, the
per-child ceiling is lower than the allowlist's mean and the feed count has to come down
(which also raises the child count, so check the poll-round arithmetic before doing it);
if they came out unbalanced, the weights are wrong and `readSourceWeights`' window is what
to look at, not the cap. For a summarize child it is still `SUMMARIZE_ARTICLES_PER_CHILD`.
Either way, restart the five. A
failure in the parent means the residue left after both moves does not fit 50 after all,
and the term to suspect first is `shortlist`: `findSeenUrls` chunks 100 URLs per D1 query,
which scales with candidates rather than with feeds, and `spec.md` records it as
deliberately unmitigated. That finding is written up rather than tuned around.

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
- The `Part N of M of #75` marker on PRs 1–8, `Closes` on PR 9 only. Never
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
| 2 | five consecutive deployed runs, captures committed (work order 9) |
| 3 | `grep -rn 'step\.do(' src/` returns only `src/lib/trace.ts`; a bare call inserted into `src/workflow.ts` fails `lint:ast` |
| 4 | one attempt row in `describe` for a deliberately failing step (work order 3). Measured on the probe, not on `research-workflow`, so this criterion stays open for PR 9 |
| 5 | terminate a child mid-run; parent errors, `runs` row status is not a success |
| 6 | re-run a child against a written `run_id`; `SELECT count(*)` unchanged |
| 7 | vitest parity case: shortlist from children == shortlist from the current path, same inputs |
| 8 | every parent step output in `describe` is an integer, an array of child ids, or the `SHORTLIST_TOP_N`-bounded summaries `synthesize` needs — never a list whose size follows the feed allowlist or the child count. `spec.md`'s extension records why the size claim, rather than the word "integer", is what this holds to |

### What would falsify the design

The original answer here was a parent that still fails with `1102` while its children
succeed, which would have meant a child instance is not a fresh CPU budget — the
load-bearing untested inference `spec.md`'s risk table named. Both halves of that are now
settled, and neither the way this section expected: `1102` is not the failure in force
(`FINDINGS.md` §7.1), and run `6f75e460` measured a child to be a fresh *subrequest*
budget, so the risk row is struck through rather than open.

What remains falsifiable is narrower, and arithmetic rather than inferential: a parent that
exhausts 50 subrequests on its residue alone — `shortlist`, `synthesize`,
`open-pull-request` and its own poll rounds — with both gather and summarisation already
out of its invocation. The term to suspect is `findSeenUrls`, whose 100-URLs-per-query
chunking scales with candidates and which `spec.md` records as deliberately unmitigated.
That result gets written into `spec.md` and `probe/FINDINGS.md` rather than tuned away,
and feature 003 goes back to Stage 2.
