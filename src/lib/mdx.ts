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
