import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import { applyGatherWindow, parseFeed } from '../src/lib/feed';
import type { ParseBound } from '../src/lib/feed';
import type { ParsedItem, Source } from '../src/lib/types';

/**
 * A throwaway instrument for feature 003, and nothing else. It exists to
 * answer one question the deployed Worker cannot be asked read-only: where
 * do invocation boundaries actually fall during a Workflow run, does a retry
 * get a fresh one, and does a `step.sleep` force one?
 *
 * The measurement channel is the step output. `wrangler workflows instances
 * describe` returns every completed step's persisted output, so a step that
 * returns an object describing the invocation it ran in makes the boundary
 * map readable with no D1, no tracing, no binding and no dashboard.
 *
 * How the two ids differ, and why both are needed:
 *
 * - `r` is generated at the top of `run()`. Workflows re-executes `run()`
 *   from the top on every replay and does not re-run a completed step body,
 *   so two steps carrying the same `r` executed inside the same `run()`
 *   execution. A change in `r` is a replay boundary.
 * - `iso` is module scope. It survives across invocations that reuse the
 *   isolate and is re-initialised when a fresh isolate starts.
 *
 * `r` alone cannot tell a fresh invocation from a re-entry into `run()`
 * inside the isolate that was already serving; `iso` alone cannot see a
 * boundary at all, because isolate reuse is real. The pair is what makes the
 * map interpretable.
 *
 * `ms` runs from the top of the same `run()` execution `r` names, which is
 * what separates a `step.sleep` that suspends the instance from one that is
 * merely an in-process await: an await keeps `r` and carries the sleep's
 * whole duration into the next step's `ms`, a suspension does neither.
 *
 * This is deliberately NOT in `src/`. A merge to `main` deploys `src/` (see
 * `.github/workflows/deploy.yml`), and feature 003's `plan.md` is still the
 * unfilled template, so nothing here may reach the production Worker.
 */

// Random values are unavailable at global scope in Workers, so this
// initialises on first use rather than at module evaluation. It still
// identifies the isolate: the first step body to run in a fresh isolate
// fixes it, and every later body in that isolate reads the same value.
let ISO: string | null = null;
let SEQ = 0;

function isoId(): string {
  ISO ??= crypto.randomUUID().slice(0, 8);
  return ISO;
}

interface Marker {
  r: string;
  iso: string;
  seq: number;
  ms: number;
  // `noretry-cpu` / `cpu` only: the burn's sum, so the loop cannot be elided.
  sink?: number;
}

export interface ProbeParams {
  mode: (typeof MODES)[number];
  feeds: Source[];
  // `sleep` only. `everyN` counts gather steps between sleeps; `sleepFor` is a
  // Workflows duration string ('1 second', '60 seconds') or a millisecond
  // number. Both are optional so a `map` body stays a valid payload, and
  // `sleep` mode is exactly `map` plus the sleeps - same gather steps, same
  // marker shape, so its map is comparable with the runs already recorded.
  everyN?: number;
  sleepFor?: WorkflowSleepDuration;
}

export const MODES = ['map', 'retry', 'sleep', 'noretry', 'noretry-cpu', 'cpu'] as const;

/**
 * The value `src/lib/trace.ts` passes at production's one `step.do` call site,
 * written out here rather than imported: this instrument exists to measure
 * what the platform does with it, and importing it would make the probe track
 * a later edit of production silently. `rules/no-step-retry-config.yml` is
 * scoped to `src/**`, so this copy is outside it by design.
 */
const NO_RETRIES: WorkflowStepConfig = { retries: { limit: 0, delay: 0 } };

/**
 * Deliberate `1102`. 10 ms of CPU is a few million iterations of this loop,
 * so 5e8 is far enough past the limit that the kill is deterministic rather
 * than a race with whatever else the invocation is doing. The sum is returned
 * so nothing can eliminate the loop.
 */
function burnCpu(): number {
  let x = 0;
  for (let i = 0; i < 500_000_000; i++) x += Math.sqrt(i);
  return x;
}

// Copied from src/workflow.ts rather than exported from it: these are the
// values the failing production run used, and the probe must not start
// tracking a later edit of them silently.
const GATHER_WINDOW_DAYS = 30;
const GATHER_UNDATED_MAX_PER_FEED = 20;
const GATHER_STALE_RUN = 10;
const GATHER_RAW_ITEM_MAX = 2000;

/**
 * `gatherCandidates` (src/workflow.ts) with the D1 write removed and the
 * count returned instead. Everything upstream of that - the fetch, the
 * bound, `parseFeed`, `applyGatherWindow` - is imported from `src/lib/feed.ts`
 * unmodified, because a probe carrying its own parser would measure its own
 * parser.
 *
 * The missing D1 write is the one deliberate divergence and it is load
 * bearing: it removes an I/O await and a JSON.stringify from between
 * consecutive parses. So this measures where boundaries fall *without* the
 * per-gather D1 write, which is a different question from where they fall in
 * production. Read the difference, do not read past it.
 */
async function gatherCount(source: Source): Promise<number> {
  const now = new Date();
  const bound: ParseBound = {
    abort: new AbortController(),
    cutoffMs: now.getTime() - GATHER_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    staleRun: GATHER_STALE_RUN,
    rawMax: GATHER_RAW_ITEM_MAX,
  };
  let items: ParsedItem[] = [];
  try {
    const response = await fetch(source.feedUrl, { signal: bound.abort.signal });
    if (response.ok) items = await parseFeed(response, bound);
  } catch {
    items = [];
  }
  return applyGatherWindow(items, {
    windowDays: GATHER_WINDOW_DAYS,
    undatedMax: GATHER_UNDATED_MAX_PER_FEED,
    now,
  }).length;
}

export class ProbeWorkflow extends WorkflowEntrypoint<unknown, ProbeParams> {
  async run(event: WorkflowEvent<ProbeParams>, step: WorkflowStep): Promise<void> {
    const r = crypto.randomUUID().slice(0, 8);
    const t0 = Date.now();
    const mark = (): Marker => ({ r, iso: isoId(), seq: SEQ++, ms: Date.now() - t0 });

    const { mode, feeds, sleepFor = '1 second' } = event.payload;
    // A zero would make `(i + 1) % everyN` NaN, which is never 0, so `sleep`
    // mode would silently run as `map` and read back as "the sleep did
    // nothing" - the exact false negative this run is trying not to produce.
    const everyN = Math.max(1, Math.trunc(event.payload.everyN ?? 1));

    if (mode === 'retry') {
      // Two cheap steps first, so there is a marker to compare the retry
      // against, then a step that fails for the first ~25 s of instance
      // life. Workflows' default backoff is 10/20/40 s, so attempts land at
      // roughly 0 s, 10 s and 30 s: the first two throw, the third returns.
      //
      // Elapsed-since-instance-start is the trigger because a step body has
      // no attempt counter, and module-scope state cannot supply one - if
      // the retry gets a fresh isolate the flag resets and the step throws
      // forever, and if it does not, the step never succeeds. A clock read
      // is durable across both.
      await step.do('retry:before-1', async () => mark());
      await step.do('retry:before-2', async () => mark());
      await step.do('retry:fails-then-passes', async () => {
        const elapsed = Date.now() - event.timestamp.getTime();
        if (elapsed < 25_000) throw new Error(`probe: deliberate failure at ${elapsed} ms`);
        return { ...mark(), elapsed };
      });
      await step.do('retry:after', async () => mark());
      return;
    }

    if (mode === 'noretry' || mode === 'noretry-cpu' || mode === 'cpu') {
      // `cpu` is the control: identical burn, no retry policy, so the platform
      // default applies. Everything else passes NO_RETRIES. The prefix in each
      // step name carries which, because a capture is read back months later
      // without this file beside it.
      const off = mode !== 'cpu';
      const doStep = (name: string, body: () => Promise<Marker>): Promise<Marker> =>
        off ? step.do(name, NO_RETRIES, body) : step.do(name, body);

      // Two markers first. Under the "total attempts" reading of `limit`, zero
      // would mean these never run at all, and their completing is the only
      // thing that separates that reading from the one this design assumes.
      // Read this evidence off the `noretry` run only: on either CPU run the
      // markers may be packed into the invocation the burn kills, so a missing
      // marker row there says nothing about `limit`.
      const prefix = mode === 'cpu' ? 'cpu' : mode === 'noretry-cpu' ? 'nrcpu' : 'nr';
      await doStep(`${prefix}:before-1`, async () => mark());
      await doStep(`${prefix}:before-2`, async () => mark());

      if (mode === 'noretry') {
        // Unconditional, unlike `retry:fails-then-passes`: with retries off
        // there is no second attempt for a clock to behave differently in, and
        // a step that could pass would leave "it never failed" as a reading.
        await doStep('nr:always-throws', async () => {
          throw new Error('probe: deliberate failure, retries off');
        });
      } else {
        await doStep(`${prefix}:burns`, async () => ({ ...mark(), sink: burnCpu() }));
      }

      await doStep(`${prefix}:after`, async () => mark());
      return;
    }

    for (const [i, source] of feeds.entries()) {
      // Zero-padded so the step order is readable in the instance view, and
      // the index is in the name so a reordered allowlist is unambiguous.
      const name = `p${String(i).padStart(2, '0')}:${source.name}`;
      await step.do(name, async () => {
        const n = await gatherCount(source);
        return { ...mark(), n };
      });
      if (mode === 'sleep' && (i + 1) % everyN === 0) {
        // Same index and padding as the gather step it follows, so the pair
        // reads as one unit in the instance view and the name stays a stable
        // replay key.
        await step.sleep(`s${String(i).padStart(2, '0')}:sleep`, sleepFor);
      }
    }
  }
}

interface ProbeEnv {
  PROBE: Workflow;
}

export default {
  /**
   * POST any JSON body shaped like ProbeParams. GET returns the id of the
   * instance it started, which is the argument for
   * `wrangler workflows instances describe probe-workflow <id>`.
   */
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const params = (await request.json()) as ProbeParams;
    // A misspelled mode used to fall through to the gather loop, which reads
    // back as "the thing under test did nothing" - a false negative the README
    // had to warn about instead. Reject it here, where it is unambiguous.
    if (!(MODES as readonly string[]).includes(params.mode)) {
      return Response.json({ error: `mode must be one of: ${MODES.join(', ')}` }, { status: 400 });
    }
    const instance = await env.PROBE.create({ params });
    return Response.json({ id: instance.id });
  },
};
