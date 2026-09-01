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
): Promise<ChildPollOutcome<T, TOutput>> {
  const statuses = await Promise.all(state.pending.map((id) => binding.get(id).then((instance) => instance.status())));

  statuses.forEach((s, i) => {
    if (s.status === 'errored' || s.status === 'terminated') {
      throw new Error(`${label} child ${state.pending[i]} ${s.status}`);
    }
  });

  const outputs = { ...state.outputs };
  const pending: string[] = [];
  statuses.forEach((s, i) => {
    const id = state.pending[i] ?? `#${i}`;
    if (s.status === 'complete') outputs[id] = validate(s.output, id);
    else pending.push(id);
  });

  if (pending.length > 0) {
    // Derived from childIds.length, not a fixed constant - a fixed round
    // count would let this backstop be beaten to the punch by the
    // platform's own subrequest error once there are enough children.
    const maxRounds = Math.max(1, Math.floor(subrequestBudget / childIds.length));
    if (round >= maxRounds) {
      throw new Error(`await-${label}-children: ${pending.length} children still not complete after ${maxRounds} polls`);
    }
    return { done: false, state: { pending, outputs } };
  }

  // In `childIds` order, never completion order: these results reach
  // `synthesize`, and what the run produces should not depend on which child
  // happened to finish first. Asserted rather than cast, because a caller that
  // ever seeds `state` with a short `pending` list would otherwise hand
  // `combine` an `undefined` typed as a child's output.
  const results = childIds.map((id) => {
    const output = outputs[id];
    if (output === undefined) throw new Error(`${label} child ${id} never reached a polled completion`);
    return output;
  });
  return { done: true, result: combine(results) };
}
