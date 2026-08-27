import type { Draft } from './types';

/**
 * Frontmatter emission and validation for `src/content/blog/<slug>/index.mdx`
 * in the blog repo. See `Draft` in `./types` and
 * `.claude/skills/blog-voice/SKILL.md`'s "Three hard rules for a generated
 * post": always `draft: true`, never an `image` key, kebab-case slug with no
 * spaces.
 *
 * `renderMdx` only emits the fields the blog's schema actually has
 * (`spec.md` -> "Target repo and post format"). The dynamic check against
 * the blog repo's live `src/content.config.ts` is step 5's job
 * (`openPullRequest`) - this module validates the static shape every
 * `Draft` must satisfy regardless of what the schema currently says.
 */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDraftError';
  }
}

/**
 * Throws `InvalidDraftError` naming the failed rule. Called by `renderMdx`
 * so no frontmatter is ever emitted from a `Draft` that would fail it, but
 * exported separately so a caller can validate before doing anything else
 * (e.g. before spending a branch-creation call on a draft that will not
 * pass).
 */
export function validateDraft(draft: Draft): void {
  if (!SLUG_RE.test(draft.slug)) {
    throw new InvalidDraftError(
      `slug '${draft.slug}' is not kebab-case: lowercase letters, digits and single hyphens only, no spaces`,
    );
  }
  if (draft.draft !== true) {
    throw new InvalidDraftError('draft.draft must be true - see blog-voice SKILL.md');
  }
  if (draft.title.trim() === '') {
    throw new InvalidDraftError('title is empty');
  }
  if (draft.description.trim() === '') {
    throw new InvalidDraftError('description is empty');
  }
  if (!DATE_RE.test(draft.date)) {
    throw new InvalidDraftError(`date '${draft.date}' is not yyyy-mm-dd`);
  }
  if ('image' in draft) {
    throw new InvalidDraftError('draft carries an image key - the Astro image() helper needs a real committed file');
  }
}

function yamlStringArray(items: string[]): string {
  return `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
}

/**
 * Renders the full file content - frontmatter plus body - for
 * `src/content/blog/<slug>/index.mdx`. Never emits an `image` key: the
 * schema's `image()` helper resolves to a real committed file, and emitting
 * a path without committing it breaks the site build.
 */
export function renderMdx(draft: Draft): string {
  validateDraft(draft);
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(draft.title)}`,
    `description: ${JSON.stringify(draft.description)}`,
    `date: ${JSON.stringify(draft.date)}`,
    `authors: ${yamlStringArray(draft.authors)}`,
    `tags: ${yamlStringArray(draft.tags)}`,
    'draft: true',
    '---',
    '',
  ].join('\n');
  return `${frontmatter}${draft.body}`;
}

/** Where `renderMdx`'s output belongs in the blog repo. */
export function blogPostPath(slug: string): string {
  return `src/content/blog/${slug}/index.mdx`;
}

// ---------------------------------------------------------------------------
// Dynamic validation against the blog's real src/content.config.ts.
//
// `renderMdx`/`validateDraft` above check the *static* shape every `Draft`
// must satisfy regardless of what the schema currently says. This section
// checks the shape actually declared in the live file (openPullRequest reads
// it via `readRepoFile`, per spec.md: "the PR step reads it ... rather than
// trusting the copy above, so a schema change upstream surfaces as a failed
// step instead of a broken build").
// ---------------------------------------------------------------------------

export class ContentConfigMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentConfigMismatchError';
  }
}

/** Finds the index just past the `)` matching the `(` at `openParenIndex`, ignoring quoted strings. */
function matchingParenEnd(text: string, openParenIndex: number): number | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParenIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') i++; // skip an escaped char inside the string
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/**
 * Extracts `{ name, required }` for each top-level field of the `blog`
 * collection's zod schema in a `content.config.ts` source. A light regex
 * scan, not a TS/zod parser - proportionate to the one thing this exists to
 * catch: a field that became required and that `renderMdx` does not emit,
 * or `image` no longer being optional. Throws if the `blog` collection or
 * its `z.object(` call cannot be found at all, rather than silently
 * validating nothing.
 */
export function parseBlogSchemaFields(contentConfigSource: string): Array<{ name: string; required: boolean }> {
  const blogStart = /const\s+blog\s*=\s*defineCollection\(/.exec(contentConfigSource);
  if (blogStart === null) {
    throw new ContentConfigMismatchError('parseBlogSchemaFields: no `const blog = defineCollection(` found');
  }
  const openParen = blogStart.index + (blogStart[0] ?? '').length - 1;
  const blockEnd = matchingParenEnd(contentConfigSource, openParen);
  if (blockEnd === null) {
    throw new ContentConfigMismatchError('parseBlogSchemaFields: unbalanced parens in `blog` collection block');
  }
  const block = contentConfigSource.slice(openParen, blockEnd);

  const objectStart = /z\.object\(/.exec(block);
  if (objectStart === null) {
    throw new ContentConfigMismatchError('parseBlogSchemaFields: no `z.object(` found in the `blog` collection');
  }
  const objectOpenParen = objectStart.index + (objectStart[0] ?? '').length - 1;
  const objectEnd = matchingParenEnd(block, objectOpenParen);
  if (objectEnd === null) {
    throw new ContentConfigMismatchError('parseBlogSchemaFields: unbalanced parens in `z.object(...)`');
  }
  const schemaBlock = block.slice(objectOpenParen, objectEnd);

  const fields: Array<{ name: string; required: boolean }> = [];
  const fieldRe = /^\s*(\w+):\s*(.+?),?\s*$/gm;
  for (const m of schemaBlock.matchAll(fieldRe)) {
    const name = m[1];
    const valueExpr = m[2];
    if (name === undefined || valueExpr === undefined) continue;
    fields.push({ name, required: !valueExpr.includes('.optional()') });
  }
  return fields;
}

/** Field names `renderMdx` actually emits (see the frontmatter list above) - never `image`, never `order`. */
const EMITTED_FIELDS = new Set(['title', 'description', 'date', 'authors', 'tags', 'draft']);

/**
 * Validates `draft`'s shape against the live schema fields (see
 * `parseBlogSchemaFields`). Two failure modes, both meaning the same thing -
 * the schema changed upstream in a way this pipeline's fixed frontmatter
 * shape no longer satisfies:
 *
 *  1. A field is now required that `renderMdx` never emits.
 *  2. `image` is now required - `renderMdx` deliberately omits it always
 *     (the Astro `image()` helper needs a real committed file).
 */
export function validateAgainstContentConfig(contentConfigSource: string): void {
  const fields = parseBlogSchemaFields(contentConfigSource);
  for (const field of fields) {
    if (!field.required) continue;
    if (field.name === 'image') {
      throw new ContentConfigMismatchError(
        "content.config.ts now requires 'image' - renderMdx deliberately omits it (blog-voice SKILL.md)",
      );
    }
    if (!EMITTED_FIELDS.has(field.name)) {
      throw new ContentConfigMismatchError(
        `content.config.ts requires '${field.name}', which renderMdx never emits - the schema has changed upstream`,
      );
    }
  }
}
