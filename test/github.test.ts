import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBranch, GithubError, listBlogPostSlugs, openPullRequest, putFile, readBaseRefSha } from '../src/lib/github';
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

  it('treats 422 (branch already exists) as success, for a retried step', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('already exists', { status: 422 })));
    await expect(createBranch(config, 'research/2026-08-27-x', 'sha1')).resolves.toBeUndefined();
  });

  it('throws GithubError on any other failure status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(createBranch(config, 'research/2026-08-27-x', 'sha1')).rejects.toThrow(GithubError);
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

describe('openPullRequest()', () => {
  it('reuses an existing open PR for the same head instead of opening a second one', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        expect(String(input)).toContain('state=open');
        return jsonResponse(200, [{ html_url: 'https://github.com/nimeshjm/nimeshjm.com/pull/7' }]);
      }
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
