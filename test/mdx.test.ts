import { describe, expect, it } from 'vitest';
import {
  blogPostPath,
  ContentConfigMismatchError,
  InvalidDraftError,
  parseBlogSchemaFields,
  renderMdx,
  validateAgainstContentConfig,
  validateDraft,
} from '../src/lib/mdx';
import type { Draft } from '../src/lib/types';

/**
 * A trimmed copy of the real `src/content.config.ts` fetched from
 * nimeshjm/nimeshjm.com while writing this PR (see the PR body for the
 * fetch). Carries a second `defineCollection` after `blog` on purpose, to
 * prove the paren-matching in `parseBlogSchemaFields` stops at `blog`'s own
 * closing paren rather than reading into `authors`'s fields.
 */
const REAL_CONTENT_CONFIG = `import { glob } from 'astro/loaders'
import { defineCollection, z } from 'astro:content'

const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      date: z.coerce.date(),
      order: z.number().optional(),
      image: image().optional(),
      tags: z.array(z.string()).optional(),
      authors: z.array(z.string()).optional(),
      draft: z.boolean().optional(),
    }),
})

const authors = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/authors' }),
  schema: z.object({
    name: z.string(),
    bio: z.string().optional(),
  }),
})

export const collections = { blog, authors }
`;

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

describe('parseBlogSchemaFields()', () => {
  it('extracts required vs optional fields from the real blog collection schema, not authors', () => {
    const fields = parseBlogSchemaFields(REAL_CONTENT_CONFIG);
    const byName = new Map(fields.map((f) => [f.name, f.required]));

    expect(byName.get('title')).toBe(true);
    expect(byName.get('description')).toBe(true);
    expect(byName.get('date')).toBe(true);
    expect(byName.get('order')).toBe(false);
    expect(byName.get('image')).toBe(false);
    expect(byName.get('tags')).toBe(false);
    expect(byName.get('authors')).toBe(false);
    expect(byName.get('draft')).toBe(false);
    // authors collection's `name`/`bio` must not leak in - proves the
    // paren-matcher stopped at blog's own closing paren.
    expect(byName.has('name')).toBe(false);
    expect(byName.has('bio')).toBe(false);
  });

  it('throws when no `blog` collection is found', () => {
    expect(() => parseBlogSchemaFields('export const collections = {}')).toThrow(ContentConfigMismatchError);
  });
});

describe('validateAgainstContentConfig()', () => {
  it('accepts the real, current schema (title/description/date required, everything renderMdx emits covers it)', () => {
    expect(() => validateAgainstContentConfig(REAL_CONTENT_CONFIG)).not.toThrow();
  });

  it('throws when `image` becomes required upstream - renderMdx deliberately never emits it', () => {
    const mutated = REAL_CONTENT_CONFIG.replace('image: image().optional(),', 'image: image(),');
    expect(() => validateAgainstContentConfig(mutated)).toThrow(ContentConfigMismatchError);
    expect(() => validateAgainstContentConfig(mutated)).toThrow(/image/);
  });

  it('throws when a new required field appears that renderMdx does not emit', () => {
    const mutated = REAL_CONTENT_CONFIG.replace(
      'title: z.string(),',
      'title: z.string(),\n      subtitle: z.string(),',
    );
    expect(() => validateAgainstContentConfig(mutated)).toThrow(ContentConfigMismatchError);
    expect(() => validateAgainstContentConfig(mutated)).toThrow(/subtitle/);
  });

  it('does not throw when a currently-optional field becomes required if renderMdx already emits it', () => {
    // authors is optional today but renderMdx always emits it - tightening
    // it to required upstream is not a break for this pipeline.
    const mutated = REAL_CONTENT_CONFIG.replace(
      'authors: z.array(z.string()).optional(),',
      'authors: z.array(z.string()),',
    );
    expect(() => validateAgainstContentConfig(mutated)).not.toThrow();
  });
});
