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
  // `noretry-cpu` / `cpu` only: the burn's sum, so the loop cannot be elided,
  // and the iteration count it was asked for.
  sink?: number;
  iters?: number;
}

export interface ProbeParams {
  mode: (typeof MODES)[number];
  // `map` and `sleep` only, and the fetch handler rejects those two modes
  // without it. Optional because every other mode ignores it, and a payload
  // that had to carry a dummy array to run `childerr` would be one more thing
  // to get wrong in a curl.
  feeds?: Source[];
  // `sleep` only. `everyN` counts gather steps between sleeps; `sleepFor` is a
  // Workflows duration string ('1 second', '60 seconds') or a millisecond
  // number. Both are optional so a `map` body stays a valid payload, and
  // `sleep` mode is exactly `map` plus the sleeps - same gather steps, same
  // marker shape, so its map is comparable with the runs already recorded.
  everyN?: number;
  sleepFor?: WorkflowSleepDuration;
  // `noretry-cpu` / `cpu` only: iterations of the burn loop. Ramped across runs
  // to find where the ceiling actually is, since 5e8 turned out to be under it.
  iters?: number;
  // `childrestartof` only, and required by the fetch handler for it: the id of
  // an existing errored child to restart. Naming an id whose pre-restart
  // `describe` is already captured is the only way to read whether
  // `restart({ from })` preserved the earlier steps - a restarted instance's
  // own step rows are the thing in question, so they cannot also be the
  // baseline.
  childId?: string;
  // The child modes' poll cadence. Defaults are fine for watching a child
  // error; `childrestartof` overrides them upward, because 8 rounds of 5 s was
  // measured to be far too short to see a restarted instance move.
  rounds?: number;
  interval?: WorkflowSleepDuration;
  // Whether to pass `{ from }` to `restart()`. `childrestartof` only; the two
  // fixed modes hard-code it either way.
  from?: boolean;
}

export const MODES = [
  'map',
  'retry',
  'sleep',
  'noretry',
  'noretry-cpu',
  'cpu',
  'childerr',
  'childrestart',
  'childrestartfrom',
  'childrestartof',
  'childcpu',
] as const;

/** The modes that read `childId`, and cannot run without one. */
const CHILD_ID_MODES: readonly string[] = ['childrestartof'];

/** The modes that read `feeds`. Everything else ignores it. */
const FEED_MODES: readonly string[] = ['map', 'sleep'];

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
function burnCpu(iters: number): number {
  let x = 0;
  for (let i = 0; i < iters; i++) x += Math.sqrt(i);
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

/**
 * The child modes, added 2026-09-02 for issue #92. Two facts have to be read
 * off the deployed platform before a transient-failure recognition rule can be
 * written, and neither is readable from `wrangler describe` alone:
 *
 * 1. **Which field of `InstanceStatus.error` carries an error class.** The only
 *    evidence in `probe/captures/` is a *rendering* — `Error:
 *    WorkflowInternalError: Attempt failed due to internal workflows error` —
 *    and a rule cannot be written against a rendering. The platform cannot be
 *    made to emit a real `WorkflowInternalError`, so instead the child throws
 *    an error whose `name`, `message` and constructor name are three mutually
 *    distinguishable tokens. Reading all three off one capture fixes the
 *    renderer's formula, and the formula inverted on the production capture
 *    says which field a rule must read.
 * 2. **Whether `restart()` is valid on an instance already in `errored`.** The
 *    changelog records `restart()` only reaching local development; types are
 *    not the runtime, so the method may not even be there.
 *
 * The tokens are deliberately noise: nothing else in this repo or on the
 * platform can produce `ProbeName-ZZZ`, so grep on a capture is unambiguous.
 */
const CHILD_ERROR_NAME = 'ProbeName-ZZZ';
const CHILD_ERROR_MESSAGE = 'ProbeMessage-QQQ';

/**
 * `name` is an own field set at construction rather than assigned after it, so
 * it is in place before anything — including a `.stack` read, whose header the
 * runtime formats from name and message — can observe the error. The class
 * name is a third distinct token: if a rendering shows `ProbeCtorWWW` then the
 * platform serialises `constructor.name`, not `.name`.
 */
class ProbeCtorWWW extends Error {
  override name = CHILD_ERROR_NAME;
}

const CHILD_MARKER_1 = 'child:marker-1';
const CHILD_MARKER_2 = 'child:marker-2';
const CHILD_THROW_STEP = 'child:throws';
const CHILD_BURN_STEP = 'child:burns';

/**
 * `iters` swaps the throw for a `1102`. 8.3's fail-closed allowlist has to
 * exclude a CPU kill, and the exclusion was otherwise argued from a
 * *rendering* of `Worker exceeded CPU time limit.` rather than from the object
 * a parent actually reads - the same weakness the whole sitting exists to fix
 * for `WorkflowInternalError`. A child killed by the platform prints the real
 * thing.
 */
interface ProbeChildParams {
  iters?: number;
}

/**
 * The child. Two cheap markers, then a step that throws — the shape of the
 * production failure this exists to explain, where child `s0` had completed
 * three real `summarize:<url>` steps before the fourth died.
 *
 * The markers are the "cached results of every earlier step" the docs promise
 * `restart({ from })` reuses, and were meant to be read by comparing their
 * `r` and attempt-row count across a restart. Measured 2026-09-02: that
 * comparison is not available — a restarted instance's `describe` returns an
 * empty step list — so what they now serve is the *baseline* half of it, in a
 * capture taken before the restart. See `FINDINGS.md` 8.4.
 */
export class ProbeChildWorkflow extends WorkflowEntrypoint<ProbeEnv, ProbeChildParams> {
  async run(event: WorkflowEvent<ProbeChildParams>, step: WorkflowStep): Promise<void> {
    const r = crypto.randomUUID().slice(0, 8);
    const t0 = Date.now();
    const mark = (): Marker => ({ r, iso: isoId(), seq: SEQ++, ms: Date.now() - t0 });

    await step.do(CHILD_MARKER_1, NO_RETRIES, async () => mark());
    await step.do(CHILD_MARKER_2, NO_RETRIES, async () => mark());
    // NO_RETRIES on both, so the child errors on the first attempt - which is
    // production's shape (feature 003 requirement 1) and keeps the attempt
    // table readable.
    const iters = event.payload.iters;
    if (iters) {
      await step.do(CHILD_BURN_STEP, NO_RETRIES, async () => ({
        ...mark(),
        iters,
        sink: burnCpu(iters),
      }));
    } else {
      await step.do(CHILD_THROW_STEP, NO_RETRIES, async () => {
        throw new ProbeCtorWWW(CHILD_ERROR_MESSAGE);
      });
    }
  }
}

type StatusOf = Awaited<ReturnType<WorkflowInstance['status']>>;

/**
 * `InstanceStatus` reduced to something a step output can carry. `keys` and
 * `json` are the primary data for issue #92's third open question: the object
 * itself, not `wrangler describe`'s rendering of it. `errorName` and
 * `errorMessage` are pulled out separately so a capture can be read without
 * un-escaping the JSON.
 */
interface StatusSnapshot {
  status: string;
  keys: string[];
  json: string;
  errorKeys: string[];
  errorName: string | null;
  errorMessage: string | null;
}

function snapshot(s: StatusOf): StatusSnapshot {
  return {
    status: s.status,
    keys: Object.keys(s),
    json: JSON.stringify(s),
    errorKeys: s.error ? Object.keys(s.error) : [],
    errorName: s.error?.name ?? null,
    errorMessage: s.error?.message ?? null,
  };
}

const TERMINAL: readonly string[] = ['errored', 'terminated', 'complete'];

/** Everything recoverable about a caught throw, since the point of the steps
 * below is the value they return rather than the failure they would otherwise
 * propagate. `ctor` separates "the method is missing" (a `TypeError`) from
 * "the method rejected the call". */
interface Thrown {
  name: string;
  message: string;
  ctor: string;
  str: string;
  keys: string[];
}

function thrownOf(e: unknown): Thrown {
  const isObject = typeof e === 'object' && e !== null;
  const err = e as Partial<Error> | null;
  return {
    name: err?.name ?? '(none)',
    message: err?.message ?? '(none)',
    ctor: isObject ? (e as object).constructor.name : typeof e,
    str: String(e),
    keys: isObject ? Object.keys(e as object) : [],
  };
}

interface RestartRecord extends Marker {
  // Recorded *before* the call: the changelog only puts `restart()` in local
  // development, so "the method is not on the deployed object" is a live
  // possibility and has to be distinguishable from "it threw".
  kind: string;
  proto: string[];
  options: WorkflowInstanceRestartOptions | null;
  outcome: 'resolved' | 'threw';
  thrown: Thrown | null;
}

// The child errors within a second of starting, so this is generous. Rounds
// are cheap here: the probe has no 50-subrequest ledger to protect.
const CHILD_POLL_ROUNDS = 8;
const CHILD_POLL_INTERVAL = '5 seconds';

export class ProbeWorkflow extends WorkflowEntrypoint<ProbeEnv, ProbeParams> {
  async run(event: WorkflowEvent<ProbeParams>, step: WorkflowStep): Promise<void> {
    const r = crypto.randomUUID().slice(0, 8);
    const t0 = Date.now();
    const mark = (): Marker => ({ r, iso: isoId(), seq: SEQ++, ms: Date.now() - t0 });

    const { mode, feeds = [], sleepFor = '1 second' } = event.payload;
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
        const iters = event.payload.iters ?? 500_000_000;
        await doStep(`${prefix}:burns`, async () => ({ ...mark(), iters, sink: burnCpu(iters) }));
      }

      await doStep(`${prefix}:after`, async () => mark());
      return;
    }

    if (
      mode === 'childerr' ||
      mode === 'childrestart' ||
      mode === 'childrestartfrom' ||
      mode === 'childrestartof' ||
      mode === 'childcpu'
    ) {
      // A distinct suffix per mode, so a capture names which experiment it is
      // without this file beside it, and so no two modes collide on an
      // instance id.
      const label =
        mode === 'childerr'
          ? 'ce'
          : mode === 'childrestart'
            ? 'cr'
            : mode === 'childrestartfrom'
              ? 'crf'
              : mode === 'childcpu'
                ? 'cc'
                : 'cro';
      // Every mode but `childrestartof` creates its own child, under an id
      // derived from the parent's instance id: `run()` re-executes on replay,
      // and a replay that created the child under a fresh id would measure a
      // second child instead of the one already polled. `childrestartof`
      // instead adopts a child an earlier run created, so that child's
      // pre-restart step rows are already captured and can serve as the
      // baseline a restarted instance can no longer supply.
      const childId = event.payload.childId ?? `${event.instanceId}-${label}`;
      const rounds = Math.max(1, Math.trunc(event.payload.rounds ?? CHILD_POLL_ROUNDS));
      const interval = event.payload.interval ?? CHILD_POLL_INTERVAL;

      // 5e9 is the lowest value section 7.2 measured to kill reliably; only
      // `childcpu` passes one, and a child with no `iters` throws instead.
      const childParams: ProbeChildParams =
        mode === 'childcpu' ? { iters: event.payload.iters ?? 5_000_000_000 } : {};

      if (mode !== 'childrestartof') {
        await step.do(`${label}:create`, NO_RETRIES, async () => {
          try {
            const created = await this.env.PROBE_CHILD.create({ id: childId, params: childParams });
            return { ...mark(), childId: created.id, created: true, thrown: null as Thrown | null };
          } catch (e) {
            // An already-exists rejection is the expected shape on replay, and
            // it is not a failure of the experiment - the instance is there.
            return { ...mark(), childId, created: false, thrown: thrownOf(e) };
          }
        });
      }

      const poll = async (phase: string): Promise<StatusSnapshot> => {
        let last: StatusSnapshot | null = null;
        for (let round = 0; round < rounds; round++) {
          last = await step.do(`${label}:${phase}-poll-${round}`, NO_RETRIES, async () => {
            const instance = await this.env.PROBE_CHILD.get(childId);
            return snapshot(await instance.status());
          });
          if (TERMINAL.includes(last.status)) return last;
          await step.sleep(`${label}:${phase}-wait-${round}`, interval);
        }
        if (!last) throw new Error('probe: rounds is zero');
        return last;
      };

      const errored = await poll('pre');
      // The answer step. The poll rounds already carry this, but which round
      // was the last one varies per run, so one row named `:answer` is what a
      // reader six months from now goes to.
      await step.do(`${label}:answer`, NO_RETRIES, async () => ({ ...mark(), ...errored }));
      if (mode === 'childerr' || mode === 'childcpu') return;

      // `type` is `'do' | 'sleep' | 'waitForEvent'` in the declaration of
      // `WorkflowInstanceRestartOptions` - not `'step'`. `count` is the
      // 1-indexed occurrence of the name.
      const withFrom =
        mode === 'childrestartof' ? (event.payload.from ?? true) : mode === 'childrestartfrom';
      const options: WorkflowInstanceRestartOptions | null = withFrom
        ? { from: { name: CHILD_THROW_STEP, count: 1, type: 'do' } }
        : null;

      await step.do(`${label}:restart`, NO_RETRIES, async (): Promise<RestartRecord> => {
        const instance = await this.env.PROBE_CHILD.get(childId);
        const kind = typeof (instance as { restart?: unknown }).restart;
        const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(instance) as object);
        try {
          await (options ? instance.restart(options) : instance.restart());
          return { ...mark(), kind, proto, options, outcome: 'resolved', thrown: null };
        } catch (e) {
          return { ...mark(), kind, proto, options, outcome: 'threw', thrown: thrownOf(e) };
        }
      });

      // Immediately, before anything can settle: this is what separates
      // "restart accepted, instance requeued" from "restart was a no-op and
      // the instance is still sitting in `errored`".
      await step.do(`${label}:status-immediate`, NO_RETRIES, async () => {
        const instance = await this.env.PROBE_CHILD.get(childId);
        return { ...mark(), ...snapshot(await instance.status()) };
      });

      await step.sleep(`${label}:settle`, '15 seconds');
      const after = await poll('post');
      await step.do(`${label}:answer-post`, NO_RETRIES, async () => ({
        ...mark(),
        ...after,
        // Carried side by side so one row settles whether the restart changed
        // anything at all.
        wasErrorName: errored.errorName,
        wasErrorMessage: errored.errorMessage,
      }));
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
  PROBE_CHILD: Workflow;
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
    // `feeds` became optional when the child modes arrived, which would have
    // reopened the same false negative from the other side: a `map` payload
    // with a misspelled `feeds` key would run zero gather steps and read back
    // as "the thing under test did nothing". Reject it here instead.
    if (FEED_MODES.includes(params.mode) && !params.feeds?.length) {
      const error = `mode ${params.mode} needs a non-empty feeds array`;
      return Response.json({ error }, { status: 400 });
    }
    // Without this, `childrestartof` would restart a child of its own parent's
    // instance id - which does not exist, so the create-less path would poll a
    // missing instance and the run would read as a fact about restart().
    if (CHILD_ID_MODES.includes(params.mode) && !params.childId) {
      return Response.json({ error: `mode ${params.mode} needs childId` }, { status: 400 });
    }
    const instance = await env.PROBE.create({ params });
    return Response.json({ id: instance.id });
  },
};
