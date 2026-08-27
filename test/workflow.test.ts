import { env as testEnv } from 'cloudflare:test';
import migrationSql from '../migrations/0001_init.sql?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEEN_URLS_CHUNK_SIZE } from '../src/lib/d1';
import { loadFeeds } from '../src/lib/feeds';
import { InvalidDraftError } from '../src/lib/mdx';
import type { ArticleSummary, Candidate, Draft, Env, Topic } from '../src/lib/types';
import {
  DUPLICATE_TOKEN_THRESHOLD,
  gatherCandidates,
  GATHER_UNDATED_MAX_PER_FEED,
  isGrounded,
  openPullRequest,
  proposeTopic,
  selectTopic,
  SHORTLIST_MAX_CANDIDATES,
  SHORTLIST_TOP_N,
  shortlistCandidates,
  summarizeArticle,
  synthesizeDraft,
} from '../src/workflow';

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

async function resetSchema(): Promise<void> {
  for (const table of ['drafts', 'runs', 'seen_urls', 'topics']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

function statementsFrom(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

beforeEach(async () => {
  for (const stmt of statementsFrom(migrationSql)) {
    await env.DB.prepare(stmt).run();
  }
  await resetSchema();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function rssFeed(items: Array<{ title: string; url: string; pubDate?: string }>): string {
  const itemXml = items
    .map(
      (i) => `<item>
<title>${i.title}</title>
<link>${i.url}</link>
<guid isPermaLink="false">not-a-url-guid</guid>
${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ''}
</item>`,
    )
    .join('\n');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${itemXml}</channel></rss>`;
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    url: 'https://example.com/x',
    title: 'x',
    publishedAt: '2026-08-27T00:00:00Z',
    sourceName: 'Test Source',
    ...overrides,
  };
}

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

describe('gatherCandidates()', () => {
  it('applies the recency window and attaches the source name', async () => {
    const now = new Date();
    const inWindow = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toUTCString();
    const outOfWindow = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toUTCString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          rssFeed([
            { title: 'Recent', url: 'https://example.com/recent', pubDate: inWindow },
            { title: 'Old', url: 'https://example.com/old', pubDate: outOfWindow },
          ]),
        ),
      ),
    );

    const result = await gatherCandidates({ name: 'Fixture', feedUrl: 'https://feed.test.example/x.xml' });

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('Recent');
    expect(result[0]?.sourceName).toBe('Fixture');
  });

  it('a full day of dated items is not truncated', async () => {
    const items = Array.from({ length: 352 }, (_, i) => ({
      title: `Paper ${i}`,
      url: `https://arxiv.example/abs/${i}`,
      pubDate: new Date().toUTCString(),
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rssFeed(items))));

    const result = await gatherCandidates({ name: 'arXiv cs.AI (fixture)', feedUrl: 'https://feed.test.example/arxiv.xml' });

    expect(result).toHaveLength(352);
  });

  it(`caps undated items at ${GATHER_UNDATED_MAX_PER_FEED}`, async () => {
    const items = Array.from({ length: GATHER_UNDATED_MAX_PER_FEED + 10 }, (_, i) => ({
      title: `Undated ${i}`,
      url: `https://example.com/undated-${i}`,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rssFeed(items))));

    const result = await gatherCandidates({ name: 'Fixture', feedUrl: 'https://feed.test.example/undated.xml' });

    expect(result).toHaveLength(GATHER_UNDATED_MAX_PER_FEED);
  });

  it('a dead feed (non-2xx) contributes zero candidates rather than failing the step', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const result = await gatherCandidates({ name: 'Dead feed', feedUrl: 'https://feed.test.example/dead.xml' });
    expect(result).toEqual([]);
  });

  it('a network error contributes zero candidates rather than failing the step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const result = await gatherCandidates({ name: 'Unreachable', feedUrl: 'https://feed.test.example/unreachable.xml' });
    expect(result).toEqual([]);
  });
});

describe('shortlistCandidates()', () => {
  it('caps at SHORTLIST_MAX_CANDIDATES before touching D1, and issues exactly the expected chunk count', async () => {
    const candidates = Array.from({ length: 4742 }, (_, i) =>
      candidate({
        url: `https://example.com/article-${i}`,
        title: `Article ${i}`,
        publishedAt: new Date(Date.now() - i * 1000).toISOString(), // strictly newest-first
      }),
    );

    let queryCount = 0;
    const countingEnv: Env = {
      ...env,
      DB: {
        prepare: (sql: string) => {
          queryCount++;
          return env.DB.prepare(sql);
        },
      } as D1Database,
    };

    const result = await shortlistCandidates(countingEnv, candidates, topic());

    // The cap runs *before* D1: ceil(SHORTLIST_MAX_CANDIDATES / chunk size),
    // not ceil(4742 / chunk size) - proves ordering, not just that both stay
    // under 50.
    expect(queryCount).toBe(SHORTLIST_MAX_CANDIDATES / SEEN_URLS_CHUNK_SIZE);
    expect(result.length).toBeLessThanOrEqual(SHORTLIST_TOP_N);
  });

  it('excludes candidates already present in seen_urls', async () => {
    await env.DB.prepare(`INSERT INTO seen_urls (url, source) VALUES (?, 'test')`).bind('https://example.com/seen').run();

    const result = await shortlistCandidates(
      env,
      [candidate({ url: 'https://example.com/seen', title: 'Seen' }), candidate({ url: 'https://example.com/new', title: 'New' })],
      topic(),
    );

    expect(result.map((c) => c.url)).toEqual(['https://example.com/new']);
  });

  it('caps the final ranked list at SHORTLIST_TOP_N', async () => {
    const candidates = Array.from({ length: SHORTLIST_TOP_N + 10 }, (_, i) =>
      candidate({ url: `https://example.com/r-${i}`, title: `Agentic code review practice paper ${i}` }),
    );
    const result = await shortlistCandidates(env, candidates, topic());
    expect(result).toHaveLength(SHORTLIST_TOP_N);
  });

  it('ranks a title carrying an attributable-practice signal above pure commentary with equal topic overlap', async () => {
    const t = topic({ title: 'agentic code review', angle: null });
    const result = await shortlistCandidates(
      env,
      [
        candidate({ url: 'https://example.com/commentary', title: 'Some thoughts on agentic code review' }),
        candidate({ url: 'https://example.com/study', title: 'A study of agentic code review practice' }),
      ],
      t,
    );
    expect(result[0]?.url).toBe('https://example.com/study');
  });
});

describe('selectTopic()', () => {
  it('claims a specific topic by id when topicId is set', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO topics (title, angle, status, origin) VALUES ('targeted', NULL, 'queued', 'human') RETURNING id`,
    ).first<{ id: number }>();
    const result = await selectTopic(env, insert?.id as number);
    expect(result?.title).toBe('targeted');
    expect(result?.status).toBe('in_progress');
  });

  it('drains the queue before proposing', async () => {
    await env.DB.prepare(`INSERT INTO topics (title, angle, status, origin) VALUES ('queued one', NULL, 'queued', 'human')`).run();
    const result = await selectTopic(env, undefined);
    expect(result?.title).toBe('queued one');
  });

  it('with an empty queue, proposes and persists a topic idempotently on replay', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([{ title: 'Already covered post', url: 'https://blog.test.example/already-covered' }]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          return new Response(
            rssFeed([{ title: 'Brand New Unrelated Topic Nobody Has Written About', url: 'https://seed.example/new-thing' }]),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const first = await selectTopic(env, undefined);
    expect(first?.title).toBe('Brand New Unrelated Topic Nobody Has Written About');
    expect(first?.origin).toBe('agent');
    expect(first?.status).toBe('in_progress');

    // Replay: a retried select-topic step must recover the same row, not insert a second one.
    const second = await selectTopic(env, undefined);
    expect(second?.id).toBe(first?.id);

    const rows = await env.DB.prepare(`SELECT COUNT(*) as n FROM topics WHERE origin = 'agent'`).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('returns null (falls through to record-no-topic) when the seed feed only offers already-covered material', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) {
          return new Response(rssFeed([{ title: 'Observability for agents in production', url: 'https://blog.test.example/observability' }]));
        }
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          return new Response(rssFeed([{ title: 'Observability for agents in production', url: 'https://seed.example/dup' }]));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await selectTopic(env, undefined);
    expect(result).toBeNull();
  });
});

describe('proposeTopic()', () => {
  it('checks against BOTH the blog feed (published) and repo directory listing (drafted)', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');

    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([{ title: 'Published post title', url: 'https://blog.test.example/p' }]));
        if (url.startsWith(env.GITHUB_API_BASE)) {
          return jsonResponse(200, [{ name: 'drafted-only-slug', type: 'dir' }]);
        }
        if (url === seed.feedUrl) {
          return new Response(
            rssFeed([
              { title: 'Drafted Only Slug', url: 'https://seed.example/drafted' },
              { title: 'Genuinely Novel Idea', url: 'https://seed.example/novel' },
            ]),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await proposeTopic(env);

    expect(calls).toContain(env.BLOG_FEED_URL);
    expect(calls.some((c) => c.startsWith(env.GITHUB_API_BASE))).toBe(true);
    // "Drafted Only Slug" collides with the repo-only slug and is skipped;
    // the first genuinely uncovered item is proposed instead.
    expect(result?.title).toBe('Genuinely Novel Idea');
  });

  it(`treats fewer than ${DUPLICATE_TOKEN_THRESHOLD} shared words as not a duplicate`, async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([{ title: 'agentic pull request review', url: 'https://blog.test.example/p' }]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          // Shares only one meaningful word ("agentic") with the published title.
          return new Response(rssFeed([{ title: 'agentic infrastructure provisioning', url: 'https://seed.example/one-word' }]));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await proposeTopic(env);
    expect(result?.title).toBe('agentic infrastructure provisioning');
  });

  it('returns null when the blog feed cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await proposeTopic(env);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// summarizeArticle() / synthesizeDraft() / isGrounded() / openPullRequest()
// ---------------------------------------------------------------------------

/**
 * `env.AI` with a stub `run` - the same approach `test/llm.test.ts` uses.
 * `[ai]` is stripped from the pool's wrangler config (see vitest.config.ts's
 * comment), so `env.AI` is otherwise undefined; `createLlm()` never calls
 * `env.AI.run` outside `src/lib/llm.ts`, so stubbing it here still leaves
 * `ai-run-only-in-llm` meaning something.
 */
function envWithAi(fixture: unknown): Env {
  return {
    ...env,
    AI: { run: async () => fixture } as unknown as Env['AI'],
  };
}

function chatFixture(content: string, finishReason = 'stop'): unknown {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

function articleResponse(bodyHtml: string): Response {
  return new Response(`<html><body>${bodyHtml}</body></html>`, { headers: { 'content-type': 'text/html' } });
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

function summary(overrides: Partial<ArticleSummary> = {}): ArticleSummary {
  return {
    url: 'https://example.com/a',
    title: 'Article A',
    summary: 'A summary.',
    relevance: 0.8,
    claims: ['claim one'],
    attributablePractice: 'Some practice',
    ...overrides,
  };
}

describe('summarizeArticle()', () => {
  it('fetches, extracts, and parses a well-formed map response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => articleResponse('<p>Real article prose about agentic code review.</p>')),
    );
    const aiEnv = envWithAi(
      chatFixture(JSON.stringify({ summary: 'It works.', relevance: 0.7, claims: ['c1'], attributablePractice: 'Practice X' })),
    );

    const result = await summarizeArticle(aiEnv, candidate({ url: 'https://example.com/a', title: 'Article A' }), topic());

    expect(result.summary).toEqual({
      url: 'https://example.com/a',
      title: 'Article A',
      summary: 'It works.',
      relevance: 0.7,
      claims: ['c1'],
      attributablePractice: 'Practice X',
    });
    expect(result.neurons).toBeGreaterThan(0);
  });

  it('returns summary: null without failing when the article cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const result = await summarizeArticle(envWithAi(chatFixture('{}')), candidate(), topic());
    expect(result).toEqual({ summary: null, neurons: 0 });
  });

  it('returns summary: null without failing on a non-2xx fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const result = await summarizeArticle(envWithAi(chatFixture('{}')), candidate(), topic());
    expect(result).toEqual({ summary: null, neurons: 0 });
  });

  it('returns summary: null without failing when the article body extracts to nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => articleResponse('<script>only script content</script>')));
    const result = await summarizeArticle(envWithAi(chatFixture('{}')), candidate(), topic());
    expect(result).toEqual({ summary: null, neurons: 0 });
  });

  it('returns summary: null (but still reports spent neurons) when the model response is not parseable JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => articleResponse('<p>Article prose.</p>')));
    const aiEnv = envWithAi(chatFixture('I think the article is about... (reasoning-fallback prose, not JSON)'));

    const result = await summarizeArticle(aiEnv, candidate(), topic());

    expect(result.summary).toBeNull();
    expect(result.neurons).toBeGreaterThan(0);
  });

  it('returns summary: null when the completion was truncated (finish_reason: length)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => articleResponse('<p>Article prose.</p>')));
    const aiEnv = envWithAi(chatFixture('{"summary": "cut off h', 'length'));

    const result = await summarizeArticle(aiEnv, candidate(), topic());
    expect(result.summary).toBeNull();
  });
});

describe('synthesizeDraft()', () => {
  const summaries = [summary({ url: 'https://example.com/a' }), summary({ url: 'https://example.com/b', title: 'Article B' })];

  it('builds a Draft from a well-formed reduce response, computing slug/date/authors/draft itself', async () => {
    const aiEnv = envWithAi(
      chatFixture(
        JSON.stringify({
          title: 'Why Agentic Review Catches More Bugs',
          description: 'A tension worth stating.',
          tags: ['ai', 'engineering-leadership'],
          body: '## The practice\n\nSome prose citing [Article A](https://example.com/a).',
        }),
      ),
    );

    const { draft, neurons } = await synthesizeDraft(aiEnv, topic(), summaries);

    expect(draft.slug).toBe('why-agentic-review-catches-more-bugs');
    expect(draft.title).toBe('Why Agentic Review Catches More Bugs');
    expect(draft.description).toBe('A tension worth stating.');
    expect(draft.tags).toEqual(['ai', 'engineering-leadership']);
    expect(draft.body).toContain('Some prose citing');
    expect(draft.draft).toBe(true);
    expect(draft.authors).toEqual(['nimeshjm']);
    expect(draft.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(draft.sources).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(neurons).toBeGreaterThan(0);
  });

  it('the brief links every source, never trusting the model to compose the source list', async () => {
    const aiEnv = envWithAi(
      chatFixture(JSON.stringify({ title: 'A Title', description: 'd', tags: [], body: 'body' })),
    );

    const { draft } = await synthesizeDraft(aiEnv, topic(), summaries);

    expect(draft.brief).toContain('https://example.com/a');
    expect(draft.brief).toContain('https://example.com/b');
    expect(draft.brief).toContain('Article A');
    expect(draft.brief).toContain('Article B');
  });

  it('falls back to a topic-id slug when the title has no usable characters', async () => {
    const aiEnv = envWithAi(chatFixture(JSON.stringify({ title: '!!!', description: 'd', tags: [], body: 'b' })));
    const { draft } = await synthesizeDraft(aiEnv, topic({ id: 42 }), summaries);
    expect(draft.slug).toBe('research-topic-42');
  });

  it('throws when the completion was truncated (finish_reason: length) rather than committing a truncated draft', async () => {
    const aiEnv = envWithAi(chatFixture('{"title": "cut off h', 'length'));
    await expect(synthesizeDraft(aiEnv, topic(), summaries)).rejects.toThrow(/truncat/i);
  });

  it('throws when the model response is not valid JSON in the expected shape', async () => {
    const aiEnv = envWithAi(chatFixture('not json at all'));
    await expect(synthesizeDraft(aiEnv, topic(), summaries)).rejects.toThrow();
  });
});

describe('isGrounded()', () => {
  it('requires at least MIN_SOURCES summaries with at least one attributable practice', () => {
    expect(isGrounded([summary({ attributablePractice: 'X' }), summary({ attributablePractice: null })])).toBe(true);
  });

  it('rejects a single source even if it carries an attributable practice (spec.md criterion 6)', () => {
    expect(isGrounded([summary({ attributablePractice: 'X' })])).toBe(false);
  });

  it('rejects two or more sources when none carries an attributable practice', () => {
    expect(isGrounded([summary({ attributablePractice: null }), summary({ attributablePractice: null })])).toBe(false);
  });
});

describe('openPullRequest()', () => {
  /**
   * A stateful fake of the whole GitHub surface `openPullRequest` touches -
   * `test/github.test.ts` already proves each primitive (`createBranch`,
   * `putFile`, `openPullRequest`) in isolation; this proves the
   * *composition* stays idempotent end to end, per plan.md's step-5
   * verification row: "openPullRequest run twice against a fixture produces
   * one PR."
   */
  function fakeGithub(schemaSource: string) {
    const repo = env.BLOG_REPO;
    const branches = new Set<string>();
    const files = new Map<string, { content: string; sha: string }>();
    let openPrUrl: string | null = null;
    let prPostCount = 0;
    let branchPostCount = 0;
    let fileShaCounter = 0;
    const putBranches: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const path = url.pathname;
      const contentsPrefix = `/repos/${repo}/contents/`;

      if (path === `${contentsPrefix}src/content.config.ts` && method === 'GET') {
        return jsonResponse(200, { content: btoa(schemaSource), encoding: 'base64' });
      }
      if (path === `/repos/${repo}/git/ref/heads/main` && method === 'GET') {
        return jsonResponse(200, { object: { sha: 'base-sha' } });
      }
      if (path === `/repos/${repo}/git/refs` && method === 'POST') {
        branchPostCount++;
        const body = JSON.parse(String(init?.body)) as { ref: string };
        const branch = body.ref.replace('refs/heads/', '');
        if (branches.has(branch)) return new Response('exists', { status: 422 });
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
        return jsonResponse(200, openPrUrl === null ? [] : [{ html_url: openPrUrl }]);
      }
      if (path === `/repos/${repo}/pulls` && method === 'POST') {
        prPostCount++;
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

  it('run twice against the same draft produces exactly one PR, one branch, one file version', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    vi.stubGlobal('fetch', fake.fetchMock);

    const d = draft();
    const url1 = await openPullRequest(env, d);
    const url2 = await openPullRequest(env, d);

    expect(url1).toBe(url2);
    expect(fake.prPostCount()).toBe(1); // mechanism: existing-open-PR-by-head reuse (github.ts's findOpenPullRequest)
    expect(fake.branchPostCount()).toBe(2); // both attempts POST; the second's 422 is treated as success (mechanism: existing-branch reuse)
    expect(fake.branches.size).toBe(1);
    expect(fake.putBranches).toEqual(['research/2026-08-27-agentic-code-review', 'research/2026-08-27-agentic-code-review']); // mechanism: existing-file-sha reuse on the retry PUT
  });

  it('never writes to BLOG_BASE_BRANCH - only ever reads its ref, and only research/* branches receive commits', async () => {
    const fake = fakeGithub(REAL_CONTENT_CONFIG);
    vi.stubGlobal('fetch', fake.fetchMock);

    await openPullRequest(env, draft());

    expect(fake.branches.has(env.BLOG_BASE_BRANCH)).toBe(false);
    for (const b of fake.putBranches) expect(b).not.toBe(env.BLOG_BASE_BRANCH);
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
