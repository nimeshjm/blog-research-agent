import { tracing, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
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
  return step.do(name, () => traced(name, { ...attrs, [ATTR_STEP]: stepAttr }, body));
}

/**
 * Binds the run-level attributes once so no call site can forget them. Every
 * step span carries the instance id, which is what makes the eleven spans
 * groupable into one run.
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
