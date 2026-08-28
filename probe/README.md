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

`mode` is `map` (one step per feed, in the order given), `sleep` or `retry`. Reordering
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
```

Which is why `FINDINGS.md` cites the committed captures in `probe/captures/` rather than
live readback: after that second command there is nothing left to read.
