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
5: a full 46-feed run completing. The failing run still ended the
same way the first one did, `Worker exceeded CPU time limit` (Workers error `1102`), this
time at `gather:Simon Willison-1`, five minutes in.

Feature 002 also measured the lever it built — bounding the parse to stop reading once a
feed runs a fixed number of items past the recency window — and the measurement is not
kind to it. Run against all 46 feeds, nine repetitions each, the bound achieves a 0.798
aggregate CPU ratio, a real 20% saving. But the saving is not spread evenly: it is
concentrated almost entirely in one feed, OpenAI's archive, where the ratio is 0.174 and
209 of the total 254 ms saved comes from that one source now reading 71 of its 1,155
items instead of the whole thing. The feeds now in the failing window — Simon Willison,
The Pragmatic Engineer, DX — are ones where bounding the parse saves little or nothing,
because they were never the ones carrying the archive-sized cost. There is no second
OpenAI left to find. Whatever is consuming the budget in the failing window is a
different, more evenly distributed cost, and bounding the parse does not touch it.

There is also an arithmetic fact from the same run that does not fit the platform's
documented behaviour and has not been explained. Pre-002, three feed parses replayed in
a single invocation failed with the same `1102` error that two passed comfortably —
measured directly, recorded in `CLAUDE.md` and the `cf-free-tier` skill. Nothing about
the run's own structure has changed that measurement, yet the post-002 run completed
nine gather steps before failing. A 20% reduction in per-feed CPU cannot, on its own,
turn a ceiling of three into a ceiling of nine. Something is already causing the Worker
to start fresh invocations partway through this run, more often than the three-strikes
measurement predicts, and nobody has identified what it is or whether it can be relied
on. That gap between the measured ceiling and the observed reach is the crux of what is
unresolved.

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
- **1,024 steps per Workflow instance, and an instance lifetime ceiling exist and are
  real.** Whatever this feature settles on has to fit inside both, not just inside CPU.
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

- **What is actually creating the invocation boundaries this run is already getting?**
  The measured three-feed ceiling did not predict a nine-step reach, so some mechanism is
  already resetting CPU budget mid-run more often than that measurement implies.
  Resolved by measurement against the deployed Worker during Stage 2 — not by reading
  Workflows documentation, which is what produced the premise feature 002 had to correct.
- **Is the number of gather steps that complete before failure stable run to run, or does
  it vary?** One data point (nine) is not a distribution. If it varies, the boundary
  being relied on is not deterministic and a Stage 2 design has to account for that
  rather than target a fixed step count.
- **What is the remaining per-feed cost once the concentrated saving already taken (the
  OpenAI archive bound) is set aside?** The feeds now in the failing window gained little
  or nothing from bounding the parse, so their cost has a different, unmeasured shape.
  Resolved by per-feed measurement during Stage 2, feed by feed, rather than assumed to
  resemble OpenAI's.
- **Does whatever Stage 2 settles on fit inside the 1,024-step and instance-lifetime
  ceilings, alongside the wall-clock-per-invocation constraint that already governs
  cron?** Both ceilings are real; neither has been checked against a concrete design
  because no design exists yet.
- **How is a Stage 2 measurement retained as evidence once made?** Cloudflare's own
  Workers trace retention is 3 days on the free plan (#22), so a measurement taken today
  and cited in `spec.md` next week needs to be captured somewhere durable at the time it
  is made, not re-derived from a dashboard that will have already rolled it off.
