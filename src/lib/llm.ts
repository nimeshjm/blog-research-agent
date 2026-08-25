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
 */
function normalise(raw: unknown): CompleteResult {
  const obj = (raw ?? {}) as Record<string, unknown>;

  let text = '';
  if (typeof obj.response === 'string') {
    text = obj.response;
  } else if (Array.isArray(obj.choices)) {
    const first = obj.choices[0] as { message?: { content?: unknown } } | undefined;
    if (typeof first?.message?.content === 'string') text = first.message.content;
  }

  const usage = (obj.usage ?? {}) as Record<string, unknown>;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;

  return { text, inputTokens, outputTokens };
}

export function createLlm(env: Env): Llm {
  return {
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;

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
            throw new Error(`Empty completion from ${env.LLM_MODEL}`);
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
