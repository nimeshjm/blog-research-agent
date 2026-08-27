# Intent: Gather without accumulation

> Stage 1. Awaiting approval — [#62](https://github.com/nimeshjm/blog-research-agent/issues/62).

## Problem

The pipeline cannot complete a run. The first manually triggered run against the
deployed Worker died in `gather`, on the fifth feed of forty-six, with `Worker exceeded
CPU time limit`, and retried into the same wall four times before I terminated it.

The reason is not a bad feed. It is that `gather` was designed against a limit that does
not exist in the shape feature 001 assumed. Feature 001's `spec.md` and `CLAUDE.md` both
state **"10 ms CPU per step"** and derive the whole gather design from it — one feed per
step, forty-six steps, each supposedly with its own budget. Measured against Cloudflare
egress, every one of those feeds parses comfortably on its own, and **three of them in
succession do not**. The budget is not per step in the way the design relies on, so
"one feed per step" bought less than it looked like it bought, and the cost of feed *n*
is paid alongside the cost of feeds 1..n-1.

Two habits compound it. Most of the allowlist is a whole archive rather than a rolling
feed, so the run parses 1,154 OpenAI items and 352 arXiv items in order to keep the
handful published in the last thirty days — the waste is not incidental, it is the
majority of the work. And `run()` accumulates every feed's candidates into a single
in-memory array that it rebuilds from persisted step results on every replay, so the
per-run cost grows with the number of feeds already done and retry can never be cheaper
than the attempt that failed.

There is a second, quieter failure underneath. `select-topic` claims the queued topic by
moving it to `in_progress`, and nothing outside that instance's own replay ever moves it
back. When the run died, the topic I had just queued became unreachable: the next
scheduled run would have skipped it silently and proposed its own instead. I only noticed
because I was watching. **A failed run currently eats the work item that caused it.**

This is felt on every run, which is to say every two days, and the visible symptom is
the one that looks most benign — no pull request, same as a cycle with nothing worth
writing about.

## Outcome

A run completes. Specifically:

- Adding a feed to `config/feeds.json` does not move the run closer to a cliff. The
  forty-sixth feed costs what the first one costs.
- A run that dies leaves its topic available to the next run rather than stranded, and it
  is visible after the fact that a run died — not indistinguishable from a quiet cycle.
- The published constraint that the design is derived from matches the constraint the
  platform actually enforces, so the next person to add a step is not reasoning from a
  premise the pipeline has already disproved.

## Constraints

- **Cloudflare free tier, unchanged.** No paid plan. Whatever the real CPU boundary
  turns out to be, the fix lives inside it rather than buying past it.
- **The existing D1 budget stands**: 100 bound parameters per query, 50 queries per
  invocation. A fix that writes candidates to D1 has to respect these, and the
  measured numbers to respect them against are real — `gather:arXiv cs.AI` alone yields
  352 candidates.
- **No behavioural regression in what gets published.** The recency window, the
  grounding gate, `draft: true`, the human merge gate, the branch-only rule, and the
  neuron ceiling all stay exactly as feature 001 specified them. This changes how
  candidates get from a feed to `shortlist`, not which drafts are worth opening.
- **Idempotent steps.** Workflow steps are retried; anything this adds must be safe to
  run twice.
- **No new secret and no new external service.**

## Non-goals

- Not a change to ranking, to the grounding gate, or to how a draft is written. If the
  set of candidates reaching `shortlist` changes, that is a bug in this feature.
- Not the search API (#10) and not Vectorize dedupe (#9). Those widen discovery; this
  makes the discovery already specified actually run.
- Not a general observability change. The gather spans stay as they are.
- Not curating the allowlist. Dropping feeds would make the symptom go away without
  fixing the shape, and "46 feeds is too many" is exactly the conclusion this feature
  exists to avoid having to accept.
- Not a retry or alerting framework. Recording that a run died and freeing its topic is
  in scope; notifying anyone is not.

## Open questions

- **What is the real CPU boundary?** Measured: three feeds in one invocation fail where
  two succeed, and production got six steps in before failing. That is enough to know the
  per-step premise is wrong, not enough to state the correct rule. The spec has to
  establish whether a step boundary resets the budget at all, and if not, what forces a
  fresh invocation. Resolved by measurement during Stage 2, not by reading the docs — the
  documented free-tier number is what produced the wrong premise in the first place.
- **Is bounding the parse per feed sufficient on its own?** Most of the wasted work is
  dated items far outside the thirty-day window, in feeds that list newest first
  (feature 001's `spec.md` asserts this of every allowlisted feed). Stopping early may
  cut the cost enough that nothing else is needed — but it depends on that
  newest-first assumption holding for all 46, which is asserted and not tested.
- **How long may a topic sit in `in_progress` before it is reclaimable?** Needs to be
  comfortably longer than the longest legitimate run and shorter than a cron gap. Both
  numbers exist; neither is currently recorded.
- **Does a hard step failure still owe a `runs` row?** Feature 001 requirement 9 says
  every run writes exactly one, and the dead instance wrote none — so the requirement is
  already violated in a way nobody had seen. Whether this feature fixes that or records
  it is a Stage 2 decision.
