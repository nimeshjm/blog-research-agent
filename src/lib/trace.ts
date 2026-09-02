import {
  tracing,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
// `Span` needs no import: workers-types declares it globally
// (`declare abstract class Span`), not inside the cloudflare:workers module.

/**
 * The single instrumentation seam. Mirrors what `src/lib/llm.ts` does for
 * inference: one file owns the dependency (`tracing` from `cloudflare:workers`),
 * everything else calls `traced()`, `tracedStep()` or `tracerFor()`.
 *
 * Three rules drive the shape, all from `REVIEW.md` pass 3:
 *
 * 1. The step name is the replay key. `tracedStep` passes `name` to `step.do`
 *    byte-identical and reuses it as the span name. No decoration, no
 *    interpolation of mutable state.
 * 2. `enterSpan` goes *inside* `step.do`, never around it. On replay a
 *    completed step returns its cached result without running the body; a
 *    span outside would emit once per replay attempt and time nothing.
 * 3. No span in `run()` outside a step body. `run()` itself re-executes on
 *    every replay, so a run-level span there would duplicate. Run-level facts
 *    ride on the `record-*` steps instead.
 */

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/**
 * No step is ever retried (feature 003, `spec.md` requirement 1). A retry was
 * measured to run inside the same `run()` execution as the attempt that failed
 * - same module-scope counter, same isolate - so for a CPU failure it inherits
 * the exhausted budget rather than getting a fresh one (`probe/FINDINGS.md`).
 * Five minutes of backoff, then the same `1102`.
 *
 * `delay` is required by `WorkflowStepConfig` even though nothing waits.
 * `rules/no-step-retry-config.yml` keeps this the only retry config in `src/`.
 */
const NO_RETRIES: WorkflowStepConfig = { retries: { limit: 0, delay: 0 } };

// --- agent.* --------------------------------------------------------------
// Ours. Set on every Workflow step span.
export const ATTR_STEP = 'agent.step';
export const ATTR_OUTCOME = 'agent.step.outcome';
export const ATTR_TOPIC_ID = 'agent.topic.id';
export const ATTR_SOURCES_GATHERED = 'agent.sources.gathered';
export const ATTR_SOURCES_SHORTLISTED = 'agent.sources.shortlisted';
export const ATTR_SOURCES_USED = 'agent.sources.used';
export const ATTR_NEURONS_SPENT = 'agent.neurons.spent';
export const ATTR_NEURONS_BUDGET = 'agent.neurons.budget';
export const ATTR_RUN_STATUS = 'agent.run.status';
export const ATTR_INSTANCE_ID = 'agent.workflow.instance_id';
export const ATTR_WORKFLOW_NAME = 'agent.workflow.name';
/** Per-call neuron cost, set in `llm.ts` from the existing `neuronsFor()`. */
export const ATTR_NEURONS = 'agent.neurons';
/**
 * Low-cardinality enum naming why a `summarize:*` step skipped an article
 * (see `SummarizeSkipReason` in `summarize-workflow.ts`). Set only on a skip. The
 * higher-detail diagnostics (HTTP status, a truncated fetch-error message)
 * live in that step's *output*, not here - a span attribute is enforced
 * fields-only by `span-attributes-allowlisted`, and a step's return value,
 * read via `wrangler workflows instances describe`, is a separate channel
 * CLAUDE.md's message-in-an-attribute rule was never about.
 */
export const ATTR_SUMMARIZE_SKIP_REASON = 'agent.summarize.skip_reason';
/** Number of GatherWorkflow children, on the parent's `create-gather-children` / `await-gather-children` spans (feature 003). */
export const ATTR_GATHER_CHILDREN = 'agent.gather.children';
/** 0-based position among the parent's children, on a child's own `gather:*` span - see `GatherParams.index`'s doc comment. */
export const ATTR_GATHER_CHILD_INDEX = 'agent.gather.child_index';
/** Number of SummarizeWorkflow children, on the parent's `create-summarize-children` / `await-summarize-children` spans (feature 003, extended 2026-08-31 (#75)). */
export const ATTR_SUMMARIZE_CHILDREN = 'agent.summarize.children';
/** 0-based position among the parent's children, on a child's own `summarize:*` span - see `SummarizeParams.index`'s doc comment. */
export const ATTR_SUMMARIZE_CHILD_INDEX = 'agent.summarize.child_index';
/**
 * Number of PublishWorkflow children, on the parent's
 * `create-publish-children` / `await-publish-children` spans (feature 003,
 * extended 2026-09-01 (#75)). Always 1 today, and carried anyway so a poll
 * round's subrequest cost is readable off its own span the way the other two
 * loops' are.
 *
 * There is deliberately no `agent.publish.child_index` counterpart: with one
 * child it would disambiguate nothing, and an attribute is CPU against the
 * budget its step's invocation may already be sharing.
 *
 * The pull request URL is not here and must not be - CLAUDE.md forbids a URL
 * in a span attribute. It travels as the poll step's *output*, which is the
 * permitted channel (see `ATTR_SUMMARIZE_SKIP_REASON` above for the same
 * distinction).
 */
export const ATTR_PUBLISH_CHILDREN = 'agent.publish.children';
/**
 * How many SummarizeWorkflow children this run has replaced after a
 * recognised transient platform failure, on the parent's
 * `await-summarize-children` spans (spec.md requirement 4's narrowing,
 * 2026-09-01 (#92)). 0 on almost every run, and carried so a replaced child
 * is reported rather than silently absorbed into a longer wall clock.
 *
 * A **count**, deliberately. The replacement's id travels in the poll step's
 * own output, and the recognised error string reaches no attribute at all -
 * `error.type`'s constructor name is the only error channel a span has
 * (CLAUDE.md's attribute rule; the same distinction
 * `ATTR_SUMMARIZE_SKIP_REASON` above draws). It takes the poll span to six
 * attributes, inside the roughly-eight ceiling.
 */
export const ATTR_SUMMARIZE_REPLACEMENTS = 'agent.summarize.replacements';

// --- gen_ai.* ---------------------------------------------------------------
// Matches AI Gateway's own exporter conventions, so the two line up if that
// exporter is ever enabled. Set only in `llm.ts`, around the one `env.AI.run`
// call site.
export const ATTR_GEN_AI_OPERATION = 'gen_ai.operation.name';
export const ATTR_GEN_AI_PROVIDER = 'gen_ai.provider.name';
export const ATTR_GEN_AI_MODEL = 'gen_ai.request.model';
export const ATTR_GEN_AI_MAX_TOKENS = 'gen_ai.request.max_tokens';
export const ATTR_GEN_AI_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const ATTR_GEN_AI_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';

/** The primitive. Everything else composes this; nothing else imports `tracing`. */
export function traced<T>(
  name: string,
  attrs: SpanAttributes,
  body: (span: Span) => Promise<T>,
): Promise<T> {
  return tracing.enterSpan(name, async (span) => {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) span.setAttribute(k, v);
    }
    try {
      const result = await body(span);
      span.setAttribute(ATTR_OUTCOME, 'ok');
      return result;
    } catch (err) {
      span.setAttribute(ATTR_OUTCOME, 'error');
      // Constructor name only. An error message can carry a URL or a token.
      span.setAttribute('error.type', (err as Error)?.constructor?.name ?? 'Error');
      throw err;
    }
  });
}

/**
 * `traced` composed with `step.do`. The span is opened inside the step body,
 * per rule 2 above.
 *
 * `agent.step` is deliberately not `name` verbatim: `name` is the replay key
 * and, for the dynamic steps (`gather:${source.name}`, `summarize:${candidate.url}`),
 * carries per-item state - `summarize:*` carries a candidate's URL. `step.do`
 * and the span name both still get `name` whole and unchanged, because that is
 * what replay and rule 1 require. The attribute only gets the prefix before
 * the first `:`, so it stays a low-cardinality label and never carries a URL
 * into a span attribute (`REVIEW.md` pass 2).
 */
export function tracedStep<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  name: string, // passed to step.do unchanged - this is the replay key
  attrs: SpanAttributes,
  body: (span: Span) => Promise<T>,
): Promise<T> {
  const stepAttr = name.split(':')[0] ?? name;
  return step.do(name, NO_RETRIES, () =>
    traced(name, { ...attrs, [ATTR_STEP]: stepAttr }, body),
  );
}

/**
 * Binds the run-level attributes once so no call site can forget them. Every
 * step span carries the instance id, which is what makes a run's spans
 * groupable into one run - the count is not fixed and has not been since the
 * per-item work moved into child instances, each of which reports under its
 * own id.
 */
export function tracerFor(step: WorkflowStep, event: WorkflowEvent<unknown>) {
  const base: SpanAttributes = {
    [ATTR_INSTANCE_ID]: event.instanceId,
    [ATTR_WORKFLOW_NAME]: event.workflowName,
  };
  return <T extends Rpc.Serializable<T>>(
    name: string,
    attrs: SpanAttributes,
    body: (span: Span) => Promise<T>,
  ): Promise<T> => tracedStep(step, name, { ...base, ...attrs }, body);
}
