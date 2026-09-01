import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { writeRunCandidates } from './lib/d1';
import { applyGatherWindow } from './lib/feed';
import type { ParseBound } from './lib/feed';
import { fetchFeedItems } from './lib/feed-fetch';
import type { Env, GatherParams, Source } from './lib/types';
import { ATTR_GATHER_CHILD_INDEX, ATTR_SOURCES_GATHERED, tracerFor } from './lib/trace';

/**
 * feature 003's child instance (spec.md, "Gather in child instances"): one
 * per chunk of `GATHER_FEEDS_PER_CHILD` feeds (`createGatherChildren`,
 * src/workflow.ts), so gather's fetches and D1 writes land in a fresh
 * invocation lineage rather than the parent's - a child is a *separate*
 * Workflow instance with its own `run()` and its own 50-subrequest budget,
 * which is what a step boundary inside one instance is not (measured #75:
 * 46 gather steps exhausted the parent's own invocation before a single
 * article fetch).
 *
 * `event.payload.runId` is the *parent's* instance id, not this child's own
 * (`GatherParams`'s doc comment), so every feed here writes into the
 * parent's `run_candidates` rows and `shortlist` needs no change at all.
 *
 * One `gather:<feed name>` step per feed, each calling `gatherCandidates`
 * below - moved here unchanged from `src/workflow.ts` (plan.md, "Reuse"):
 * the same one-fetch, one-bounded-parse, one-D1-write shape feature 002
 * built. `run()`'s return value is the summed count, which the parent reads
 * back through `InstanceStatus.output` (`pollGatherChildren`,
 * src/workflow.ts) - an integer, never an array of candidates, so
 * requirement 5 ("the parent's own CPU cost does not grow with the number
 * of children") holds by construction one level up too: nothing this class
 * returns grows with feed count.
 *
 * The body is `runGather`, a plain function, rather than inline in `run()` -
 * same shape as every step body in `src/workflow.ts`. `WorkflowEntrypoint`'s
 * real constructor rejects being `new`'d directly outside the platform's own
 * Workflows runtime (a native binding-type check; confirmed against
 * `vitest-pool-workers`, including its own `createExecutionContext()`), so
 * `run()` itself is untestable in isolation - `runGather` is what makes the
 * one thing worth testing here (that `event.payload.runId`, the *parent's*
 * id, is what reaches `gatherCandidates`, not this child's own
 * `event.instanceId`) testable without constructing the class at all.
 */
export async function runGather(env: Env, step: WorkflowStep, event: WorkflowEvent<GatherParams>): Promise<number> {
  const traceStep = tracerFor(step, event);

  let gathered = 0;
  for (const source of event.payload.sources) {
    // `agent.step` on this span is the `gather` prefix, not the full step
    // name - `tracedStep` strips after the first `:` so a per-feed span
    // never needs a source name judged sensitive enough to redact by hand.
    gathered += await traceStep(
      `gather:${source.name}`,
      { [ATTR_GATHER_CHILD_INDEX]: event.payload.index },
      async (span) => {
        const count = await gatherCandidates(env, event.payload.runId, source);
        span.setAttribute(ATTR_SOURCES_GATHERED, count);
        return count;
      },
    );
  }
  return gathered;
}

export class GatherWorkflow extends WorkflowEntrypoint<Env, GatherParams> {
  run(event: WorkflowEvent<GatherParams>, step: WorkflowStep): Promise<number> {
    return runGather(this.env, step, event);
  }
}

/**
 * Discovery bounds. They exist because D1 allows 100 bound parameters per query
 * and 50 queries per invocation, and `shortlist` (src/workflow.ts) checks every
 * candidate against `seen_urls` in one batched pass. See spec.md, "The recency
 * window in `gather`".
 *
 * The window is what the agent is for - it reports on recent work, not on
 * archives - and the D1 arithmetic wants the same rule for its own reasons.
 *
 * There is deliberately no per-feed cap on *dated* items. arXiv publishes a
 * whole day at once - cs.AI carries 352 items, cs.SE 62, all inside the window -
 * and truncating that would starve the grounding gate of the papers it exists to
 * find. The date window bounds the common case; SHORTLIST_MAX_CANDIDATES
 * (src/workflow.ts) bounds a feed that dumps its archive with fresh timestamps.
 */
export const GATHER_WINDOW_DAYS = 30;
/** Backstop for items with no parseable date only. Zero such items today. */
export const GATHER_UNDATED_MAX_PER_FEED = 20;
/**
 * How many consecutive dated, out-of-window items `parseFeed` reads before it
 * cancels the response body rather than draining the rest of the archive
 * (spec.md req. 1, feature 002). The margin it rests on is the differential
 * over all 46 live feeds (acceptance criterion 2), not a derivation - it only
 * has to absorb the local disorder of a feed that is mostly, not perfectly,
 * newest-first.
 */
export const GATHER_STALE_RUN = 10;
/**
 * Requirement 3's backstop only (feature 002): a wholly undated feed can
 * never trip `GATHER_STALE_RUN`, so without a raw-item ceiling it would be
 * unbounded. The margin is stated both ways it could be wrong: the largest
 * raw item count in the allowlist is OpenAI's 1,155, and the largest
 * legitimate *kept* count is arXiv cs.AI's 352-item announcement day
 * (requirement 6 forbids truncating that). 2,000 sits far enough above both
 * that it can never truncate a real day - it is a safety net, not a tuning
 * knob, and deliberately not sized anywhere near 352.
 */
export const GATHER_RAW_ITEM_MAX = 2000;

/**
 * One fetch, streamed parse (src/lib/feed.ts), then one D1 write
 * (`writeRunCandidates`) - two Workers subrequests per feed, which is what
 * `GATHER_FEEDS_PER_CHILD`'s own comment (src/workflow.ts) sizes a child
 * against. The 30-day window and the undated-item cap are applied here, per
 * feed, never in `shortlist` - see GATHER_WINDOW_DAYS / GATHER_UNDATED_MAX_PER_FEED
 * above and spec.md, "The recency window in `gather`". A feed that cannot be
 * fetched or fails to parse contributes zero candidates rather than failing
 * the step: `fetchFeedItems` already swallows that failure and returns `[]`,
 * so one dead feed must not fail the run (spec.md risk table), and a feed
 * that consistently returns nothing is a review finding against the
 * allowlist, visible via `agent.sources.gathered` on the step's own span. A
 * D1 write failure, though, does still fail the step, and should - that is
 * not a dead feed, it is a dead database, and (since feature 003) a failed
 * child step fails the whole run visibly rather than silently contributing
 * zero (spec.md requirement 4).
 *
 * `now` is computed once and shared between the bound's `cutoffMs` and
 * `applyGatherWindow`'s own cutoff, so the parse-time stop and the
 * post-parse filter agree on exactly the same window boundary rather than
 * drifting apart across the (sub-millisecond) gap between two separate
 * `Date.now()` reads.
 */
export async function gatherCandidates(env: Env, runId: string, source: Source): Promise<number> {
  const now = new Date();
  const bound: ParseBound = {
    abort: new AbortController(),
    cutoffMs: now.getTime() - GATHER_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    staleRun: GATHER_STALE_RUN,
    rawMax: GATHER_RAW_ITEM_MAX,
  };
  const items = await fetchFeedItems(source.feedUrl, bound);
  const windowed = applyGatherWindow(items, {
    windowDays: GATHER_WINDOW_DAYS,
    undatedMax: GATHER_UNDATED_MAX_PER_FEED,
    now,
  });
  return writeRunCandidates(env.DB, runId, source.name, windowed);
}
