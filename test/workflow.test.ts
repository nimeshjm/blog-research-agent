import { env as testEnv } from 'cloudflare:test';
import migrationSql from '../migrations/0001_init.sql?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFeeds } from '../src/lib/feeds';
import type { Candidate, Env, Topic } from '../src/lib/types';
import {
  DUPLICATE_TOKEN_THRESHOLD,
  gatherCandidates,
  GATHER_UNDATED_MAX_PER_FEED,
  proposeTopic,
  selectTopic,
  SHORTLIST_MAX_CANDIDATES,
  SHORTLIST_TOP_N,
  shortlistCandidates,
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

    // The cap runs *before* D1: ceil(SHORTLIST_MAX_CANDIDATES / 100), not
    // ceil(4742 / 100) - proves ordering, not just that both stay under 50.
    expect(queryCount).toBe(SHORTLIST_MAX_CANDIDATES / 100);
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
