import { describe, expect, it } from 'vitest';
import { buildMapMessages, buildReduceMessages, parseMapResponse, parseReduceResponse } from '../src/lib/prompts';
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

describe('parseMapResponse()', () => {
  it('parses a well-formed response', () => {
    const text = JSON.stringify({
      summary: 'A summary.',
      relevance: 0.8,
      claims: ['a', 'b'],
      attributablePractice: 'Some practice',
    });
    expect(parseMapResponse(text)).toEqual({
      summary: 'A summary.',
      relevance: 0.8,
      claims: ['a', 'b'],
      attributablePractice: 'Some practice',
    });
  });

  it('accepts attributablePractice: null (commentary, not a sourced practice)', () => {
    const text = JSON.stringify({ summary: 's', relevance: 0.1, claims: [], attributablePractice: null });
    expect(parseMapResponse(text)?.attributablePractice).toBeNull();
  });

  it('strips a ```json fenced wrapper', () => {
    const text = '```json\n' + JSON.stringify({ summary: 's', relevance: 0.5, claims: [], attributablePractice: null }) + '\n```';
    expect(parseMapResponse(text)).not.toBeNull();
  });

  it('returns null for prose that is not JSON (the reasoning-fallback case from #18)', () => {
    expect(parseMapResponse('The user asks about the article, so I should summarize it...')).toBeNull();
  });

  it('returns null when a required field has the wrong type', () => {
    const text = JSON.stringify({ summary: 's', relevance: 'high', claims: [], attributablePractice: null });
    expect(parseMapResponse(text)).toBeNull();
  });

  it('returns null when claims is not an array of strings', () => {
    const text = JSON.stringify({ summary: 's', relevance: 0.5, claims: [1, 2], attributablePractice: null });
    expect(parseMapResponse(text)).toBeNull();
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

describe('parseReduceResponse()', () => {
  it('parses a well-formed response', () => {
    const text = JSON.stringify({
      title: 'A title',
      description: 'A hook.',
      tags: ['ai', 'engineering-leadership'],
      body: '## A heading\n\nSome prose.',
    });
    expect(parseReduceResponse(text)).toEqual({
      title: 'A title',
      description: 'A hook.',
      tags: ['ai', 'engineering-leadership'],
      body: '## A heading\n\nSome prose.',
    });
  });

  it('returns null when the body is missing', () => {
    const text = JSON.stringify({ title: 't', description: 'd', tags: [] });
    expect(parseReduceResponse(text)).toBeNull();
  });

  it('returns null when the title is empty', () => {
    const text = JSON.stringify({ title: '  ', description: 'd', tags: [], body: 'b' });
    expect(parseReduceResponse(text)).toBeNull();
  });

  it('returns null for unparseable text', () => {
    expect(parseReduceResponse('not json at all')).toBeNull();
  });
});
