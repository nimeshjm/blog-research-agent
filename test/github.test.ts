import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBranch, GithubError, listBlogPostSlugs, openPullRequest, putFile, readBaseRefSha, readRepoFile, refExists } from '../src/lib/github';
import type { GithubConfig } from '../src/lib/github';

const config: GithubConfig = {
  apiBase: 'https://api.test.example',
  token: 'test-token',
  repo: 'nimeshjm/nimeshjm.com',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('readBaseRefSha()', () => {
  it('reads the object sha off /git/ref/heads/<branch>, never the identifier BLOG_BASE_BRANCH', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://api.test.example/repos/nimeshjm/nimeshjm.com/git/ref/heads/main');
      return jsonResponse(200, { object: { sha: 'abc123' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await readBaseRefSha(config, 'main')).toBe('abc123');
  });

  it('throws GithubError on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(readBaseRefSha(config, 'main')).rejects.toThrow(GithubError);
  });
});

describe('createBranch()', () => {
  it('POSTs refs/heads/<branchName> at the given sha', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.test.example/repos/nimeshjm/nimeshjm.com/git/refs');
      expect(JSON.parse(String(init?.body))).toEqual({ ref: 'refs/heads/research/2026-08-27-x', sha: 'sha1' });
      return jsonResponse(201, {});
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createBranch(config, 'research/2026-08-27-x', 'sha1')).resolves.toBeUndefined();
  });

  /**
   * `run()` re-executes on replay (feature 003 spec.md fact 2), and run
   * `0357f119` (2026-09-01) left `research/2026-09-01-...` behind in the blog
   * repo when it died after pushing but before opening the pull request - so a
   * same-slug branch is a case that happens, not only a hypothetical retry.
   */
  it('treats 422 as success when the ref really is there - checked, not assumed', async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        paths.push(`${init?.method ?? 'GET'} ${path}`);
        if ((init?.method ?? 'GET') === 'POST') return new Response('already exists', { status: 422 });
        return jsonResponse(200, { object: { sha: 'existing-sha' } });
      }),
    );

    await expect(createBranch(config, 'research/2026-08-27-x', 'sha1')).resolves.toBeUndefined();
    expect(paths).toEqual([
      'POST /repos/nimeshjm/nimeshjm.com/git/refs',
      'GET /repos/nimeshjm/nimeshjm.com/git/ref/heads/research/2026-08-27-x',
    ]);
  });

  /**
   * The reason the check above is a check. GitHub answers 422 to `Reference
   * update failed` (branch protection) and `Object does not exist` (an unknown
   * `fromSha`) as well as to `Reference already exists`; returning on any 422,
   * which this did until 2026-09-01, turned those into a silent success whose
   * first symptom was a 404 from `putFile`.
   */
  it('a 422 with no such ref throws, rather than passing as an existing branch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'POST') return new Response('reference update failed', { status: 422 });
        return new Response('not found', { status: 404 });
      }),
    );

    await expect(createBranch(config, 'research/2026-08-27-x', 'sha1')).rejects.toThrow(GithubError);
  });

  it('throws GithubError on any other failure status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(createBranch(config, 'research/2026-08-27-x', 'sha1')).rejects.toThrow(GithubError);
  });
});

describe('refExists()', () => {
  /**
   * A `research/<date>-<slug>` branch name carries slashes, and GitHub's
   * `GET /git/ref/{ref}` wants them intact - a whole-name `encodeURIComponent`
   * would send `heads/research%2F...` and be answered 404, reporting every
   * branch the agent ever creates as missing and turning `createBranch`'s
   * already-exists path into a hard failure.
   */
  it('sends the branch path with its slashes intact, encoding only within each segment', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return jsonResponse(200, { object: { sha: 'abc' } });
      }),
    );

    expect(await refExists(config, 'research/2026-08-27-x')).toBe(true);
    expect(seen).toEqual(['https://api.test.example/repos/nimeshjm/nimeshjm.com/git/ref/heads/research/2026-08-27-x']);
  });

  it('reports a 404 as absent rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    expect(await refExists(config, 'research/2026-08-27-x')).toBe(false);
  });

  it('throws GithubError on a failure that is not a 404 - an absent answer must mean absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(refExists(config, 'research/2026-08-27-x')).rejects.toThrow(GithubError);
  });
});

describe('putFile()', () => {
  it('reads the existing file sha first and includes it in the PUT', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse(200, { sha: 'existing-sha' });
      const body = JSON.parse(String(init?.body));
      expect(body.sha).toBe('existing-sha');
      return jsonResponse(200, {});
    });
    vi.stubGlobal('fetch', fetchMock);

    await putFile(config, {
      path: 'src/content/blog/x/index.mdx',
      content: '---\ntitle: x\n---\n',
      message: 'add draft',
      branch: 'research/2026-08-27-x',
    });

    expect(calls.some((c) => c.startsWith('PUT '))).toBe(true);
  });

  it('omits sha when the file does not exist yet (404 on the read)', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response('not found', { status: 404 });
      const body = JSON.parse(String(init?.body));
      expect('sha' in body).toBe(false);
      return jsonResponse(201, {});
    });
    vi.stubGlobal('fetch', fetchMock);

    await putFile(config, {
      path: 'src/content/blog/x/index.mdx',
      content: 'x',
      message: 'add draft',
      branch: 'research/2026-08-27-x',
    });
  });
});

describe('listBlogPostSlugs()', () => {
  it('lists directory entries under src/content/blog, without a ref (defaults to the default branch)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://api.test.example/repos/nimeshjm/nimeshjm.com/contents/src/content/blog');
      return jsonResponse(200, [
        { name: 'agentic-code-review', type: 'dir' },
        { name: 'ai-observability', type: 'dir' },
        { name: 'README.md', type: 'file' },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const slugs = await listBlogPostSlugs(config);

    expect(slugs).toEqual(['agentic-code-review', 'ai-observability']);
  });

  it('never mentions BLOG_BASE_BRANCH or passes a ref query param', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).not.toContain('ref=');
      return jsonResponse(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);

    await listBlogPostSlugs(config);
  });

  it('returns an empty list when the directory does not exist (404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    expect(await listBlogPostSlugs(config)).toEqual([]);
  });

  it('throws GithubError on any other failure status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(listBlogPostSlugs(config)).rejects.toThrow(GithubError);
  });
});

describe('readRepoFile()', () => {
  it('decodes base64 content at the default branch, without a ref query param', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://api.test.example/repos/nimeshjm/nimeshjm.com/contents/src/content.config.ts');
      expect(String(input)).not.toContain('ref=');
      return jsonResponse(200, { content: btoa('export const x = 1'), encoding: 'base64' });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await readRepoFile(config, 'src/content.config.ts')).toBe('export const x = 1');
  });

  it('returns null on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    expect(await readRepoFile(config, 'missing.ts')).toBeNull();
  });

  it('throws GithubError on any other failure status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(readRepoFile(config, 'x.ts')).rejects.toThrow(GithubError);
  });

  it('throws on a non-base64 encoding rather than silently misreading it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { content: 'raw text', encoding: 'utf-8' })));
    await expect(readRepoFile(config, 'x.ts')).rejects.toThrow(/encoding/);
  });
});

/**
 * The blog repo's open PRs, oldest first - the order the live API returned
 * them on 2026-09-02, when `list[0]` was PR #1 and that is what run
 * `e0f3bd1c` recorded.
 */
const openPulls = [
  { html_url: 'https://github.com/nimeshjm/nimeshjm.com/pull/1', head: { ref: 'research/2026-08-31-unrelated' } },
  { html_url: 'https://github.com/nimeshjm/nimeshjm.com/pull/7', head: { ref: 'research/2026-08-27-x' } },
];

/**
 * Emulates `GET /pulls?state=open&head=...`, including the part that made
 * #95 silent: GitHub *ignores* a `head` that is not `user:ref` rather than
 * rejecting it, so a malformed filter answers with the whole open list. A
 * mock that filtered whatever it was sent would pass with the bug put back.
 */
function listOpenPulls(input: RequestInfo | URL): unknown[] {
  const filter = new URL(String(input)).searchParams.get('head');
  const parsed = filter === null ? null : /^([^:/]+):(.+)$/.exec(filter);
  if (parsed === null) return openPulls;
  const [, owner, ref] = parsed;
  return owner === 'nimeshjm' ? openPulls.filter((pr) => pr.head.ref === ref) : [];
}

describe('openPullRequest()', () => {
  // Asserts the sent URL and nothing else, so it stays a live check on the
  // filter's shape even with the head-ref cross-check below taken away.
  it('filters on head=owner:ref - a colon, the only shape GitHub actually filters on', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse(200, []);
      return jsonResponse(201, { html_url: 'https://github.com/nimeshjm/nimeshjm.com/pull/12' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await openPullRequest(config, { title: 't', body: 'b', head: 'research/2026-09-02-new', base: 'main' });

    const requested = String(fetchMock.mock.calls[0]?.[0]);
    expect(requested).toContain('state=open');
    expect(requested).toContain('head=nimeshjm%3Aresearch%2F2026-09-02-new');
  });

  it('opens a PR for the requested head rather than reusing an unrelated open one', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse(200, listOpenPulls(input));
      return jsonResponse(201, { html_url: 'https://github.com/nimeshjm/nimeshjm.com/pull/12' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const url = await openPullRequest(config, {
      title: 't',
      body: 'b',
      head: 'research/2026-09-02-new',
      base: 'main',
    });

    expect(url).toBe('https://github.com/nimeshjm/nimeshjm.com/pull/12');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
  });

  it('reuses an existing open PR for the same head instead of opening a second one', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse(200, listOpenPulls(input));
      throw new Error('should not POST when a PR already exists');
    });
    vi.stubGlobal('fetch', fetchMock);

    const url = await openPullRequest(config, {
      title: 't',
      body: 'b',
      head: 'research/2026-08-27-x',
      base: 'main',
    });

    expect(url).toBe('https://github.com/nimeshjm/nimeshjm.com/pull/7');
  });

  it('throws rather than reusing a PR whose head is not the one asked for', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, [openPulls[0]]);
      }
      throw new Error('should not POST after a mismatched head');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      openPullRequest(config, { title: 't', body: 'b', head: 'research/2026-09-02-new', base: 'main' }),
    ).rejects.toThrow(/not for the requested head/);
  });

  it('opens a new PR when none is open for that head', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse(200, []);
      return jsonResponse(201, { html_url: 'https://github.com/nimeshjm/nimeshjm.com/pull/9' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const url = await openPullRequest(config, {
      title: 't',
      body: 'b',
      head: 'research/2026-08-27-x',
      base: 'main',
    });

    expect(url).toBe('https://github.com/nimeshjm/nimeshjm.com/pull/9');
  });
});
