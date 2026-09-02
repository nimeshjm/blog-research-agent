import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { extractArticleText } from './lib/extract';
import { createLlm, neuronsFor } from './lib/llm';
import { buildMapMessages, parseMapResponse } from './lib/prompts';
import type { ArticleSummary, Candidate, Env, SummarizeChildOutput, SummarizeParams, Topic } from './lib/types';
import { ATTR_SUMMARIZE_CHILD_INDEX, ATTR_SUMMARIZE_SKIP_REASON, tracerFor } from './lib/trace';

/**
 * feature 003's second child instance (spec.md requirement 2, extended
 * 2026-08-31 (#75) after measuring the half of the design that shipped
 * first: run `6f75e460` moved 46 feeds off the parent's own invocation and
 * the parent still failed its 15th article on `Too many subrequests by
 * single Worker invocation.`). One per chunk of
 * `SUMMARIZE_ARTICLES_PER_CHILD` shortlisted candidates
 * (`createSummarizeChildren`, src/workflow.ts), so each article's fetch and
 * model call land in a fresh invocation lineage rather than the parent's -
 * the same reason `GatherWorkflow` exists, applied to the other half of the
 * parent's per-item work.
 *
 * Unlike a gather child, this one cannot return a bare count: `synthesize`
 * (src/workflow.ts) needs the summaries themselves. See
 * `createSummarizeChildren`'s comment for the 1 MiB step-result arithmetic
 * that makes returning them through `InstanceStatus.output` safe, and for
 * why this is a second `WorkflowEntrypoint` class rather than one
 * parameterised over both jobs - the binding is `Workflow<TParams>`, so one
 * class would mean one binding carrying a union params type and a union
 * return type the parent has to narrow before validating either half.
 *
 * `event.payload.neuronBudget` is this child's own slice of the run's
 * remaining budget, not the whole thing - children run concurrently with no
 * shared state, so `runSummarize` applies the same spend-then-check gate
 * `run()` used to apply inline (spec req. 6, the budget gate), against this
 * slice rather than `NEURON_BUDGET_PER_RUN` itself. See
 * `createSummarizeChildren`'s comment for how the slice is derived and why
 * that bounds the children's *combined* spend.
 *
 * The body is `runSummarize`, a plain function, for the same reason
 * `runGather` is one (src/gather-workflow.ts): `WorkflowEntrypoint` rejects
 * being `new`'d outside the platform's own Workflows runtime, so `run()`
 * itself is untestable in isolation.
 */
export async function runSummarize(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<SummarizeParams>,
): Promise<SummarizeChildOutput> {
  const traceStep = tracerFor(step, event);
  const { candidates, topic, neuronBudget, parentInstanceId } = event.payload;

  const summaries: ArticleSummary[] = [];
  let neuronsSpent = 0;
  for (const candidate of candidates) {
    // Same gate `run()` used to apply per-article across the whole
    // shortlist (spec req. 6) - now per-child, against this child's own
    // slice of the budget rather than the run's total, because a sibling
    // child spending concurrently is invisible to this loop. The check is
    // against SUMMARY_NEURON_ESTIMATE, not this call's real cost, so this
    // child's own actual spend can still overshoot its slice by (real cost
    // - estimate) on the call that trips it - the same bound the old
    // single-loop gate had on the whole run, now scoped to one child's
    // slice instead (createSummarizeChildren's comment has the arithmetic).
    if (neuronsSpent + SUMMARY_NEURON_ESTIMATE > neuronBudget) break;

    // `agent.step` on this span is the `summarize` prefix - the same
    // literal `summarize:<url>` step name the parent used to carry, moved
    // here unchanged. `candidate.url` stays out of every span attribute
    // (REVIEW.md pass 2) even though it still passes through to step.do
    // unchanged, because that is the replay key.
    const result = await traceStep(
      `summarize:${candidate.url}`,
      { [ATTR_SUMMARIZE_CHILD_INDEX]: event.payload.index },
      async (span) => {
        const outcome = await summarizeArticle(env, candidate, topic, parentInstanceId);
        if (outcome.skipReason !== undefined) span.setAttribute(ATTR_SUMMARIZE_SKIP_REASON, outcome.skipReason);
        return outcome;
      },
    );
    neuronsSpent += result.neurons;
    if (result.summary !== null) summaries.push(result.summary);
  }

  return { summaries, neuronsSpent };
}

export class SummarizeWorkflow extends WorkflowEntrypoint<Env, SummarizeParams> {
  run(event: WorkflowEvent<SummarizeParams>, step: WorkflowStep): Promise<SummarizeChildOutput> {
    return runSummarize(this.env, step, event);
  }
}

/** Conservative per-article estimate used for the budget gate - see spec.md's cost table (measured, #18). */
export const SUMMARY_NEURON_ESTIMATE = 300;

/**
 * `maxTokens` for the map call. Matches what `plan.md` step 2's probe used
 * (4,096) - the 203/223-neuron measurements in spec.md's cost table were
 * taken at this ceiling, so raising it materially would need remeasuring.
 */
const MAP_MAX_TOKENS = 4096;

/**
 * Every way `summarizeArticle` can skip an article without failing the run.
 * Machine-readable so a `describe`d step output (or the `agent.summarize.skip_reason`
 * span attribute) can say *which* early return fired instead of collapsing
 * all of them into one indistinguishable `summary: null` - the gap that made
 * a real run (525a5386-deb0-4d4b-8242-d4246462884e, 2026-08-31) where all 15
 * `summarize` steps skipped look identical whether that was one shared cause
 * or 15 unrelated ones.
 */
export type SummarizeSkipReason = 'fetch-threw' | 'http-error' | 'empty-extract' | 'truncated' | 'unparseable';

/**
 * `errorMessage` and `status` are diagnostics for the *step output* only -
 * `wrangler workflows instances describe` persists whatever `summarizeArticle`
 * returns, which is the only channel that survived to read the deployed run
 * this type was added for. They must never reach a span attribute: CLAUDE.md
 * forbids an error message (or a URL) there, constructor name only via
 * `error.type` - see `ATTR_SUMMARIZE_SKIP_REASON`'s comment in `trace.ts` for
 * why the step output is a different, permitted channel.
 */
export interface SummarizeResult {
  summary: ArticleSummary | null;
  neurons: number;
  skipReason?: SummarizeSkipReason;
  /** Set only for `skipReason: 'http-error'`. */
  status?: number;
  /** Set only for `skipReason: 'fetch-threw'`, capped so a huge message can't bloat the step output. */
  errorMessage?: string;
}

const ERROR_MESSAGE_MAX_LEN = 100;

/** A Cloudflare subrequest-limit failure surfaces as a plain `Error` - the message, not the constructor, carries the signal. */
function truncatedMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > ERROR_MESSAGE_MAX_LEN ? message.slice(0, ERROR_MESSAGE_MAX_LEN) : message;
}

/**
 * One fetch, streamed extraction (`src/lib/extract.ts`), one `Llm` call.
 * Returns `summary: null` - never throws for anything short of the `Llm`
 * call itself failing - so one bad article (unfetchable, unextractable, or a
 * response that doesn't parse as the expected JSON) cannot fail the run
 * (spec.md risk table). `neurons` is still reported on every path that
 * actually spent them, so the budget gate in `runSummarize` stays accurate
 * even when the article was a bust.
 *
 * `parentInstanceId` is threaded through to `createLlm` unchanged (#91, slice
 * 2) - the *parent* `ResearchWorkflow`'s instance id, not this child's own,
 * so the gateway metadata this call tags joins back to the same `runs` row
 * every other call in the run does. See `SummarizeParams.parentInstanceId`'s
 * doc comment (src/lib/types.ts).
 */
export async function summarizeArticle(
  env: Env,
  candidate: Candidate,
  topic: Topic,
  parentInstanceId: string,
): Promise<SummarizeResult> {
  let response: Response;
  try {
    response = await fetch(candidate.url);
  } catch (err) {
    return { summary: null, neurons: 0, skipReason: 'fetch-threw', errorMessage: truncatedMessage(err) };
  }
  if (!response.ok) return { summary: null, neurons: 0, skipReason: 'http-error', status: response.status };

  const articleText = await extractArticleText(response);
  if (articleText === '') return { summary: null, neurons: 0, skipReason: 'empty-extract' };

  const llm = createLlm(env, parentInstanceId);
  const result = await llm.complete({
    messages: buildMapMessages(topic, candidate, articleText),
    maxTokens: MAP_MAX_TOKENS,
  });
  const neurons = neuronsFor(result);

  // A truncated completion's text (if any survived) is not trustworthy JSON
  // - skip parsing it rather than risk parseMapResponse accepting a
  // partial/malformed object by accident.
  if (result.finishReason === 'length') return { summary: null, neurons, skipReason: 'truncated' };

  // Never throws on a rejection (see parseMapResponse's doc comment). The
  // parser's own finer-grained reason is still discarded: one bad article
  // must not fail the run, and distinguishing it from a truncated completion
  // is as far as this caller needs to go - unlike synthesizeDraft, which does
  // throw and reports its ReduceParseFailure.
  const parsed = parseMapResponse(result.text);
  if (!parsed.ok) return { summary: null, neurons, skipReason: 'unparseable' };

  return {
    summary: { url: candidate.url, title: candidate.title, ...parsed.value },
    neurons,
  };
}
