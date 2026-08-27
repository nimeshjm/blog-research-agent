import { describe, expect, it } from 'vitest';
import { blogPostPath, InvalidDraftError, renderMdx, validateDraft } from '../src/lib/mdx';
import type { Draft } from '../src/lib/types';

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    slug: 'agentic-code-review-practices',
    title: 'What agentic code review actually catches',
    description: 'A tension worth stating up front.',
    date: '2026-08-27',
    authors: ['nimeshjm'],
    tags: ['ai', 'engineering-leadership'],
    draft: true,
    brief: 'Research brief body.',
    body: '\nSome MDX body.\n',
    sources: ['https://example.com/paper'],
    ...overrides,
  };
}

describe('renderMdx()', () => {
  it('carries draft: true and never emits an image key', () => {
    const out = renderMdx(draft());
    expect(out).toMatch(/^draft: true$/m);
    expect(out).not.toMatch(/^image:/m);
  });

  it('emits exactly the schema fields, in valid frontmatter form', () => {
    const out = renderMdx(draft());
    const frontmatter = out.slice(0, out.indexOf('---', 4));
    expect(frontmatter).toMatch(/title: /);
    expect(frontmatter).toMatch(/description: /);
    expect(frontmatter).toMatch(/date: "2026-08-27"/);
    expect(frontmatter).toMatch(/authors: \["nimeshjm"\]/);
    expect(frontmatter).toMatch(/tags: \["ai", "engineering-leadership"\]/);
  });

  it('appends the body after the closing frontmatter fence', () => {
    const out = renderMdx(draft({ body: '\nHello body.\n' }));
    expect(out.endsWith('\nHello body.\n')).toBe(true);
  });
});

describe('validateDraft()', () => {
  it('rejects a slug with spaces', () => {
    expect(() => validateDraft(draft({ slug: 'ai-developing agents' }))).toThrow(InvalidDraftError);
  });

  it('rejects a slug with uppercase', () => {
    expect(() => validateDraft(draft({ slug: 'Agentic-Review' }))).toThrow(InvalidDraftError);
  });

  it('rejects an empty title', () => {
    expect(() => validateDraft(draft({ title: '  ' }))).toThrow(InvalidDraftError);
  });

  it('rejects a non-yyyy-mm-dd date', () => {
    expect(() => validateDraft(draft({ date: '08/27/2026' }))).toThrow(InvalidDraftError);
  });

  it('accepts a well-formed draft', () => {
    expect(() => validateDraft(draft())).not.toThrow();
  });
});

describe('blogPostPath()', () => {
  it('places the file at src/content/blog/<slug>/index.mdx', () => {
    expect(blogPostPath('agentic-code-review-practices')).toBe(
      'src/content/blog/agentic-code-review-practices/index.mdx',
    );
  });
});
