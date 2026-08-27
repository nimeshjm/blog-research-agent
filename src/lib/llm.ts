import type { Env } from './types';
import {
  ATTR_GEN_AI_INPUT_TOKENS,
  ATTR_GEN_AI_MAX_TOKENS,
  ATTR_GEN_AI_MODEL,
  ATTR_GEN_AI_OPERATION,
  ATTR_GEN_AI_OUTPUT_TOKENS,
  ATTR_GEN_AI_PROVIDER,
  ATTR_NEURONS,
  traced,
} from './trace';

/**
 * The single seam between this agent and an inference provider.
 *
 * Nothing outside this file may call `env.AI.run`. Every call is routed through
 * AI Gateway so retries, caching, and token accounting are observable in one
 * place, and so swapping Workers AI for the Anthropic provider later is a
 * gateway/config change rather than a rewrite of the pipeline.
 *
 * The call is wrapped in a `chat` span via `traced()` from `src/lib/trace.ts` -
 * this file never imports `tracing` itself, per the observability convention
 * in CLAUDE.md. `gen_ai.*` naming matches AI Gateway's own exporter, and
 * `agent.neurons` reuses `neuronsFor()` below rather than recomputing the cost.
 */

/** Default completion length. Shared by the request and the `gen_ai.request.max_tokens` attribute. */
const DEFAULT_MAX_TOKENS = 2048;

/**
 * Floor under any caller-supplied `maxTokens`, caller default included.
 * `@cf/openai/gpt-oss-120b` is a reasoning model: issue #18's probe spent an
 * entire 32-token budget on reasoning and returned `content: null`. A request
 * for less than this gets bumped up rather than silently starved.
 */
const MIN_MAX_TOKENS = 1024;

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteRequest {
  messages: Message[];
  maxTokens?: number;
}

export interface CompleteResult {
  text: string;
  /** Token counts as reported by the provider; used for neuron accounting. */
  inputTokens: number;
  outputTokens: number;
  /**
   * The provider's own `finish_reason` ('stop', 'length', ...), when the
   * envelope carried one. `'length'` means the completion was cut off before
   * the model was done - distinct from a `finish_reason` that is present but
   * short, which means the model chose to stop.
   */
  finishReason: string | undefined;
}

export interface Llm {
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

/** Neuron cost of `@cf/openai/gpt-oss-120b`, per million tokens. */
const NEURONS_PER_M_INPUT = 31_818;
const NEURONS_PER_M_OUTPUT = 68_182;

export function neuronsFor(result: CompleteResult): number {
  return Math.ceil(
    (result.inputTokens / 1_000_000) * NEURONS_PER_M_INPUT +
      (result.outputTokens / 1_000_000) * NEURONS_PER_M_OUTPUT,
  );
}

/**
 * Workers AI returns `{ response, usage }` for text generation, but the exact
 * envelope varies across model families. Normalise defensively rather than
 * indexing into a shape we have not observed in production yet.
 *
 * `@cf/openai/gpt-oss-120b` is a reasoning model (#18): its message carries
 * `reasoning` / `reasoning_content` alongside `content`, and a completion cut
 * off mid-thought comes back with `content: null` and only reasoning text
 * populated. Falling back to that text is better than losing the call: the
 * reasoning trace *is* the model's output when nothing else was produced, and
 * `complete()` below still throws when there is truly nothing to fall back to.
 */
function normalise(raw: unknown): CompleteResult {
  const obj = (raw ?? {}) as Record<string, unknown>;

  let text = '';
  let finishReason: string | undefined;
  if (typeof obj.response === 'string') {
    text = obj.response;
  } else if (Array.isArray(obj.choices)) {
    const first = obj.choices[0] as
      | {
          message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown };
          finish_reason?: unknown;
        }
      | undefined;
    if (typeof first?.finish_reason === 'string') finishReason = first.finish_reason;

    const message = first?.message;
    if (typeof message?.content === 'string' && message.content !== '') {
      text = message.content;
    } else if (typeof message?.reasoning === 'string' && message.reasoning !== '') {
      text = message.reasoning;
    } else if (typeof message?.reasoning_content === 'string' && message.reasoning_content !== '') {
      text = message.reasoning_content;
    }
  }

  const usage = (obj.usage ?? {}) as Record<string, unknown>;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;

  return { text, inputTokens, outputTokens, finishReason };
}

export function createLlm(env: Env): Llm {
  return {
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const maxTokens = Math.max(req.maxTokens ?? DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS);

      return traced(
        'chat',
        {
          [ATTR_GEN_AI_OPERATION]: 'chat',
          [ATTR_GEN_AI_PROVIDER]: 'cloudflare.workers_ai',
          [ATTR_GEN_AI_MODEL]: env.LLM_MODEL,
          [ATTR_GEN_AI_MAX_TOKENS]: maxTokens,
        },
        async (span) => {
          const raw = await env.AI.run(
            env.LLM_MODEL as keyof AiModels,
            {
              messages: req.messages,
              max_tokens: maxTokens,
            } as never,
            { gateway: { id: env.AI_GATEWAY } },
          );

          const result = normalise(raw);
          if (result.text === '') {
            // 'length' means the token budget ran out before the model produced
            // anything usable (reasoning included) - a maxTokens problem, not a
            // provider outage, and not transient: a retried step throws the
            // same way every time until maxTokens goes up. Anything else with
            // no text (missing/short-circuited response, content filter, ...)
            // is a distinct failure and is named as such rather than folded in.
            const cause =
              result.finishReason === 'length'
                ? `truncated at maxTokens=${maxTokens} before producing any content or reasoning text`
                : `produced no content or reasoning text (finish_reason: ${result.finishReason ?? 'unknown'})`;
            throw new Error(`Empty completion from ${env.LLM_MODEL}: ${cause}`);
          }

          // Result-derived: only known once the call returns, so they are set
          // on the span handed to this body rather than passed as attrs above.
          span.setAttribute(ATTR_GEN_AI_INPUT_TOKENS, result.inputTokens);
          span.setAttribute(ATTR_GEN_AI_OUTPUT_TOKENS, result.outputTokens);
          span.setAttribute(ATTR_NEURONS, neuronsFor(result));

          return result;
        },
      );
    },
  };
}
