# `probe/` — a throwaway instrument for feature 003

Not part of the Worker. `main` is `probe/probe.ts`, deployed as its own Worker
(`research-probe`) with its own Workflow (`probe-workflow`) and **no `DB`, `AI` or
`AI_GATEWAY` binding**. It must never move into `src/`: a merge to `main` deploys `src/`
via `.github/workflows/deploy.yml`, and feature 003's `plan.md` is still the unfilled
template.

## The question

`features/002-gather-without-accumulation/spec.md` records that a step boundary buys
*something*, and specifically not a fresh CPU budget. Nobody has measured what. Feature
003's `intent.md` turns that into its sharpest open question, together with a second one
the 2026-08-27 run raised: `gather:The Pragmatic Engineer` failed six times across five
minutes of backoff with an identical `1102`, so **does a retry get a fresh invocation at
all?**

## How it measures

Step output is the channel. `wrangler workflows instances describe` returns every
completed step's persisted output, so a step that returns an object describing the
invocation it ran in makes the boundary map readable with no D1, no tracing and no
dashboard.

Every step returns `{ r, iso, seq, ms }`:

| field | scope | what a change means |
|---|---|---|
| `r` | generated at the top of `run()` | `run()` re-executed — a replay boundary |
| `iso` | module scope, lazily initialised | a fresh isolate |
| `seq` | module-scope counter | how many step bodies this isolate has run |
| `ms` | since this `run()` execution began | wall-clock inside the execution |

`r` alone cannot separate "a fresh invocation" from "a re-entry into `run()` in the
isolate that was already serving". `iso` alone cannot see a boundary at all, because
isolate reuse is real. The pair is what makes the map interpretable.

`ISO` initialises on first use rather than at module evaluation because **random values
are unavailable at global scope in Workers**.

## The one deliberate divergence from production

`gatherCount` is `gatherCandidates` (`src/workflow.ts`) with `writeRunCandidates`
removed and the count returned instead. `parseFeed`, `applyGatherWindow` and the
`ParseBound` construction are imported from `src/lib/feed.ts` **unmodified** — a probe
carrying its own parser would measure its own parser.

Dropping the D1 write removes an I/O await and a `JSON.stringify` from between
consecutive parses, and per-gather D1 I/O was a candidate explanation for the boundaries
production already gets. So this maps boundaries **without** that write, which is a
different question from where they fall in production:

- boundaries appear anyway → the D1 write is not what creates them
- no boundaries where production reached nine feeds → the D1 write is promoted, not ruled out

Do not let `spec.md` read the probe's map as production's.

## Running it

```bash
npx wrangler deploy -c probe/wrangler.toml            # from the repo root
curl -sX POST https://research-probe.<subdomain>.workers.dev \
  -H 'content-type: application/json' \
  -d "{\"mode\":\"map\",\"feeds\":$(cat config/feeds.json)}"
npx wrangler workflows instances describe probe-workflow <id>
```

`mode` is `map` (one step per feed, in the order given), `sleep`, `retry`, `noretry`,
`noretry-cpu`, `cpu`, `childerr`, `childcpu`, `childrestart`, `childrestartfrom` or
`childrestartof`.
**An unrecognised mode is rejected with 400** — it used to fall
through to the gather loop, where a run with no `feeds` reads back as "the thing under
test did nothing", which is the exact false negative these runs exist to avoid. `feeds`
became optional when the child modes arrived, so `map` and `sleep` without a non-empty
`feeds` array are **also 400** — the same false negative from the other side — and
`childrestartof` without a `childId` is 400 for the same reason.
Reordering
the `feeds` array is how the position of a feed is varied — putting The Pragmatic
Engineer first is the experiment that separates "that feed is too expensive on its own"
from "the tenth step has no budget left".

`sleep` is `map` plus an `await step.sleep(...)` after every `everyN`th gather step, for
`sleepFor` (a Workflows duration string, or a number of milliseconds):

```bash
-d "{\"mode\":\"sleep\",\"everyN\":1,\"sleepFor\":\"60 seconds\",\"feeds\":$(cat config/feeds.json)}"
```

The gather steps are byte-identical to `map`'s and return the same marker, so a `sleep`
map is directly comparable with a `map` one — the only difference is the `s00:sleep`
steps between them. `everyN` defaults to 1 and is clamped to at least 1; `sleepFor`
defaults to one second. The question it answers is whether `step.sleep` ends the `run()`
execution and with it the CPU budget that execution has been accumulating, which feature
002's `spec.md` defers as "forcing an invocation boundary per gather step" and nobody has
measured.

Read the answer off two axes, which can disagree — and weight them unequally:

| axis | reads | weight |
|---|---|---|
| `r` / `iso` / `seq` across each sleep | **whether a boundary happened** | strong: `everyN: 1` over 46 feeds gives 45 crossings per run |
| how many feeds complete before `1102` | **whether the budget reset** | weak: `map` over the same 46 feeds both completes and dies (`FINDINGS.md` §4), so one run's outcome is a coin |

Use `ms` to name the mechanism. It is measured from the top of the `run()` execution `r`
identifies, so it distinguishes a sleep that suspended nothing from one that did:

| `r` | `seq` | `ms` on the step after the sleep | reading |
|---|---|---|---|
| same | +1 | grown by the sleep's own duration | an in-process await; no boundary |
| new | +1, continuing | reset, carrying no sleep time | `run()` re-executed in the same isolate |
| new | back to 0 | reset, carrying no sleep time | `run()` re-executed in a fresh isolate |

Because `map` and `sleep` share the gather loop, a payload whose `mode` is misspelled
runs as a plain `map` and reads back exactly like "the sleep did nothing". Check the
`s*:sleep` steps are present in the capture before believing a negative.

`retry` ignores `feeds`. It runs two cheap marker steps, then a step that throws for the
first ~25 s of instance life; with Workflows' default 10/20/40 s backoff the first two
attempts throw and the third returns. Elapsed-since-instance-start is the trigger because
a step body has no attempt counter and module-scope state cannot supply one — if the
retry gets a fresh isolate the flag resets and the step throws forever, and if it does
not, the step never succeeds. A clock read survives both.

Compare `retry:fails-then-passes`'s `r` and `iso` against `retry:before-2`'s. Different
`r` means the retry ran in a separate `run()` execution.

`noretry`, `noretry-cpu` and `cpu` were added 2026-08-31 for feature 003's gate on PR 3:
does `retries: { limit: 0, delay: 0 }` — what `src/lib/trace.ts` now passes at
production's one `step.do` call site — actually suppress retries, and does `limit: 0`
mean *no attempts at all*? The value is written out in `probe.ts` rather than imported
from `src/lib/trace.ts`, because a probe importing production's constant would stop
measuring the platform and start tracking a later edit.

| mode | shape | policy | reads |
|---|---|---|---|
| `noretry` | two markers, then a step that always throws | `NO_RETRIES` | attempt rows on the throwing step; **and** whether the markers ran at all |
| `retry` | as above but the step stops throwing after ~25 s | platform default | the same-sitting control |
| `noretry-cpu` | two markers, then 5x10^8 arithmetic iterations | `NO_RETRIES` | whether the policy also covers a `1102` |
| `cpu` | as above | platform default | its control |

Pass conditions differ per run and must not be swapped:

- **`noretry`** — the markers complete *and* the throwing step shows exactly one attempt
  row. The markers are the half that rules out `limit: 0` meaning "never run".
- **`noretry-cpu` / `cpu`** — attempt rows on the burn step only. A missing marker row
  here says nothing about `limit`: the markers may share the invocation the kill lands
  in.

### The child modes

Added 2026-09-02 for [#92](https://github.com/nimeshjm/blog-research-agent/issues/92),
which cannot have a recognition rule written for it until two facts are read off the
deployed platform. They ignore `feeds` and use a **second Workflow**,
`probe-child-workflow` (binding `PROBE_CHILD`, class `ProbeChildWorkflow`), whose whole
body is two `mark()` steps and then a step that throws — production's shape, where
summarize child `s0` had completed three real `summarize:<url>` steps before the fourth
died. All three steps pass `NO_RETRIES`, so the throw errors the child on its first
attempt.

The thrown error is the instrument. It carries **three mutually distinguishable tokens**:

```ts
class ProbeCtorWWW extends Error { override name = 'ProbeName-ZZZ'; }
throw new ProbeCtorWWW('ProbeMessage-QQQ');
```

`name` is a class field rather than a post-construction assignment so it is in place
before anything — including a `.stack` read, whose header the runtime formats from name
and message — can observe the error. `childcpu` is the other half of the same question:
the fail-closed allowlist has to *exclude* a CPU kill, so it swaps the throw for
`burnCpu(iters)` and prints what the platform's own `1102` puts in that object rather than
inferring it from a rendering. Pass `iters`; 5x10^9 is the lowest value section 7.2
measured to kill reliably. Which of the three tokens turns up where in the
child's `describe` output, and in the `status.error` object the parent captures, is what
fixes the renderer's formula; inverting that formula on
`captures/54ce776b-ad41-4562-bf34-1984b47464eb-s0.txt` is what says which field a
`WorkflowInternalError` rule must read. See `FINDINGS.md` section 8.

| mode | shape | reads |
|---|---|---|
| `childerr` | create a child, poll `status()` to `errored` | `Object.keys(status)`, `JSON.stringify(status)`, `status.error.name` / `.message` |
| `childcpu` | as `childerr`, but the child burns `iters` instead of throwing | the same object for a **platform-originated** failure — a real `1102` |
| `childrestart` | as `childerr`, then `restart()` | whether the method exists, and whether an `errored` instance accepts it |
| `childrestartfrom` | as `childerr`, then `restart({ from })` | the same, for a restart from the failing step |
| `childrestartof` | **no create** — restart the `childId` given, then poll | whether a restarted instance ever moves, and whether it kept its earlier steps |

The child id is `<parent instance id>-ce` / `-cc` / `-cr` / `-crf`, derived from
`event.instanceId` so a replay of `run()` recreates the same child rather than measuring
a second one, and distinct per mode so no two collide. `childrestartof` is the exception:
it is given an id and creates nothing.

Every step that could be killed by the platform call it is testing **catches** instead:
`restart()`'s outcome is recorded as `resolved` or `threw` with the caught error's `name`,
`message`, `constructor.name` and `String(e)`, and `typeof instance.restart` plus
`Object.getOwnPropertyNames(Object.getPrototypeOf(instance))` are recorded *before* the
call. The point of these runs is the returned value, not the failure — a step that let
the throw propagate would record nothing.

`childrestartof` exists because the first two restart modes could not answer their own
question. A restarted instance's `describe` comes back with **zero step rows**, so its own
step rows cannot also be the baseline they would have to be compared against. So it takes
`childId` and restarts a child *some earlier run created and captured*, with
`rounds` and `interval` overridable because 8 rounds of 5 s was measured to be far too
short to see a restarted instance move:

```bash
curl -sX POST https://research-probe.<subdomain>.workers.dev \
  -H 'content-type: application/json' \
  -d '{"mode":"childrestartof","childId":"<an errored child id>","rounds":20,"interval":"30 seconds","from":true}'
npx wrangler workflows instances describe probe-child-workflow <that child id>
```

**Read both readback channels, because they disagree.** `wrangler workflows instances
describe <id>` and the binding's own `status()` both reported a restarted child as
`queued` with `error: null`; `wrangler workflows instances list` reported the same
instance `Errored`. `list`'s `Modified` timestamp is what separates them — it predates the
restart, so that row is a pre-restart value the restart never updated. Section 8 records
both. A run that reads only one channel will state the wrong fact confidently, and the
`list` reading is the wrong one.

`cpu` mode is also the only thing here that reads the CPU ceiling directly. It is not a
CPU *figure* — the burn either survives or does not — but "one `run()` execution absorbed
5x10^8 iterations" is a lower bound where `FINDINGS.md` previously had nothing. See
section 7.1, where both burns survived.

## Typecheck

`npm run typecheck` covers `src/` and `test/` only. This directory has its own config:

```bash
npx tsc -p probe/tsconfig.json
```

## Tearing it down

The deployed Worker is **public and unauthenticated, and it fetches whatever URLs the
request body names**. That is acceptable for a measurement that takes minutes; it is not
something to leave standing. Tear it down once the captures in `probe/captures/` are
committed:

```bash
npx wrangler delete -c probe/wrangler.toml
```

**That deletes the Worker only.** Measured 2026-08-28: after `wrangler delete` the public
URL returns 404, but `probe-workflow` still appears in `wrangler workflows list` and its
instances stay readable. Removing the workflow is a second, separate command, and it is
the one that takes the instances with it:

```bash
npx wrangler workflows delete probe-workflow
npx wrangler workflows delete probe-child-workflow
```

There are **two** workflows to delete since the child modes arrived, and the second one
is easy to leave standing — it is not the one named in every other command here.

Which is why `FINDINGS.md` cites the committed captures in `probe/captures/` rather than
live readback: after that second command there is nothing left to read.
