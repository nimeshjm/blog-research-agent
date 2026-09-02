import type { ChildPollState } from './types';

/**
 * The create/poll shape behind every child Workflow this repo runs
 * (`GatherWorkflow`, `SummarizeWorkflow`) - feature 003's "Gather in child
 * instances" design (spec.md), generalized here rather than copied a second
 * time when article summarization became the second child (extended
 * 2026-08-31, #75). Deterministic ids verified against reality rather than
 * assumed, and "a failed child fails the run visibly" (spec.md requirement
 * 4) are the parts every caller shares; what a child actually returns (a
 * count, or summaries-plus-neuron-spend) stays with the caller, via
 * `createChildBatch`'s params and `pollChildBatch`'s `validate`/`combine`.
 */

/**
 * Calls `.status()`, not just `.get()`: `index.d.ts` documents `get` as
 * returning "a handle to an *existing* instance" but does not say whether
 * that existence check is eager (in `get`) or lazy (deferred to the first
 * real call on the handle) - measured under vitest-pool-workers, a
 * nonexistent id throws from `.status()`, not from `.get()` itself. Calling
 * only `get()` would make this always return `true` under a lazy
 * implementation, which would turn "verified against reality" into
 * "assumed" exactly where `createChildBatch`'s doc comment says it isn't - a
 * genuinely different `createBatch` failure would then be swallowed instead
 * of rethrown, and the run would fail later, at the poll step, with an
 * opaque `instance.not_found` instead of the real cause.
 */
export async function childExists<TParams>(binding: Workflow<TParams>, id: string): Promise<boolean> {
  try {
    const instance = await binding.get(id);
    await instance.status();
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates one child per `options[i]`, idempotent on replay: `createBatch`
 * throws when *any* supplied id already exists (`index.d.ts`), which is
 * verified against reality via `childExists` rather than assumed - a
 * genuinely different failure (bad params, a quota) still throws. Ids must
 * be deterministic at the call site (e.g. `${parentInstanceId}-g${index}`)
 * so a replay of `run()` (fact 2, spec.md) recreates nothing.
 */
export async function createChildBatch<TParams>(
  binding: Workflow<TParams>,
  options: { id: string; params: TParams }[],
): Promise<string[]> {
  try {
    await binding.createBatch(options);
  } catch (err) {
    const alreadyExist = await Promise.all(options.map((o) => childExists(binding, o.id)));
    if (!alreadyExist.every(Boolean)) throw err;
  }
  return options.map((o) => o.id);
}

export type ChildPollOutcome<T, TOutput> = { done: true; result: T } | { done: false; state: ChildPollState<TOutput> };

/**
 * The error classes a child failure may be *replaced* for rather than failing
 * the run (spec.md requirement 4's narrowing, 2026-09-01 (#92)). Exactly one
 * token, and an allowlist rather than a pattern, because fail-closed means a
 * class earns its place by being argued in:
 *
 * - `WorkflowInternalError` is the platform's own transient surface. Run
 *   `54ce776b` produced it with **one** attempt row and no application error
 *   under it, on a run where nothing else was near a ceiling.
 * - `Worker exceeded CPU time limit.` and `Too many subrequests by single
 *   Worker invocation.` are deliberately absent. Replacing a child that
 *   exhausted a resource spends the same resource again - requirement 1's own
 *   measured argument (spec.md fact 4), applied one level up. Neither can
 *   reach this list by accident either, because neither message contains a
 *   `': '` at all and the split below therefore yields the whole string. The
 *   CPU one is **measured** through the binding - a real `1102` reads back
 *   `{"message":"Worker exceeded CPU time limit.","name":"Error"}`; the
 *   subrequest one is **inverted** from the renderer formula, and its only
 *   colon is `https:`, a colon followed by `/` rather than a space
 *   (`probe/FINDINGS.md` 8.1/8.3).
 * - `instance.not_found` and an `unknown` status stay off it. #92's third open
 *   question, and the probe produced neither, so there is nothing to argue in
 *   yet.
 */
const TRANSIENT_CHILD_ERROR_CLASSES: readonly string[] = ['WorkflowInternalError'];

/**
 * Whether an errored child's `InstanceStatus.error` names a class worth
 * replacing the child for. Its own exported function, rather than a condition
 * inside `pollChildBatch`, because *which field* carries the class was #92's
 * open question and this is the one line that answers it.
 *
 * Exact match on the token before the first `': '`, never a substring test -
 * an application error whose message merely mentions the class must not match.
 * No error object at all is not a recognised class, so it fails closed. The
 * residual surface, named rather than left to be rediscovered: a child's own
 * thrown error could impersonate the class by being *named*
 * `WorkflowInternalError`, because the platform folds a thrown `name` into the
 * front of `message` (`probe/FINDINGS.md` 8.1). Nothing in `src/` throws such
 * a name.
 */
export function isTransientChildFailure(error: InstanceStatus['error']): boolean {
  if (error === undefined) return false;
  // Reads `message`, and **that half is measured** - 2026-09-02, off the
  // binding rather than off a rendering (#92, `probe/FINDINGS.md` 8.1):
  // `status.error.name` is the literal `'Error'` both for a real `1102` and
  // for a deliberate throw whose own `name` was set to `ProbeName-ZZZ`, which
  // came back as `{"message":"ProbeName-ZZZ: ProbeMessage-QQQ","name":"Error"}`
  // - the thrown `name` is folded into the front of `message` and `name`
  // carries no class token at all. `Object.keys(status.error)` is
  // `["message","name"]`, so there is no third field this could have been.
  //
  // **What stays inferred is the one object this rule exists for.** Nothing
  // printed `54ce776b-…-s0`'s `InstanceStatus.error`, and that instance cannot
  // be made to fail that way again. Its pair is the *measured* renderer
  // formula `${error.name}: ${error.message}` (FINDINGS 8.2) inverted onto the
  // capture's `Error: WorkflowInternalError: Attempt failed due to internal
  // workflows error`, giving `name: 'Error'` with the class leading `message`.
  // Measured formula, inferred instance - stated the way commit `d0f7de0`
  // states it in the spec.
  //
  // `': '` rather than `':'` is that formula's own separator, and it is what
  // keeps the split closed on the two exclusions above.
  const [classToken] = error.message.split(': ');
  return TRANSIENT_CHILD_ERROR_CLASSES.includes(classToken ?? '');
}

/**
 * The capability to replace a transiently-failed child, supplied by a poll
 * call site rather than available to all of them (spec.md requirement 4's
 * narrowing). Only the summarize loop passes one, and the asymmetry is
 * structural rather than a comment on a shared path: a summarize child writes
 * nothing outside its return value; a gather child's writes are idempotent
 * under `run_candidates`' primary key but not free; and a publish child that
 * errored *after* opening the pull request would hand its replacement
 * GitHub's 422 `A pull request already exists`.
 */
export interface ChildReplacement {
  /**
   * Subrequests the whole mechanism may spend in this loop - the `create`
   * plus the extra poll rounds it grants. This, not "once per child", is what
   * bounds the cost: nine children could each be replaced once.
   */
  allowance: number;
  /** Extra poll rounds one replacement adds to the round cap, so the replacement has rounds to converge in. */
  extraRounds: number;
  /** Creates the replacement under an id deterministically derived from `childId`, and returns that id. */
  create: (childId: string) => Promise<string>;
}

/**
 * Every clause requirement 4's narrowing is stated in, in one place, with the
 * unconditional throw as the default. Its own function so the fail-closed
 * decision is readable and testable rather than buried in a conjunction.
 */
function isReplaceable(
  replace: ChildReplacement,
  failure: { id: string; status: InstanceStatus },
  round: { failures: number; stillRunning: number },
  childIds: string[],
  replacements: Record<string, string>,
): boolean {
  // A `terminated` child is never transient however its error reads: a
  // terminate is deliberate - something asked this instance to stop.
  if (failure.status.status !== 'errored') return false;
  if (!isTransientChildFailure(failure.status.error)) return false;
  // Never twice for the same child. A replacement's own id is not in
  // `childIds`, so this rejects replacing a replacement as well.
  if (!childIds.includes(failure.id) || replacements[failure.id] !== undefined) return false;
  // The allowance, spent as one create plus `extraRounds` polls per
  // replacement: at an allowance of 3 and 2 extra rounds, `floor(3 / 3)` is
  // exactly one replacement per run.
  if (Object.keys(replacements).length >= Math.floor(replace.allowance / (1 + replace.extraRounds))) return false;
  // The assumption that allowance rests on. An extra round costs one
  // subrequest only while the replacement is the only child left to poll;
  // with a sibling still running they cost `childIds.length` each, which
  // needs an allowance of 7 rather than 3 and puts the parent at 53 of 50.
  // So this fails the run, exactly as it did before the narrowing. A sibling
  // that completed *in this same round* is not still running and does not
  // block a replacement - its output was collected first.
  return round.failures === 1 && round.stillRunning === 0;
}

/** The state a poll loop starts from: every child pending, nothing carried yet. */
export function initialChildPollState<TOutput>(childIds: string[]): ChildPollState<TOutput> {
  return { pending: [...childIds], outputs: {} };
}

/**
 * One poll round shared by every `await-<x>-children` step. A child that is
 * `errored` or `terminated` fails this immediately (spec.md requirement 4 -
 * the deliberate opposite of a single dead *item* inside a child, which
 * still contributes zero without failing anything). While any child is not
 * yet `complete`, this returns `{ done: false }` with the state the next
 * round resumes from, up to a subrequest-budget-derived round cap - past it,
 * this throws rather than lets the platform's own opaque subrequest error be
 * the first sign anything is stuck. Once every child is `complete`, `combine`
 * turns the per-child results into whatever the caller's poll result type is.
 *
 * **Only `state.pending` is polled.** A `status()` call is a subrequest
 * charged to the parent's invocation, and re-reading a child that finished
 * two rounds ago buys nothing - run `0357f119` (2026-09-01) spent 19 of the
 * parent's 50 on polling and then died inside `open-pull-request`. Since
 * `combine` needs every child's result, a child that is no longer polled has
 * to have its result carried: see `ChildPollState` (src/lib/types.ts) for why
 * that travels through this step's own output rather than a closure, and why
 * it stays bounded.
 *
 * `validate` rather than a cast: `InstanceStatus.output` is typed `unknown`
 * (plan.md's question 3 sets the rule for exactly this value). It runs at the
 * round a child completes, which is also what makes the carried state typed
 * rather than a bag of `unknown`.
 *
 * **The round cap still divides by the total child count, not by
 * `pending.length`.** A round now costs `pending.length` subrequests, so the
 * loop's *typical* cost fell - but the round this backstop exists for is the
 * one where nothing completed, and that round still costs one subrequest per
 * child. A cap sized against the cheaper case would not be a backstop.
 *
 * **A child that errored with a recognised transient platform class is
 * replaced once instead**, when - and only when - the caller supplied a
 * `ChildReplacement` (spec.md requirement 4's narrowing, 2026-09-01 (#92);
 * `isReplaceable` above holds every clause). The replacement is polled in the
 * original's place under its own deterministic id, its output is attributed
 * back to the original child's slot in `combine`'s input, and the fact of it
 * travels in this step's own output via `ChildPollState.replacements`.
 */
export async function pollChildBatch<TParams, T, TOutput>(
  binding: Workflow<TParams>,
  childIds: string[],
  state: ChildPollState<TOutput>,
  round: number,
  subrequestBudget: number,
  label: string,
  validate: (output: unknown, childId: string) => TOutput,
  combine: (outputs: TOutput[]) => T,
  replace?: ChildReplacement,
): Promise<ChildPollOutcome<T, TOutput>> {
  const statuses = await Promise.all(state.pending.map((id) => binding.get(id).then((instance) => instance.status())));

  // Completions are collected before any failure is acted on: a sibling that
  // completed in the very round another child errored must reach the state a
  // replacement round resumes from, not be discarded along with the error.
  const outputs = { ...state.outputs };
  const pending: string[] = [];
  const failures: { id: string; status: InstanceStatus }[] = [];
  statuses.forEach((s, i) => {
    const id = state.pending[i] ?? `#${i}`;
    if (s.status === 'complete') outputs[id] = validate(s.output, id);
    else if (s.status === 'errored' || s.status === 'terminated') failures.push({ id, status: s });
    else pending.push(id);
  });

  const replacements = { ...state.replacements };
  const failure = failures[0];
  if (failure !== undefined) {
    const thisRound = { failures: failures.length, stillRunning: pending.length };
    if (replace === undefined || !isReplaceable(replace, failure, thisRound, childIds, replacements)) {
      throw new Error(`${label} child ${failure.id} ${failure.status.status}`);
    }
    const replacementId = await replace.create(failure.id);
    replacements[failure.id] = replacementId;
    pending.push(replacementId);
  }

  if (pending.length > 0) {
    // Derived from childIds.length, not a fixed constant - a fixed round
    // count would let this backstop be beaten to the punch by the
    // platform's own subrequest error once there are enough children.
    //
    // **Corrected 2026-09-02 (#92): this counts polls, and the round that
    // throws is one of them.** The threshold was `round >= maxRounds` against
    // the same divisor, which polls at rounds `0..maxRounds` - the throwing
    // round has already spent `pending.length` subrequests on the statuses it
    // throws about. That is one poll more than this message claims and one
    // more than `createPublishChildren`'s ledger costs: at the three budgets
    // in force (10 + 9 + 4) the parent's real pessimal poll bill was
    // 15 + 12 + 5 = 32, so 55 of 50 rather than the 46 the ledger states,
    // before this requirement added anything. `max(2, ...)` keeps the old
    // floor of two polls for a loop whose child count exceeds its budget.
    //
    // A replacement raises the cap by `extraRounds`, because there is no
    // slack to reclaim: run `54ce776b` hit the cap in the same round its
    // child errored. Those rounds cost one subrequest each, which
    // `isReplaceable`'s last clause is what guarantees.
    const grant = Object.keys(replacements).length * (replace?.extraRounds ?? 0);
    const maxPolls = Math.max(2, Math.floor(subrequestBudget / childIds.length)) + grant;
    if (round >= maxPolls - 1) {
      throw new Error(`await-${label}-children: ${pending.length} children still not complete after ${maxPolls} polls`);
    }
    const next: ChildPollState<TOutput> = { pending, outputs };
    // Absent rather than empty, so a loop that supplies no `ChildReplacement`
    // emits a step output byte-identical to the one it emitted before this
    // mechanism existed.
    if (Object.keys(replacements).length > 0) next.replacements = replacements;
    return { done: false, state: next };
  }

  // In `childIds` order, never completion order: these results reach
  // `synthesize`, and what the run produces should not depend on which child
  // happened to finish first. Still `childIds` and not the replacement ids,
  // for the same reason - a replacement stands in the original child's place.
  // Asserted rather than cast, because a caller that ever seeds `state` with a
  // short `pending` list would otherwise hand `combine` an `undefined` typed
  // as a child's output.
  const results = childIds.map((id) => {
    const replacement = replacements[id];
    const output = outputs[id] ?? (replacement === undefined ? undefined : outputs[replacement]);
    if (output === undefined) throw new Error(`${label} child ${id} never reached a polled completion`);
    return output;
  });
  return { done: true, result: combine(results) };
}
