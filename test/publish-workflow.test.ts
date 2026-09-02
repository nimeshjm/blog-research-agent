import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidDraftError } from '../src/lib/mdx';
import type { Draft, Env, PublishParams } from '../src/lib/types';
import { openPullRequest, runPublish } from '../src/publish-workflow';

/**
 * `openPullRequest`'s own behaviour - moved here unchanged from
 * test/workflow.test.ts (feature 003, extended 2026-09-01 (#75), mirroring how
 * `gatherCandidates`' and `summarizeArticle`'s tests moved with them in the two
 * earlier PRs - "Reuse" in plan.md). Nothing about validating a draft,
 * committing it and opening a pull request changed when it moved from the
 * parent's own step into a child instance's. What is new here is `runPublish`,
 * the child's own body, and the branch-already-exists cases.
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Trimmed copy of the real src/content.config.ts - see test/mdx.test.ts's copy for provenance. */
const REAL_CONTENT_CONFIG = `const blog = defineCollection({
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
})`;

/**
 * A stateful fake of the whole GitHub surface `openPullRequest` touches -
 * `test/github.test.ts` already proves each primitive (`createBranch`,
 * `putFile`, `openPullRequest`) in isolation; this proves the *composition*
 * stays idempotent end to end, per plan.md's step-5 verification row:
 * "openPullRequest run twice against a fixture produces one PR."
 *
 * `refPathState` decides what a ref GET answers, which is the whole point of
 * the 2026-09-01 change: `createBranch` no longer believes a 422, it looks. A
 * fake that answered every ref GET with a sha would make the narrowed 422
 * indistinguishable from the blanket one it replaced.
 */
function fakeGithub(schemaSource: string, options: { branchPostStatus?: number } = {}) {
  const repo = env.BLOG_REPO;
  const branches = new Set<string>();
  const files = new Map<string, { content: string; sha: string }>();
  let openPrUrl: string | null = null;
  let openPrHead: string | null = null;
  let prPostCount = 0;
  let branchPostCount = 0;
  let fileShaCounter = 0;
  const putBranches: string[] = [];
  const refGets: string[] = [];

  const refPrefix = `/repos/${repo}/git/ref/heads/`;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const contentsPrefix = `/repos/${repo}/contents/`;

    if (path === `${contentsPrefix}src/content.config.ts` && method === 'GET') {
      return jsonResponse(200, { content: btoa(schemaSource), encoding: 'base64' });
    }
    if (path.startsWith(refPrefix) && method === 'GET') {
      const ref = path.slice(refPrefix.length);
      refGets.push(ref);
      if (ref === env.BLOG_BASE_BRANCH) return jsonResponse(200, { object: { sha: 'base-sha' } });
      if (branches.has(ref)) return jsonResponse(200, { object: { sha: `sha-of-${ref}` } });
      return new Response('not found', { status: 404 });
    }
    if (path === `/repos/${repo}/git/refs` && method === 'POST') {
      branchPostCount++;
      const body = JSON.parse(String(init?.body)) as { ref: string };
      const branch = body.ref.replace('refs/heads/', '');
      // A caller-chosen 422 stands in for the *other* things GitHub answers
      // 422 to here - `Reference update failed`, `Object does not exist` -
      // where the ref genuinely is not created.
      if (options.branchPostStatus !== undefined) return new Response('nope', { status: options.branchPostStatus });
      if (branches.has(branch)) return new Response('already exists', { status: 422 });
      branches.add(branch);
      return jsonResponse(201, {});
    }
    if (path.startsWith(contentsPrefix) && path !== `${contentsPrefix}src/content.config.ts` && method === 'GET') {
      const filePath = path.slice(contentsPrefix.length);
      const branch = url.searchParams.get('ref') ?? '';
      const existing = files.get(`${branch}:${filePath}`);
      if (existing === undefined) return new Response('not found', { status: 404 });
      return jsonResponse(200, { sha: existing.sha });
    }
    if (path.startsWith(contentsPrefix) && method === 'PUT') {
      const filePath = path.slice(contentsPrefix.length);
      const body = JSON.parse(String(init?.body)) as { content: string; branch: string };
      fileShaCounter++;
      putBranches.push(body.branch);
      files.set(`${body.branch}:${filePath}`, { content: body.content, sha: `sha-${fileShaCounter}` });
      return jsonResponse(200, {});
    }
    if (path === `/repos/${repo}/pulls` && method === 'GET') {
      // Filters the way the real endpoint does: `head` is `owner:ref`, and a
      // value in any other shape is *ignored* rather than rejected, so the
      // whole open list comes back (#95). `head.ref` is on the response
      // because `findOpenPullRequest` cross-checks it.
      const filter = url.searchParams.get('head');
      const wanted = filter === null ? null : (/^[^:/]+:(.+)$/.exec(filter)?.[1] ?? null);
      const open = openPrUrl === null || openPrHead === null ? [] : [{ html_url: openPrUrl, head: { ref: openPrHead } }];
      if (wanted === null) return jsonResponse(200, open);
      return jsonResponse(200, open.filter((pr) => pr.head.ref === wanted));
    }
    if (path === `/repos/${repo}/pulls` && method === 'POST') {
      prPostCount++;
      openPrHead = (JSON.parse(String(init?.body)) as { head: string }).head;
      openPrUrl = `https://github.com/${repo}/pull/1`;
      return jsonResponse(201, { html_url: openPrUrl });
    }
    throw new Error(`fakeGithub: unhandled ${method} ${path}`);
  });

  return {
    fetchMock,
    branches,
    files,
    putBranches,
    refGets,
    prPostCount: () => prPostCount,
    branchPostCount: () => branchPostCount,
  };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    slug: 'agentic-code-review',
    title: 'Why agentic code review catches more bugs',
    description: 'A tension worth stating.',
    date: '2026-08-27',
    authors: ['nimeshjm'],
    tags: ['ai'],
    draft: true,
    brief: '# Research brief\n\n- [Article A](https://example.com/a)',
    body: '## Heading\n\nProse.',
    sources: ['https://example.com/a'],
    ...overrides,
  };
}

const DRAFT_BRANCH = 'research/2026-08-27-agentic-code-review';

describe('openPullRequest()', () => {
  it('run twice against the same draft produces exactly one PR, one branch, one file version', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    vi.stubGlobal('fetch', fake.fetchMock);

    const d = draft();
    const url1 = await openPullRequest(env, d);
    const url2 = await openPullRequest(env, d);

    expect(url1).toBe(url2);
    expect(fake.prPostCount()).toBe(1); // mechanism: existing-open-PR-by-head reuse (github.ts's findOpenPullRequest)
    expect(fake.branchPostCount()).toBe(2); // both attempts POST; the second's 422 is confirmed against the live ref (mechanism: existing-branch reuse)
    expect(fake.branches.size).toBe(1);
    expect(fake.putBranches).toEqual([DRAFT_BRANCH, DRAFT_BRANCH]); // mechanism: existing-file-sha reuse on the retry PUT
  });

  /**
   * The case run `0357f119` (2026-09-01) actually left behind: it pushed
   * `research/2026-09-01-modular-silent-trials-...` and committed the file,
   * then died before the pull request. The branch is still in the blog repo,
   * as is `research/2026-08-31-...` from the run before it - so a later run
   * that derives the same `research/<date>-<slug>` name has to publish onto
   * an existing branch rather than fail on it. This is not the replay case
   * above: nothing about this run created the branch.
   */
  it('publishes onto a branch a previous failed run left behind, without creating it', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    fake.branches.add(DRAFT_BRANCH);
    vi.stubGlobal('fetch', fake.fetchMock);

    const url = await openPullRequest(env, draft());

    expect(url).toBe(`https://github.com/${env.BLOG_REPO}/pull/1`);
    expect(fake.branchPostCount()).toBe(1); // it did try, and the 422 was confirmed rather than assumed
    expect(fake.refGets).toContain(DRAFT_BRANCH);
    expect(fake.branches.size).toBe(1);
    expect(fake.putBranches).toEqual([DRAFT_BRANCH]);
  });

  /**
   * The gap the narrowed 422 closes. GitHub answers 422 to `Reference update
   * failed` and `Object does not exist` as well as to `Reference already
   * exists`; returning on any of them turned a ref that was never created
   * into a silent success, whose first symptom was further down the call
   * chain. Removing the `refExists` confirmation in `createBranch` makes this
   * case pass instead of throw.
   */
  it('a 422 that is not an existing ref still fails, rather than passing as idempotent', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG, { branchPostStatus: 422 });
    vi.stubGlobal('fetch', fake.fetchMock);

    await expect(openPullRequest(env, draft())).rejects.toThrow(/createBranch/);
    expect(fake.refGets).toContain(DRAFT_BRANCH);
    expect(fake.putBranches).toEqual([]);
    expect(fake.prPostCount()).toBe(0);
  });

  it('never writes to BLOG_BASE_BRANCH - only ever reads its ref, and only research/* branches receive commits', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    vi.stubGlobal('fetch', fake.fetchMock);

    await openPullRequest(env, draft());

    expect(fake.branches.has(env.BLOG_BASE_BRANCH)).toBe(false);
    for (const b of fake.putBranches) expect(b).not.toBe(env.BLOG_BASE_BRANCH);
  });

  /**
   * The idempotent-ref handling must not become a second way to reach the base
   * branch. `refExists` is a GET, and the only branch name that ever reaches
   * either it or `createBranch` is the `research/*` head - so an existing base
   * ref (which always exists) can never be mistaken for the agent's own
   * leftover.
   */
  it('the already-exists path reads only the research/* ref, never posts a ref for the base branch', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    fake.branches.add(DRAFT_BRANCH);
    vi.stubGlobal('fetch', fake.fetchMock);

    await openPullRequest(env, draft());

    const posted = fake.fetchMock.mock.calls
      .filter(([, init]) => (init?.method ?? 'GET') === 'POST')
      .map(([input, init]) => `${new URL(String(input)).pathname} ${String(init?.body ?? '')}`);
    for (const call of posted) expect(call).not.toContain(`refs/heads/${env.BLOG_BASE_BRANCH}`);
  });

  it('the committed frontmatter carries draft: true and no image key', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    vi.stubGlobal('fetch', fake.fetchMock);

    await openPullRequest(env, draft());

    const [key] = [...fake.files.keys()];
    const content = key !== undefined ? fake.files.get(key)?.content : undefined;
    const decoded = content !== undefined ? atob(content) : '';
    expect(decoded).toMatch(/^draft: true$/m);
    expect(decoded).not.toMatch(/^image:/m);
  });

  it('rejects a statically-invalid draft before making any GitHub call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(openPullRequest(env, draft({ slug: 'has a space' }))).rejects.toThrow(InvalidDraftError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws, and opens no PR, when the live schema now requires a field renderMdx does not emit', async () => {
    const mutatedSchema = REAL_CONTENT_CONFIG.replace('image: image().optional(),', 'image: image(),');
    const fake = fakeGithub(mutatedSchema);
    vi.stubGlobal('fetch', fake.fetchMock);

    await expect(openPullRequest(env, draft())).rejects.toThrow(/image/);
    expect(fake.prPostCount()).toBe(0);
    expect(fake.branches.size).toBe(0);
  });
});

/**
 * As `gather-workflow.test.ts`'s and `summarize-workflow.test.ts`'s: actually
 * runs the step body, which is the only way to see that `runPublish` passes
 * the draft it was handed through to `openPullRequest` and returns the URL
 * unchanged.
 */
function liveStep(names?: string[]): WorkflowStep {
  return {
    do: async (name: string, arg2: unknown, arg3?: unknown) => {
      names?.push(name);
      const callback = typeof arg3 === 'function' ? arg3 : arg2;
      if (typeof callback !== 'function') throw new Error('liveStep: no callback provided to step.do');
      return callback();
    },
    sleep: async () => undefined,
  } as unknown as WorkflowStep;
}

function publishEvent(payload: PublishParams): WorkflowEvent<PublishParams> {
  return { instanceId: 'child-own-instance-id', workflowName: 'publish-workflow', payload } as unknown as WorkflowEvent<PublishParams>;
}

describe("runPublish() (PublishWorkflow.run()'s body)", () => {
  it('publishes the draft it was handed and returns the pull request URL', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    vi.stubGlobal('fetch', fake.fetchMock);

    const prUrl = await runPublish(env, liveStep(), publishEvent({ draft: draft() }));

    expect(prUrl).toBe(`https://github.com/${env.BLOG_REPO}/pull/1`);
    expect(fake.putBranches).toEqual([DRAFT_BRANCH]);
  });

  it('a failed publication throws out of the child rather than returning an empty URL', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG.replace('image: image().optional(),', 'image: image(),'));
    vi.stubGlobal('fetch', fake.fetchMock);

    await expect(runPublish(env, liveStep(), publishEvent({ draft: draft() }))).rejects.toThrow(/image/);
    expect(fake.prPostCount()).toBe(0);
  });

  it('spends the whole publication in one step, under the step name the parent used to carry', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    vi.stubGlobal('fetch', fake.fetchMock);
    const names: string[] = [];

    await runPublish(env, liveStep(names), publishEvent({ draft: draft() }));

    // Byte-identical to the parent's old step name: it is the replay key, and
    // keeping it identical is what keeps a trace of this run comparable with
    // every run before publication moved.
    expect(names).toEqual(['open-pull-request']);
  });
});
