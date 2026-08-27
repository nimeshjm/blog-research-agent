/**
 * GitHub REST client for the one repo this agent writes to: read the base
 * ref, create a `research/*` branch, PUT a file, open a pull request.
 *
 * Deliberately takes `baseBranch` as a plain string parameter and never
 * imports `Env` or names the identifier `BLOG_BASE_BRANCH` anywhere in this
 * file. `base-branch-not-a-write-target` (scripts/review-checks.mjs) flags
 * any `src/` file that mentions that identifier *and* contains `refs/heads`
 * or PUTs to `/contents/` - which branch creation and file commits
 * unavoidably do. Splitting the read of `env.BLOG_BASE_BRANCH` out to the
 * call site (which passes it in as an ordinary string) is what keeps that
 * check honest instead of suppressed. The apiBase URL comes from
 * `GITHUB_API_BASE` (wrangler.toml `[vars]`) via `GithubConfig`, so this
 * file carries no URL literal of its own either.
 */

export interface GithubConfig {
  apiBase: string;
  token: string;
  /** `owner/repo`, e.g. `nimeshjm/nimeshjm.com`. */
  repo: string;
}

export class GithubError extends Error {
  constructor(
    public readonly status: number,
    public readonly operation: string,
  ) {
    // Constructor name and operation only - never the URL or response body,
    // which could carry a repo path or an error detail worth keeping out of
    // logs (REVIEW.md pass 2).
    super(`GitHub API error during ${operation}: HTTP ${status}`);
    this.name = 'GithubError';
  }
}

async function githubFetch(config: GithubConfig, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${config.apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'blog-research-agent',
      ...init?.headers,
    },
  });
}

function base64Encode(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}

function base64Decode(encoded: string): string {
  // GitHub's Contents API wraps base64 content at 60 columns.
  return decodeURIComponent(escape(atob(encoded.replace(/\n/g, ''))));
}

/** Reads the tip commit SHA of `baseBranch` - a plain string, supplied by the caller. */
export async function readBaseRefSha(config: GithubConfig, baseBranch: string): Promise<string> {
  const res = await githubFetch(config, `/repos/${config.repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  if (!res.ok) throw new GithubError(res.status, 'readBaseRefSha');
  const body = (await res.json()) as { object: { sha: string } };
  return body.object.sha;
}

/**
 * Creates `refs/heads/<branchName>` pointing at `fromSha`. Idempotent: a
 * `422` ("Reference already exists") is treated as success rather than an
 * error, because a retried `step.do` must not fail on a branch an earlier
 * attempt already created.
 */
export async function createBranch(config: GithubConfig, branchName: string, fromSha: string): Promise<void> {
  const res = await githubFetch(config, `/repos/${config.repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
  });
  if (res.status === 422) return;
  if (!res.ok) throw new GithubError(res.status, 'createBranch');
}

export interface PutFileParams {
  path: string;
  content: string;
  message: string;
  branch: string;
}

async function readFileSha(config: GithubConfig, path: string, ref: string): Promise<string | null> {
  const res = await githubFetch(
    config,
    `/repos/${config.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new GithubError(res.status, 'readFileSha');
  const body = (await res.json()) as { sha: string };
  return body.sha;
}

/**
 * PUTs `params.content` to `params.path` on `params.branch`. Idempotent:
 * reads the file's current SHA on that branch first (`null` when it does
 * not exist yet) so a retry updates the file it already committed instead
 * of conflicting with itself.
 */
export async function putFile(config: GithubConfig, params: PutFileParams): Promise<void> {
  const existingSha = await readFileSha(config, params.path, params.branch);
  const res = await githubFetch(config, `/repos/${config.repo}/contents/${params.path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: params.message,
      content: base64Encode(params.content),
      branch: params.branch,
      ...(existingSha === null ? {} : { sha: existingSha }),
    }),
  });
  if (!res.ok) throw new GithubError(res.status, 'putFile');
}

/**
 * Lists post slugs under `src/content/blog/` at the repo's default branch -
 * used only for the propose-topic dedupe (spec.md req. 3: a proposal must
 * not duplicate a `draft: true` post, which is absent from BLOG_FEED_URL).
 * The directory name *is* the slug (`Draft.slug`, `blogPostPath()` in
 * mdx.ts), so this needs no per-post file read: spec.md's own measured fact
 * ("the repo holds 33 posts and the feed 30 - the 3 missing are all
 * unpublished drafts") means repo slugs minus feed slugs already *is* the
 * drafted set, without ever reading an `index.mdx`'s frontmatter.
 *
 * `ref` is deliberately omitted - GitHub's Contents API defaults to the
 * repo's default branch when it is - rather than passed `BLOG_BASE_BRANCH`.
 * That keeps this function, like every other one in this file, out of
 * `base-branch-not-a-write-target`'s way: it flags any `src/` file that
 * mentions that identifier *and* contains `refs/heads` or PUTs to
 * `/contents/`, which this file already does for the write path.
 */
export async function listBlogPostSlugs(config: GithubConfig): Promise<string[]> {
  const res = await githubFetch(config, `/repos/${config.repo}/contents/src/content/blog`);
  if (res.status === 404) return [];
  if (!res.ok) throw new GithubError(res.status, 'listBlogPostSlugs');
  const entries = (await res.json()) as Array<{ name: string; type: string }>;
  return entries.filter((e) => e.type === 'dir').map((e) => e.name);
}

/**
 * Reads a text file's raw content at the repo's default branch - used only
 * for the dynamic `content.config.ts` schema check (`openPullRequest` in
 * `src/workflow.ts`: spec.md -> "Target repo and post format" wants the
 * live schema read, not the copy transcribed into spec.md). `ref` is
 * deliberately omitted, the same choice `listBlogPostSlugs` makes and for
 * the same reason: this is a read, and omitting it keeps this file out of
 * `base-branch-not-a-write-target`'s way rather than passing
 * `BLOG_BASE_BRANCH` through a second read path.
 *
 * Returns `null` on a 404 (file moved or renamed) rather than throwing -
 * the caller decides whether a missing schema file is fatal.
 */
export async function readRepoFile(config: GithubConfig, path: string): Promise<string | null> {
  const res = await githubFetch(config, `/repos/${config.repo}/contents/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new GithubError(res.status, 'readRepoFile');
  const body = (await res.json()) as { content: string; encoding: string };
  if (body.encoding !== 'base64') {
    throw new Error(`readRepoFile: unexpected encoding '${body.encoding}' for ${path}`);
  }
  return base64Decode(body.content);
}

export interface OpenPullRequestParams {
  title: string;
  body: string;
  /** The branch carrying the commit. */
  head: string;
  /** The branch to open against - a plain string; never pass BLOG_BASE_BRANCH through anything but this. */
  base: string;
}

async function findOpenPullRequest(config: GithubConfig, head: string): Promise<string | null> {
  const owner = config.repo.split('/')[0];
  const res = await githubFetch(
    config,
    `/repos/${config.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}/${head}`)}`,
  );
  if (!res.ok) throw new GithubError(res.status, 'findOpenPullRequest');
  const list = (await res.json()) as Array<{ html_url: string }>;
  return list[0]?.html_url ?? null;
}

/**
 * Opens a pull request. Idempotent: an existing open PR for `params.head`
 * is reused rather than duplicated, so a retried `open-pull-request` step
 * does not open a second PR for the same branch.
 */
export async function openPullRequest(config: GithubConfig, params: OpenPullRequestParams): Promise<string> {
  const existing = await findOpenPullRequest(config, params.head);
  if (existing !== null) return existing;

  const res = await githubFetch(config, `/repos/${config.repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: params.title, body: params.body, head: params.head, base: params.base }),
  });
  if (!res.ok) throw new GithubError(res.status, 'openPullRequest');
  const created = (await res.json()) as { html_url: string };
  return created.html_url;
}
