import { describe, expect, it } from 'vitest';
import { createLlm, neuronsFor } from '../src/lib/llm';
import type { Env } from '../src/lib/types';

/**
 * Only the fields `createLlm()`'s `complete()` touches. Deliberately not a
 * real `AI` binding: CLAUDE.md records that the AI binding has no local
 * simulation and runs in remote mode even under `wrangler dev`, so a fast,
 * offline unit test drives the stub's `run` rather than the real one -
 * `stub.run` is a plain function *definition*, not a call to `env.AI.run`,
 * so `ai-run-only-in-llm` still holds: the one call site stays in
 * `src/lib/llm.ts`.
 */
function stubEnv(fixture: unknown, capture?: { maxTokens?: number }): Env {
  return {
    AI: {
      run: async (_model: unknown, options: { max_tokens?: number }) => {
        if (capture) capture.maxTokens = options.max_tokens;
        return fixture;
      },
    },
    LLM_MODEL: 'test-model',
    AI_GATEWAY: 'test-gateway',
  } as unknown as Env;
}

describe('createLlm().complete()', () => {
  it('falls back to reasoning text when content is null (#18 fixture)', async () => {
    // The exact envelope from issue #18: maxTokens 32, prompt "Reply with the
    // single word: pong". content came back null; the whole budget went to
    // reasoning.
    const fixture = {
      choices: [
        {
          message: {
            content: null,
            reasoning: 'The user asks: "Reply with the single word: pong". So respond with just "pong".',
          },
        },
      ],
      usage: { prompt_tokens: 74, completion_tokens: 32, neurons: 4.54 },
    };
    const llm = createLlm(stubEnv(fixture), 'run-test');
    const result = await llm.complete({ messages: [{ role: 'user', content: 'ping' }] });

    expect(result.text).toContain('pong');
    expect(result.inputTokens).toBe(74);
    expect(result.outputTokens).toBe(32);
  });

  it('prefers content over reasoning when both are present', async () => {
    const fixture = {
      choices: [{ message: { content: 'pong', reasoning: 'thinking...' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const llm = createLlm(stubEnv(fixture), 'run-test');
    const result = await llm.complete({ messages: [{ role: 'user', content: 'ping' }] });

    expect(result.text).toBe('pong');
  });

  it('falls back to reasoning_content when reasoning is absent', async () => {
    const fixture = {
      choices: [{ message: { content: null, reasoning_content: 'legacy reasoning field' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const llm = createLlm(stubEnv(fixture), 'run-test');
    const result = await llm.complete({ messages: [{ role: 'user', content: 'ping' }] });

    expect(result.text).toBe('legacy reasoning field');
  });

  it('throws an error naming truncation when the budget ran out before any output', async () => {
    const fixture = {
      choices: [{ message: { content: null }, finish_reason: 'length' }],
      usage: { prompt_tokens: 74, completion_tokens: 2048 },
    };
    const llm = createLlm(stubEnv(fixture), 'run-test');

    await expect(
      llm.complete({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 2048 }),
    ).rejects.toThrow(/truncat/i);
  });

  it('names a different cause when the completion is empty but not truncated', async () => {
    const fixture = {
      choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    };
    const llm = createLlm(stubEnv(fixture), 'run-test');

    let message = '';
    try {
      await llm.complete({ messages: [{ role: 'user', content: 'ping' }] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/content_filter/);
    expect(message).not.toMatch(/truncat/i);
  });

  it('floors maxTokens so a caller cannot starve reasoning the way #18 did', async () => {
    const capture: { maxTokens?: number } = {};
    const fixture = {
      choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const llm = createLlm(stubEnv(fixture, capture), 'run-test');

    await llm.complete({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 32 });

    expect(capture.maxTokens).toBeGreaterThanOrEqual(1024);
  });
});

describe('neuronsFor()', () => {
  it('matches the ungated measurement from #18: 74 input + 31 output -> ceil(4.4696) = 5', () => {
    const neurons = neuronsFor({ text: 'x', inputTokens: 74, outputTokens: 31, finishReason: 'stop' });

    expect(neurons).toBe(5);
  });
});
