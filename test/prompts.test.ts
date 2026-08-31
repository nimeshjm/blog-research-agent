import { describe, expect, it } from 'vitest';
import { buildMapMessages, buildReduceMessages, normaliseCitations, parseMapResponse, parseReduceResponse } from '../src/lib/prompts';
import type { ArticleSummary, Candidate, Topic } from '../src/lib/types';

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

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    url: 'https://example.com/x',
    title: 'A study of agentic code review',
    publishedAt: '2026-08-27T00:00:00Z',
    publishedMs: null,
    sourceName: 'Test Source',
    ...overrides,
  };
}

function summary(overrides: Partial<ArticleSummary> = {}): ArticleSummary {
  return {
    url: 'https://example.com/x',
    title: 'A study of agentic code review',
    summary: 'Found that agentic review catches more bugs than manual review alone.',
    relevance: 0.9,
    claims: ['claim one', 'claim two'],
    attributablePractice: 'Agentic code review',
    ...overrides,
  };
}

describe('buildMapMessages()', () => {
  it('carries the topic, candidate title, and article text into the user message', () => {
    const messages = buildMapMessages(topic(), candidate(), 'The article body text.');
    const user = messages.find((m) => m.role === 'user');
    expect(user?.content).toContain('Agentic code review practices');
    expect(user?.content).toContain('What actually catches bugs');
    expect(user?.content).toContain('A study of agentic code review');
    expect(user?.content).toContain('The article body text.');
  });

  it('omits the angle line when the topic has none', () => {
    const messages = buildMapMessages(topic({ angle: null }), candidate(), 'text');
    const user = messages.find((m) => m.role === 'user');
    expect(user?.content).not.toContain('()');
  });

  it('asks for a JSON object with the ArticleSummary fields, no other text', () => {
    const messages = buildMapMessages(topic(), candidate(), 'text');
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('summary');
    expect(system?.content).toContain('relevance');
    expect(system?.content).toContain('claims');
    expect(system?.content).toContain('attributablePractice');
  });
});

/** A minimal well-formed map response body, so each failure test can break exactly one field. */
function validMapBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { summary: 's', relevance: 0.5, claims: ['a'], attributablePractice: null, ...overrides };
}

describe('parseMapResponse()', () => {
  it('parses a well-formed response', () => {
    const text = JSON.stringify({
      summary: 'A summary.',
      relevance: 0.8,
      claims: ['a', 'b'],
      attributablePractice: 'Some practice',
    });
    expect(parseMapResponse(text)).toEqual({
      ok: true,
      value: {
        summary: 'A summary.',
        relevance: 0.8,
        claims: ['a', 'b'],
        attributablePractice: 'Some practice',
      },
    });
  });

  it('accepts attributablePractice: null (commentary, not a sourced practice)', () => {
    const text = JSON.stringify(validMapBody());
    const result = parseMapResponse(text);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.attributablePractice).toBeNull();
  });

  it('strips a ```json fenced wrapper', () => {
    const text = '```json\n' + JSON.stringify(validMapBody()) + '\n```';
    expect(parseMapResponse(text).ok).toBe(true);
  });

  it('reports invalid-json for prose that is not JSON at all (the reasoning-fallback case from #18)', () => {
    const result = parseMapResponse('The user asks about the article, so I should summarize it...');
    expect(result).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('reports not-an-object for valid JSON that is not a plain object', () => {
    expect(parseMapResponse('[]')).toEqual({ ok: false, reason: 'not-an-object' });
    expect(parseMapResponse('null')).toEqual({ ok: false, reason: 'not-an-object' });
    expect(parseMapResponse('"a string"')).toEqual({ ok: false, reason: 'not-an-object' });
  });

  it('reports summary-invalid when summary has the wrong type', () => {
    const text = JSON.stringify(validMapBody({ summary: 42 }));
    expect(parseMapResponse(text)).toEqual({ ok: false, reason: 'summary-invalid', keys: ['summary', 'relevance', 'claims', 'attributablePractice'] });
  });

  it('reports relevance-invalid when relevance has the wrong type', () => {
    const text = JSON.stringify(validMapBody({ relevance: 'high' }));
    const result = parseMapResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('relevance-invalid');
  });

  it('reports claims-invalid when claims is not an array of strings', () => {
    const text = JSON.stringify(validMapBody({ claims: [1, 2] }));
    const result = parseMapResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('claims-invalid');
  });

  it('reports claims-invalid when claims is not an array at all', () => {
    const text = JSON.stringify(validMapBody({ claims: 'not an array' }));
    const result = parseMapResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('claims-invalid');
  });

  it('reports attributablePractice-invalid when it is neither null nor a string', () => {
    const text = JSON.stringify(validMapBody({ attributablePractice: 7 }));
    const result = parseMapResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('attributablePractice-invalid');
  });

  it('carries the top-level key names on a field-validation failure', () => {
    const text = JSON.stringify({ summary: 1, relevance: 0.5, claims: [], attributablePractice: null, extra: 'x' });
    const result = parseMapResponse(text);
    expect(result).toEqual({
      ok: false,
      reason: 'summary-invalid',
      keys: ['summary', 'relevance', 'claims', 'attributablePractice', 'extra'],
    });
  });
});

describe('buildReduceMessages()', () => {
  it('includes every source URL and title so the model can cite them', () => {
    const summaries = [summary({ url: 'https://a.example/1', title: 'Article A' }), summary({ url: 'https://b.example/2', title: 'Article B' })];
    const messages = buildReduceMessages(topic(), summaries);
    const user = messages.find((m) => m.role === 'user');
    expect(user?.content).toContain('https://a.example/1');
    expect(user?.content).toContain('https://b.example/2');
    expect(user?.content).toContain('Article A');
    expect(user?.content).toContain('Article B');
  });

  it('instructs the model to mark the opening-incident slot instead of inventing one', () => {
    const messages = buildReduceMessages(topic(), [summary()]);
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('<!-- OPENING INCIDENT: needs a real example -->');
    expect(system?.content).toMatch(/never invent/i);
  });

  it('asks for exactly title/description/tags/body - never slug, date, authors, or draft', () => {
    const messages = buildReduceMessages(topic(), [summary()]);
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('"title"');
    expect(system?.content).toContain('"description"');
    expect(system?.content).toContain('"tags"');
    expect(system?.content).toContain('"body"');
    expect(system?.content).not.toContain('"slug"');
    expect(system?.content).not.toContain('"date"');
  });
});

/** A minimal well-formed reduce response body, so each failure test can break exactly one field. */
function validReduceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: 't', description: 'd', tags: ['a'], body: 'b', ...overrides };
}

describe('parseReduceResponse()', () => {
  it('parses a well-formed response', () => {
    const text = JSON.stringify({
      title: 'A title',
      description: 'A hook.',
      tags: ['ai', 'engineering-leadership'],
      body: '## A heading\n\nSome prose.',
    });
    expect(parseReduceResponse(text)).toEqual({
      ok: true,
      value: {
        title: 'A title',
        description: 'A hook.',
        tags: ['ai', 'engineering-leadership'],
        body: '## A heading\n\nSome prose.',
      },
    });
  });

  it('reports invalid-json for text that is not JSON at all', () => {
    expect(parseReduceResponse('not json at all')).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('reports not-an-object for valid JSON that is not a plain object', () => {
    expect(parseReduceResponse('[]')).toEqual({ ok: false, reason: 'not-an-object' });
    expect(parseReduceResponse('null')).toEqual({ ok: false, reason: 'not-an-object' });
  });

  it('reports title-invalid when title is missing', () => {
    const text = JSON.stringify({ description: 'd', tags: [], body: 'b' });
    const result = parseReduceResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('title-invalid');
  });

  it('reports title-invalid when title is empty after trim', () => {
    const text = JSON.stringify(validReduceBody({ title: '   ' }));
    const result = parseReduceResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('title-invalid');
  });

  it('reports description-invalid when description is missing', () => {
    const text = JSON.stringify(validReduceBody({ description: undefined }));
    const result = parseReduceResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('description-invalid');
  });

  it('reports description-invalid when description is empty after trim', () => {
    const text = JSON.stringify(validReduceBody({ description: '  ' }));
    const result = parseReduceResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('description-invalid');
  });

  it('reports tags-invalid when tags is not an array', () => {
    const text = JSON.stringify(validReduceBody({ tags: 'not-an-array' }));
    const result = parseReduceResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('tags-invalid');
  });

  it('reports tags-invalid when tags is an array of non-strings', () => {
    const text = JSON.stringify(validReduceBody({ tags: [1, 2] }));
    const result = parseReduceResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('tags-invalid');
  });

  it('reports body-invalid when body is missing', () => {
    const text = JSON.stringify({ title: 't', description: 'd', tags: [] });
    const result = parseReduceResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('body-invalid');
  });

  it('reports body-invalid when body is empty after trim', () => {
    const text = JSON.stringify(validReduceBody({ body: '   ' }));
    const result = parseReduceResponse(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('body-invalid');
  });

  it('carries the top-level key names on a field-validation failure', () => {
    const text = JSON.stringify({ title: '', description: 'd', tags: [], body: 'b', extra: 'x' });
    expect(parseReduceResponse(text)).toEqual({
      ok: false,
      reason: 'title-invalid',
      keys: ['title', 'description', 'tags', 'body', 'extra'],
    });
  });

  // Regression coverage for #75 / production run 972cea0c: the model's completion
  // was unfenced, valid JSON, but its `body` field contained a fenced ```bash
  // example. `stripCodeFence` used to run unconditionally before the first parse
  // attempt and matched that inner fence instead of the response as a whole,
  // turning a well-formed completion into "not valid JSON".

  it('parses a well-formed, unfenced response whose body contains an inner fenced code block (the #75 production regression)', () => {
    const body = '## Try it\n\n```bash\ngit worktree add /tmp/agent-run main\n```\n\nMore prose after the fence.';
    const text = JSON.stringify({ title: 't', description: 'd', tags: ['ai'], body });
    expect(parseReduceResponse(text)).toEqual({
      ok: true,
      value: { title: 't', description: 'd', tags: ['ai'], body },
    });
  });

  it('still parses when the model wraps the whole response in a ```json fence', () => {
    const text = '```json\n' + JSON.stringify(validReduceBody()) + '\n```';
    expect(parseReduceResponse(text)).toEqual({ ok: true, value: { title: 't', description: 'd', tags: ['a'], body: 'b' } });
  });

  it('parses when the whole response is fenced AND the body also contains its own inner fenced block', () => {
    const body = 'Run:\n\n```bash\nnpm install\n```\n';
    const inner = JSON.stringify({ title: 't', description: 'd', tags: [], body });
    const text = '```json\n' + inner + '\n```';
    expect(parseReduceResponse(text)).toEqual({
      ok: true,
      value: { title: 't', description: 'd', tags: [], body },
    });
  });
});

// Regression coverage for #75 / production run 972cea0c: the model cited every
// source as `【<bare url>】` (CJK lenticular brackets) instead of the markdown
// link REDUCE_SYSTEM_PROMPT asks for.
describe('normaliseCitations()', () => {
  it('rewrites 【url】 into a markdown link using the matching summary\'s title', () => {
    const summaries = [summary({ url: 'https://arxiv.org/abs/2608.28497', title: 'A study of agentic code review' })];
    const body = 'Agentic review catches more bugs 【https://arxiv.org/abs/2608.28497】.';
    expect(normaliseCitations(body, summaries)).toBe(
      'Agentic review catches more bugs [A study of agentic code review](https://arxiv.org/abs/2608.28497).',
    );
  });

  it('falls back to the URL itself as link text when no summary matches', () => {
    const body = 'See the report 【https://example.com/unmatched】.';
    expect(normaliseCitations(body, [])).toBe('See the report [https://example.com/unmatched](https://example.com/unmatched).');
  });

  it('leaves an already-correct markdown link unchanged, byte for byte', () => {
    const body = 'Already cited properly: [A study of agentic code review](https://example.com/x).';
    expect(normaliseCitations(body, [summary()])).toBe(body);
  });

  it('leaves 【 】 wrapping something that is not a URL unchanged', () => {
    const body = 'A term glossed in brackets: 【not a url, just an aside】.';
    expect(normaliseCitations(body, [])).toBe(body);
  });

  // Documents a deliberate scope boundary rather than a gap: normaliseCitations
  // matches only the exact observed shape (a bracket pair whose contents are a
  // bare URL) wherever it appears, including inside a fenced code block. Making
  // it fence-aware would be exactly the kind of guessing/extra-repair logic the
  // brief ruled out ("do not try to repair other malformed citation shapes");
  // the model is not expected to emit 【 】 inside example code in the first
  // place, so this stays unguarded rather than adding untested fence-detection.
  it('also rewrites 【url】 found inside a fenced code block - fence-blind by design, not by oversight', () => {
    const body = '```text\nSource: 【https://example.com/x】\n```';
    expect(normaliseCitations(body, [])).toBe('```text\nSource: [https://example.com/x](https://example.com/x)\n```');
  });

  it('rewrites multiple citations in one body, including two in the same paragraph', () => {
    const summaries = [
      summary({ url: 'https://a.example/1', title: 'Article A' }),
      summary({ url: 'https://b.example/2', title: 'Article B' }),
    ];
    const body =
      'Two claims in one paragraph: the first 【https://a.example/1】 and the second 【https://b.example/2】 both matter.\n\n' +
      'A third, unmatched one 【https://c.example/3】 stands alone.';
    expect(normaliseCitations(body, summaries)).toBe(
      'Two claims in one paragraph: the first [Article A](https://a.example/1) and the second [Article B](https://b.example/2) both matter.\n\n' +
        'A third, unmatched one [https://c.example/3](https://c.example/3) stands alone.',
    );
  });
});
