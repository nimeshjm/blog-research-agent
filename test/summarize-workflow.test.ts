import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSummarize, SUMMARY_NEURON_ESTIMATE, summarizeArticle } from '../src/summarize-workflow';
import type { ArticleSummary, Candidate, Env, SummarizeParams, Topic } from '../src/lib/types';

/**
 * `summarizeArticle`'s own behaviour - moved here unchanged from
 * test/workflow.test.ts (feature 003, extended 2026-08-31 (#75), mirroring
 * how gatherCandidates' tests moved with it in the earlier PR - "Reuse" in
 * plan.md). This is the body `SummarizeWorkflow.run()` calls once per
 * candidate; nothing about a single article's fetch/extract/summarize
 * changed when it moved from the parent's own step loop into a child
 * instance's.
 */

const rawEnv = testEnv as unknown as Env;
const env: Env = {
  ...rawEnv,
  BLOG_FEED_URL: 'https://blog.test.example/rss.xml',
  BLOG_REPO: 'nimeshjm/nimeshjm.com',
  GITHUB_API_BASE: 'https://api.test.example',
  GITHUB_TOKEN: 'test-token',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    url: 'https://example.com/x',
    title: 'x',
    publishedAt: '2026-08-27T00:00:00Z',
    publishedMs: null,
    sourceName: 'Test Source',
    ...overrides,
  };
}

function topic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 1,
    title: 'Agentic code review practices',
    angle: 'What actually catches bugs',
    status: 'in_progress',
    origin: 'human',
    createdAt: '2026-08-27T00:00:00Z',
    ...overrides,
  };
}

/**
 * `env.AI` with a stub `run` - the same approach `test/llm.test.ts` and
 * `test/workflow.test.ts` use. `[ai]` is stripped from the pool's wrangler
 * config (vitest.config.ts's comment), so `env.AI` is otherwise undefined;
 * `createLlm()` never calls `env.AI.run` outside `src/lib/llm.ts`, so
 * stubbing it here still leaves `ai-run-only-in-llm` meaning something.
 */
function envWithAi(fixture: unknown): Env {
  return {
    ...env,
    AI: { run: async () => fixture } as unknown as Env['AI'],
  };
}

function chatFixture(content: string, finishReason = 'stop'): unknown {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

function articleResponse(bodyHtml: string): Response {
  return new Response(`<html><body>${bodyHtml}</body></html>`, { headers: { 'content-type': 'text/html' } });
}

describe('summarizeArticle()', () => {
  it('fetches, extracts, and parses a well-formed map response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => articleResponse('<p>Real article prose about agentic code review.</p>')),
    );
    const aiEnv = envWithAi(
      chatFixture(JSON.stringify({ summary: 'It works.', relevance: 0.7, claims: ['c1'], attributablePractice: 'Practice X' })),
    );

    const result = await summarizeArticle(aiEnv, candidate({ url: 'https://example.com/a', title: 'Article A' }), topic(), 'run-test');

    expect(result.summary).toEqual({
      url: 'https://example.com/a',
      title: 'Article A',
      summary: 'It works.',
      relevance: 0.7,
      claims: ['c1'],
      attributablePractice: 'Practice X',
    });
    expect(result.neurons).toBeGreaterThan(0);
  });

  it('returns skipReason: fetch-threw (with a truncated error message) when the fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const result = await summarizeArticle(envWithAi(chatFixture('{}')), candidate(), topic(), 'run-test');
    expect(result.summary).toBeNull();
    expect(result.neurons).toBe(0);
    expect(result.skipReason).toBe('fetch-threw');
    expect(result.errorMessage).toBe('network down');
    expect(result.status).toBeUndefined();
  });

  it('caps errorMessage at 100 chars for a fetch throw with a long message', async () => {
    const longMessage = 'x'.repeat(200);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(longMessage);
      }),
    );
    const result = await summarizeArticle(envWithAi(chatFixture('{}')), candidate(), topic(), 'run-test');
    expect(result.skipReason).toBe('fetch-threw');
    expect(result.errorMessage).toHaveLength(100);
    expect(result.errorMessage).toBe(longMessage.slice(0, 100));
  });

  it('returns skipReason: http-error (with the status) on a non-2xx fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const result = await summarizeArticle(envWithAi(chatFixture('{}')), candidate(), topic(), 'run-test');
    expect(result.summary).toBeNull();
    expect(result.neurons).toBe(0);
    expect(result.skipReason).toBe('http-error');
    expect(result.status).toBe(404);
    expect(result.errorMessage).toBeUndefined();
  });

  it('returns skipReason: empty-extract when the article body extracts to nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => articleResponse('<script>only script content</script>')));
    const result = await summarizeArticle(envWithAi(chatFixture('{}')), candidate(), topic(), 'run-test');
    expect(result.summary).toBeNull();
    expect(result.neurons).toBe(0);
    expect(result.skipReason).toBe('empty-extract');
    expect(result.status).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
  });

  it('returns skipReason: unparseable (but still reports spent neurons) when the model response is not parseable JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => articleResponse('<p>Article prose.</p>')));
    const aiEnv = envWithAi(chatFixture('I think the article is about... (reasoning-fallback prose, not JSON)'));

    const result = await summarizeArticle(aiEnv, candidate(), topic(), 'run-test');

    expect(result.summary).toBeNull();
    expect(result.neurons).toBeGreaterThan(0);
    expect(result.skipReason).toBe('unparseable');
  });

  it('returns skipReason: truncated when the completion was truncated (finish_reason: length)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => articleResponse('<p>Article prose.</p>')));
    const aiEnv = envWithAi(chatFixture('{"summary": "cut off h', 'length'));

    const result = await summarizeArticle(aiEnv, candidate(), topic(), 'run-test');
    expect(result.summary).toBeNull();
    expect(result.skipReason).toBe('truncated');
  });

  it('distinguishes truncated from unparseable - both skip before a summary but for different reasons', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => articleResponse('<p>Article prose.</p>')));

    const truncated = await summarizeArticle(envWithAi(chatFixture('{"summary": "cut off h', 'length')), candidate(), topic(), 'run-test');
    const unparseable = await summarizeArticle(envWithAi(chatFixture('not json at all')), candidate(), topic(), 'run-test');

    expect(truncated.skipReason).toBe('truncated');
    expect(unparseable.skipReason).toBe('unparseable');
    expect(truncated.skipReason).not.toBe(unparseable.skipReason);
  });
});

/**
 * Unlike trace.test.ts's `recordingStep` (which deliberately never invokes
 * its callback, so tests there don't depend on `tracing` being live), this
 * one actually runs the step body - the only way to prove `runSummarize`'s
 * budget gate and its aggregation of `{ summaries, neuronsSpent }`, the same
 * reason gather-workflow.test.ts's own `liveStep()` exists.
 */
function liveStep(): WorkflowStep {
  return {
    do: async (_name: string, arg2: unknown, arg3?: unknown) => {
      const callback = typeof arg3 === 'function' ? arg3 : arg2;
      if (typeof callback !== 'function') throw new Error('liveStep: no callback provided to step.do');
      return callback();
    },
    sleep: async () => undefined,
  } as unknown as WorkflowStep;
}

function summarizeEvent(payload: SummarizeParams): WorkflowEvent<SummarizeParams> {
  return { instanceId: 'child-own-instance-id', workflowName: 'summarize-workflow', payload } as unknown as WorkflowEvent<SummarizeParams>;
}

describe("runSummarize() (SummarizeWorkflow.run()'s body)", () => {
  it('summarizes every candidate and returns the concatenated summaries plus total neuron spend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html><body><p>Article prose about the topic.</p></body></html>', { headers: { 'content-type': 'text/html' } })),
    );
    const aiEnv = envWithAi(
      chatFixture(JSON.stringify({ summary: 'A summary.', relevance: 0.6, claims: [], attributablePractice: null })),
    );

    const payload: SummarizeParams = {
      candidates: [candidate({ url: 'https://example.com/a' }), candidate({ url: 'https://example.com/b' })],
      topic: topic(),
      neuronBudget: 10_000,
      index: 0,
      parentInstanceId: 'parent-own-instance-id',
    };

    const result = await runSummarize(aiEnv, liveStep(), summarizeEvent(payload));

    expect(result.summaries).toHaveLength(2);
    expect(result.summaries.map((s: ArticleSummary) => s.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(result.neuronsSpent).toBeGreaterThan(0);
  });

  it('stops before spending past its own neuronBudget slice, leaving later candidates unsummarized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html><body><p>Article prose about the topic.</p></body></html>', { headers: { 'content-type': 'text/html' } })),
    );
    const aiEnv = envWithAi(
      chatFixture(JSON.stringify({ summary: 'A summary.', relevance: 0.6, claims: [], attributablePractice: null })),
    );

    const payload: SummarizeParams = {
      candidates: [
        candidate({ url: 'https://example.com/a' }),
        candidate({ url: 'https://example.com/b' }),
        candidate({ url: 'https://example.com/c' }),
      ],
      topic: topic(),
      // Exactly one estimate's worth: the gate is `neuronsSpent +
      // SUMMARY_NEURON_ESTIMATE > neuronBudget`, checked *before* a
      // candidate is fetched - the first call passes (0 + estimate <=
      // budget), and the small actual spend it reports (a handful of
      // neurons, from the fixture's own tiny token counts) still isn't
      // enough more room for the second call's pre-flight check to pass.
      neuronBudget: SUMMARY_NEURON_ESTIMATE,
      index: 0,
      parentInstanceId: 'parent-own-instance-id',
    };

    const result = await runSummarize(aiEnv, liveStep(), summarizeEvent(payload));

    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]?.url).toBe('https://example.com/a');
  });

  it('a budget of zero summarizes nothing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const payload: SummarizeParams = {
      candidates: [candidate()],
      topic: topic(),
      neuronBudget: 0,
      index: 0,
      parentInstanceId: 'parent-own-instance-id',
    };

    const result = await runSummarize(env, liveStep(), summarizeEvent(payload));

    expect(result).toEqual({ summaries: [], neuronsSpent: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('one bad candidate does not stop the rest from being summarized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === 'https://example.com/dead') return new Response('nope', { status: 404 });
        return new Response('<html><body><p>Article prose about the topic.</p></body></html>', { headers: { 'content-type': 'text/html' } });
      }),
    );
    const aiEnv = envWithAi(
      chatFixture(JSON.stringify({ summary: 'A summary.', relevance: 0.6, claims: [], attributablePractice: null })),
    );

    const payload: SummarizeParams = {
      candidates: [candidate({ url: 'https://example.com/dead' }), candidate({ url: 'https://example.com/live' })],
      topic: topic(),
      neuronBudget: 10_000,
      index: 0,
      parentInstanceId: 'parent-own-instance-id',
    };

    const result = await runSummarize(aiEnv, liveStep(), summarizeEvent(payload));

    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]?.url).toBe('https://example.com/live');
  });
});
