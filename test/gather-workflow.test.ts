import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatherCandidates, GATHER_UNDATED_MAX_PER_FEED, runGather } from '../src/gather-workflow';
import type { Env, GatherParams } from '../src/lib/types';
import { applySchema } from './schema';

/**
 * `gatherCandidates`'s own behaviour - moved here unchanged from
 * test/workflow.test.ts (feature 003, plan.md's "Reuse": the function moved
 * into the child unchanged, so its tests move with it). This is the body
 * `GatherWorkflow.run()` calls once per feed; nothing about a single feed's
 * fetch/parse/window/write changed when it moved from the parent's own step
 * loop into a child instance's.
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

async function resetSchema(): Promise<void> {
  for (const table of ['drafts', 'runs', 'run_candidates', 'seen_urls', 'topics']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

// Schema setup lives in ./schema.ts, shared with test/d1.test.ts and test/workflow.test.ts.
beforeEach(async () => {
  await applySchema(env.DB);
  await resetSchema();
});

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

describe('gatherCandidates()', () => {
  const runId = 'run-gather';

  it('applies the recency window, attaches the source name, and persists to run_candidates', async () => {
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

    const count = await gatherCandidates(env, runId, { name: 'Fixture', feedUrl: 'https://feed.test.example/x.xml' });

    expect(count).toBe(1);
    const rows = await env.DB.prepare(`SELECT url, title, source_name FROM run_candidates WHERE run_id = ?`)
      .bind(runId)
      .all<{ url: string; title: string; source_name: string }>();
    expect(rows.results).toEqual([{ url: 'https://example.com/recent', title: 'Recent', source_name: 'Fixture' }]);
  });

  it('a full day of dated items is not truncated', async () => {
    const items = Array.from({ length: 352 }, (_, i) => ({
      title: `Paper ${i}`,
      url: `https://arxiv.example/abs/${i}`,
      pubDate: new Date().toUTCString(),
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rssFeed(items))));

    const count = await gatherCandidates(env, runId, { name: 'arXiv cs.AI (fixture)', feedUrl: 'https://feed.test.example/arxiv.xml' });

    expect(count).toBe(352);
  });

  it(`caps undated items at ${GATHER_UNDATED_MAX_PER_FEED}`, async () => {
    const items = Array.from({ length: GATHER_UNDATED_MAX_PER_FEED + 10 }, (_, i) => ({
      title: `Undated ${i}`,
      url: `https://example.com/undated-${i}`,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rssFeed(items))));

    const count = await gatherCandidates(env, runId, { name: 'Fixture', feedUrl: 'https://feed.test.example/undated.xml' });

    expect(count).toBe(GATHER_UNDATED_MAX_PER_FEED);
  });

  it('a dead feed (non-2xx) contributes zero candidates rather than failing the step', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const count = await gatherCandidates(env, runId, { name: 'Dead feed', feedUrl: 'https://feed.test.example/dead.xml' });
    expect(count).toBe(0);
  });

  it('a network error contributes zero candidates rather than failing the step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const count = await gatherCandidates(env, runId, { name: 'Unreachable', feedUrl: 'https://feed.test.example/unreachable.xml' });
    expect(count).toBe(0);
  });

  it('a re-run against the same run_id leaves the row count unchanged (acceptance criterion 8)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          rssFeed([
            { title: 'A', url: 'https://example.com/repeat-a', pubDate: new Date().toUTCString() },
            { title: 'B', url: 'https://example.com/repeat-b', pubDate: new Date().toUTCString() },
          ]),
        ),
      ),
    );
    const source = { name: 'Repeatable', feedUrl: 'https://feed.test.example/repeatable.xml' };

    // writeRunCandidates itself is proven idempotent at the row level in
    // test/d1.test.ts; this proves the same property through gatherCandidates'
    // own step body (fetch + parse + window + write), not just the write -
    // and now through a child instance's own step rather than the parent's.
    await gatherCandidates(env, runId, source);
    await gatherCandidates(env, runId, source);

    const rows = await env.DB.prepare(`SELECT COUNT(*) as n FROM run_candidates WHERE run_id = ? AND source_name = ?`)
      .bind(runId, source.name)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });
});

/**
 * Unlike trace.test.ts's `recordingStep` (which deliberately never invokes
 * its callback, so tests there don't depend on `tracing` being live), this
 * one actually runs the step body - the only way to prove `GatherWorkflow.run()`
 * plumbs `event.payload.runId` (the PARENT's instance id) rather than its own,
 * which no test of `gatherCandidates` alone (called with an explicit runId
 * already) can catch: get that one line wrong and every child writes rows
 * `shortlist` never reads, and the run records `insufficient_sources` with
 * every other check still green.
 */
function liveStep(): WorkflowStep {
  return {
    do: async (_name: string, arg2: unknown, arg3?: unknown) => {
      const callback = typeof arg3 === 'function' ? arg3 : arg2;
      if (typeof callback !== 'function') throw new Error('liveStep: no callback provided to step.do');
      return callback();
    },
    sleep: async () => undefined,
  } as unknown as WorkflowStep;
}

describe('runGather() (GatherWorkflow.run()\'s body)', () => {
  it("writes candidates under the PARENT's run id (event.payload.runId), never the child's own instance id, and returns the summed count", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'https://feed.test.example/a.xml') {
          return new Response(rssFeed([{ title: 'A', url: 'https://example.com/a', pubDate: new Date().toUTCString() }]));
        }
        if (url === 'https://feed.test.example/b.xml') {
          return new Response(
            rssFeed([
              { title: 'B1', url: 'https://example.com/b1', pubDate: new Date().toUTCString() },
              { title: 'B2', url: 'https://example.com/b2', pubDate: new Date().toUTCString() },
            ]),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const payload: GatherParams = {
      runId: 'parent-run-id',
      index: 0,
      sources: [
        { name: 'A', feedUrl: 'https://feed.test.example/a.xml' },
        { name: 'B', feedUrl: 'https://feed.test.example/b.xml' },
      ],
    };
    const event = { instanceId: 'child-own-instance-id', workflowName: 'gather-workflow', payload } as unknown as WorkflowEvent<GatherParams>;

    const count = await runGather(env, liveStep(), event);

    expect(count).toBe(3);
    const rows = await env.DB.prepare(`SELECT run_id FROM run_candidates`).all<{ run_id: string }>();
    expect(rows.results).toHaveLength(3);
    expect(rows.results.every((r) => r.run_id === 'parent-run-id')).toBe(true);
    expect(rows.results.some((r) => r.run_id === 'child-own-instance-id')).toBe(false);
  });
});
