# Intent: Run to completion

> Stage 1. Awaiting approval — [#76](https://github.com/nimeshjm/blog-research-agent/issues/76).

## Problem

The pipeline has still never completed a run. Feature 002 shipped and measurably helped:
the manually triggered run against deployed commit `c828e7d` (instance
`ffa1add2-e4b6-4ac4-b318-97254466a2bf`, 2026-08-27 20:51 UTC) reached feed 9 of 46
before dying, against feed 5 of 46 for the pre-002 run — candidates now persist to D1 as
they are gathered, arXiv's full announcement day is no longer truncated, the dead
instance left a `runs` row (the first row that table has ever held, a feature 001
requirement that until then had never once been satisfied), and its topic is recoverable
on its own rather than stranded. All of that is real. None of it is acceptance criterion
5: a full 46-feed run completing. The failing run still ended the same way the first one
did, `Worker exceeded CPU time limit` (Workers error `1102`): it gathered nine of the 46
feeds, then died on the tenth, `gather:The Pragmatic Engineer-1`, five minutes in.

Feature 002 also measured the lever it built — bounding the parse to stop reading once a
feed runs a fixed number of items past the recency window — and the measurement is not
kind to it. Run against all 46 feeds, nine repetitions each, the bound achieves a 0.798
aggregate CPU ratio, a real 20% saving. But the saving is not spread evenly: it is
concentrated almost entirely in one feed, OpenAI's archive, where the ratio is 0.174 and
209 of the total 254 ms saved comes from that one source now reading 71 of its 1,155
items instead of the whole thing. The feeds now in the failing window are not ones where
that shape of saving is available: The Pragmatic Engineer carries 20 items, all of them
recent, so the stop never fires and the bound cannot help — though that is inferred from
its item count, because `spec.md`'s per-feed table covers OpenAI, arXiv cs.AI, DX,
Pinecone and Perplexity and has no measurement of it at all. There is no second OpenAI
left to find, and whatever is consuming the budget where the run now dies is a cost
bounding the parse does not touch.

The sharper puzzle in the same run is not about totals. `gather:The Pragmatic Engineer`
failed **six** times — 21:51:09, :19, :39, 21:52:19, 21:53:39, 21:56:19, Workflows'
default exponential backoff — with an identical `1102` on every attempt, five minutes
end to end. In the same run, `gather:arXiv cs.AI` parsed a *larger* feed (743 KB, 352
items, every one of them in-window so the bound never fires) and passed on its first
attempt. Whatever is exhausted by the tenth feed is not simply the size of the tenth
feed.

Feature 002 also disposed of the only explanation anyone had offered for that pattern.
Issue #61 proposed — flagged there as less certain and worth confirming during the spec
— that a retry could never pass because `run()` re-executes from the top on replay and
had to rehydrate every completed step's persisted candidates and re-run
`candidates.push(...found)` over them. Feature 002 deleted that accumulation: `gather`
returns an integer and `run()` accumulates nothing. The deterministic retry survived
unchanged, five identical failures becoming six. The hypothesis is refuted and nothing
has replaced it.

What the repo does record is that a step boundary buys *something*, and specifically not
a fresh budget — `spec.md` says exactly that, on the evidence that a local bench
replicating the gather loop inside one invocation failed on its third feed while
production reached its sixth step. Nobody has measured what that *something* is, when it
happens, or whether a retry gets one. Every design this feature could reach for depends
on the answer, which is why that, and not a shortfall of CPU in the abstract, is the crux
of what is unresolved.

The pipeline has run zero times to completion since it was built. The cron trigger that
would run it every two days is paused (#64) precisely because an incomplete run silently
eats its topic and produces nothing anyone would notice as a failure, and it stays
paused until a run completes — not until this feature merges. So the cost is not a
missed post every two days; it is that the agent has not yet produced a single pull
request through the path it was built for, and the condition for turning the schedule
back on has not been met.

## Outcome

A run completes. Specifically:

- A full run against the deployed Worker, all 46 feeds, reaches `shortlist` without any
  step reporting `Worker exceeded CPU time limit`.
- The cron trigger can be restored, because the condition #64 is waiting on — a
  completed run — is finally true. Restoring it is not this feature's work, but this
  feature is what makes restoring it a defensible decision rather than a hopeful one.
- Whatever is actually bounding — or already resetting — CPU budget across a run's steps
  is known and recorded, rather than inferred from documentation that feature 002 already
  found to be wrong once.
- Adding the 47th feed to `config/feeds.json` is a decision made on measured headroom,
  not a bet that the run happens to still fit.

## Constraints

- **Cloudflare free tier, unchanged.** No paid plan. The fix lives inside the existing
  10 ms-per-invocation CPU allocation, the 50-subrequest ceiling on any one step, and
  the 10,000-neuron daily budget — none of them move.
- **1,024 steps per Workflow instance.** Recorded in `.claude/skills/cf-free-tier/`
  and in both feature specs, from documentation rather than measurement; a run uses
  around 67 today, so nothing has tested it. An instance lifetime ceiling is assumed to
  exist as well, but the repo records **no number and no citation** for it anywhere,
  which makes it an open question below rather than something a design can be sized
  against.
- **Steps are retried.** Every `step.do` body added or changed must be safe to run
  twice; feature 002 already made the gather write path idempotent and that has to keep
  holding.
- **No behavioural regression in what gets published.** The recency window, the
  grounding gate, `draft: true`, the human merge gate, the branch-only rule, and the
  neuron ceiling all stay exactly as specified. This is about a run reaching
  `shortlist`, not about what `shortlist` or synthesis do once it does.
- **No new secret and no new external service.**
- **Whatever is done must be measured against the deployed Worker, not inferred from
  documentation.** The documented per-step CPU premise is what produced the wrong design
  once already (feature 002); a second unmeasured premise would repeat the same mistake
  this feature exists to correct.

## Non-goals

- **Not choosing the mechanism.** Stage 1 states the outcome — a run that completes —
  and leaves how to a Stage 2 spec built on measurement, not on this document.
- **Not curating or shrinking the allowlist.** 46 feeds is the requirement feature 001
  set, not the problem; making the symptom disappear by dropping feeds was already
  rejected as a non-goal once and stays rejected here.
- **Not the search API (#10) or Vectorize dedupe (#9).** Those widen discovery; this is
  about the discovery already specified actually finishing.
- **Not ranking, the grounding gate, or how a draft is written.** Unchanged by this
  feature; if the shortlist or the draft changes shape, that is a bug in this feature,
  not an intended effect of it.
- **Not restoring the cron (#64).** That is triggered by a completed run being observed,
  not by this feature merging. Merging this feature does not by itself resume the
  schedule.

## Open questions

- **What does a step boundary actually buy, and does a retry get one?** `spec.md`
  records that it buys something short of a fresh budget, and nothing measures what. The
  six-failure retry above makes the second half urgent: if a retry is a fresh invocation,
  then something other than the tenth feed is consuming the tenth step's budget; if it is
  not, retry has never been a recovery path for a CPU failure and the default backoff is
  five wasted minutes. Resolved by an instrumented run against the deployed Worker —
  nothing today makes invocation identity visible, and a value generated at module scope
  and emitted per step would. Not resolved by reading Workflows documentation, which is
  what produced the premise feature 002 had to correct.
- **Is the number of gather steps that complete before failure stable run to run, or does
  it vary?** One data point (nine) is not a distribution, and the two runs that exist
  differ in code as well as in reach. If it varies, whatever creates the boundary is not
  deterministic and a Stage 2 design cannot target a fixed step count.
- **What is the remaining per-feed cost once the concentrated saving already taken (the
  OpenAI archive bound) is set aside?** The repo has no CPU measurement of The Pragmatic
  Engineer at all — the feed that actually killed the run. That the bound cannot help it
  is inferred from its item count, not measured. Resolved by per-feed measurement during
  Stage 2 rather than by assuming its cost resembles OpenAI's.
- **What is the instance lifetime ceiling, and does whatever Stage 2 settles on fit
  inside it and the 1,024-step ceiling?** The step ceiling has a number and a source. The
  lifetime ceiling has neither anywhere in this repo, and a run that already takes five
  minutes to fail is close enough to a ceiling nobody can quote that the number should be
  found and cited before anything is sized against it.
- **How is a Stage 2 measurement retained as evidence once made?** Partly answered:
  Workflow *instance* state is not subject to the 3-day dashboard trace retention (#22),
  and `wrangler workflows instances describe` still returns the 2026-08-27 run's per-step
  attempts and outputs today. What it does not return is any CPU figure, and it resolves
  time only to the second. So a measurement that needs CPU or sub-second ordering has to
  be captured durably at the moment it is taken. The feed measurements are perishable for
  a separate reason — arXiv cs.SE was 41 raw items on 2026-08-27 and is not today — so a
  number in `spec.md` must carry the date it was taken.
