/**
 * The create/poll shape behind every child Workflow this repo runs
 * (`GatherWorkflow`, `SummarizeWorkflow`) - feature 003's "Gather in child
 * instances" design (spec.md), generalized here rather than copied a second
 * time when article summarization became the second child (extended
 * 2026-08-31, #75). Deterministic ids verified against reality rather than
 * assumed, and "a failed child fails the run visibly" (spec.md requirement
 * 4) are the parts every caller shares; what a child actually returns (a
 * count, or summaries-plus-neuron-spend) stays with the caller, via
 * `createChildBatch`'s params and `pollChildBatch`'s `combine`.
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

export type ChildPollOutcome<T> = { done: true; result: T } | { done: false };

/**
 * One poll round shared by every `await-<x>-children` step. A child that is
 * `errored` or `terminated` fails this immediately (spec.md requirement 4 -
 * the deliberate opposite of a single dead *item* inside a child, which
 * still contributes zero without failing anything). While any child is not
 * yet `complete`, this returns `{ done: false }` up to a subrequest-budget-
 * derived round cap - past it, this throws rather than lets the platform's
 * own opaque subrequest error be the first sign anything is stuck. Once
 * every child is `complete`, `combine` turns each child's raw (`unknown`,
 * per `InstanceStatus.output`) result into whatever the caller's poll
 * result type is - validating, not casting, is `combine`'s job, not this
 * function's.
 */
export async function pollChildBatch<TParams, T>(
  binding: Workflow<TParams>,
  childIds: string[],
  round: number,
  subrequestBudget: number,
  label: string,
  combine: (outputs: unknown[]) => T,
): Promise<ChildPollOutcome<T>> {
  const statuses = await Promise.all(childIds.map((id) => binding.get(id).then((instance) => instance.status())));

  statuses.forEach((s, i) => {
    if (s.status === 'errored' || s.status === 'terminated') {
      throw new Error(`${label} child ${childIds[i]} ${s.status}`);
    }
  });

  if (statuses.some((s) => s.status !== 'complete')) {
    // Derived from childIds.length, not a fixed constant - a fixed round
    // count would let this backstop be beaten to the punch by the
    // platform's own subrequest error once there are enough children.
    const maxRounds = Math.max(1, Math.floor(subrequestBudget / childIds.length));
    if (round >= maxRounds) {
      throw new Error(`await-${label}-children: ${childIds.length} children still not complete after ${maxRounds} polls`);
    }
    return { done: false };
  }

  return { done: true, result: combine(statuses.map((s) => s.output)) };
}
