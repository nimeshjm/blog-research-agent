import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRun } from '../src/lib/d1';
import { loadFeeds } from '../src/lib/feeds';
import type { Env, ProposeChildOutput, ProposeParams, Topic } from '../src/lib/types';
import { initialChildPollState } from '../src/lib/workflow-children';
import {
  createProposeChildren,
  pollProposeChildren,
} from '../src/workflow';
import {
  DUPLICATE_TOKEN_THRESHOLD,
  proposeAndPersistTopic,
  proposeTopic,
  runPropose,
} from '../src/propose-workflow';
import { applySchema } from './schema';

/**
 * `proposeTopic()`'s own tests - moved here unchanged from
 * test/workflow.test.ts (#109), the same way `openPullRequest`'s tests moved
 * into test/publish-workflow.test.ts when publication became a child. Only
 * the import changed; bodies and assertions are byte-identical.
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
  for (const table of ['runs', 'topics']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(async () => {
  await applySchema(env.DB);
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

    const result = await proposeTopic(env, []);

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

    const result = await proposeTopic(env, []);
    expect(result?.title).toBe('agentic infrastructure provisioning');
  });

  it('returns null when the blog feed cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await proposeTopic(env, []);
    expect(result).toBeNull();
  });

  // #104: reproduces the observed case - blog PR #2's title landed in
  // `topics` (origin: agent), and blog PR #3 was proposed two days later
  // sharing four non-stopword tokens with it ("structure", "behavior",
  // "coalescence", "system"), past DUPLICATE_TOKEN_THRESHOLD (2). Neither
  // the published feed nor the repo directory listing sees an unmerged
  // draft, so `coveredTopicTitles` - the third covered set - is the only
  // thing that can catch this. Without the fix, this test fails: nothing
  // else in `proposeTopic` rejects the near-duplicate.
  it('rejects a seed candidate that overlaps a title in coveredTopicTitles, even though it is absent from the feed and the repo', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          return new Response(
            rssFeed([
              {
                title: 'Structure-Behavior Coalescence: Rethinking System Design',
                url: 'https://seed.example/sbc-2',
              },
              { title: 'Genuinely Unrelated Topic', url: 'https://seed.example/unrelated' },
            ]),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await proposeTopic(env, ['Structure-Behavior Coalescence: A Unified Lens for System Design']);

    // The near-duplicate of the topics-table title is skipped; the
    // genuinely uncovered item is proposed instead.
    expect(result?.title).toBe('Genuinely Unrelated Topic');
  });

  it(`does not reject a seed candidate sharing fewer than ${DUPLICATE_TOKEN_THRESHOLD} words with a coveredTopicTitles entry`, async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          // Shares only one meaningful word ("agentic") with the topics-table title.
          return new Response(rssFeed([{ title: 'agentic infrastructure provisioning', url: 'https://seed.example/one-word' }]));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await proposeTopic(env, ['agentic pull request review']);
    expect(result?.title).toBe('agentic infrastructure provisioning');
  });
});

describe('proposeAndPersistTopic()', () => {
  it('persists the proposal and attaches it to the given parent run id', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          return new Response(rssFeed([{ title: 'A Brand New Topic Nobody Covered', url: 'https://seed.example/new' }]));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    await startRun(env.DB, 'parent-run-1');

    const result = await proposeAndPersistTopic(env, [], 'parent-run-1');

    expect(result.topic?.title).toBe('A Brand New Topic Nobody Covered');
    expect(result.topic?.origin).toBe('agent');
    const row = await env.DB.prepare('SELECT topic_id FROM runs WHERE instance_id = ?').bind('parent-run-1').first<{
      topic_id: number | null;
    }>();
    expect(row?.topic_id).toBe(result.topic?.id);
  });

  it('returns { topic: null } without touching topics or runs when nothing is uncovered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([{ title: 'Already covered', url: 'https://blog.test.example/x' }]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        return new Response(rssFeed([{ title: 'Already covered', url: 'https://seed.example/dup' }]));
      }),
    );
    await startRun(env.DB, 'parent-run-nothing');

    const result = await proposeAndPersistTopic(env, [], 'parent-run-nothing');

    expect(result).toEqual({ topic: null });
    const topics = await env.DB.prepare(`SELECT COUNT(*) AS n FROM topics`).first<{ n: number }>();
    expect(topics?.n).toBe(0);
    const row = await env.DB.prepare('SELECT topic_id FROM runs WHERE instance_id = ?').bind('parent-run-nothing').first<{
      topic_id: number | null;
    }>();
    expect(row?.topic_id).toBeNull();
  });

  it('replaying the same parent run recovers the same topic rather than inserting a second one', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          return new Response(rssFeed([{ title: 'Idempotent Replay Topic', url: 'https://seed.example/replay' }]));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    await startRun(env.DB, 'parent-run-replay');

    const first = await proposeAndPersistTopic(env, [], 'parent-run-replay');
    const second = await proposeAndPersistTopic(env, [], 'parent-run-replay');

    expect(second.topic?.id).toBe(first.topic?.id);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM topics WHERE origin = 'agent'`).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

/**
 * As `gather-workflow.test.ts`'s and `summarize-workflow.test.ts`'s: actually
 * runs the step body, which is the only way to see that `runPropose` passes
 * its params through to `proposeAndPersistTopic` and reports the child's own
 * step name.
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

function proposeEvent(payload: ProposeParams): WorkflowEvent<ProposeParams> {
  return { instanceId: 'child-own-instance-id', workflowName: 'propose-workflow', payload } as unknown as WorkflowEvent<ProposeParams>;
}

describe("runPropose() (ProposeWorkflow.run()'s body)", () => {
  it('proposes and persists against the parent instance id it was handed, in one step', async () => {
    const seed = loadFeeds()[0];
    if (seed === undefined) throw new Error('no seed feed configured');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === env.BLOG_FEED_URL) return new Response(rssFeed([]));
        if (url.startsWith(env.GITHUB_API_BASE)) return jsonResponse(200, []);
        if (url === seed.feedUrl) {
          return new Response(rssFeed([{ title: 'Child Proposed Topic', url: 'https://seed.example/child' }]));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    await startRun(env.DB, 'parent-of-child');
    const names: string[] = [];

    const output = await runPropose(env, liveStep(names), proposeEvent({ coveredTopicTitles: [], parentInstanceId: 'parent-of-child' }));

    expect(output.topic?.title).toBe('Child Proposed Topic');
    // Byte-identical single step name - a child has 50 subrequests to
    // itself, so there is nothing to buy by splitting this further
    // (runPublish's comment makes the same argument).
    expect(names).toEqual(['propose-topic']);
    const row = await env.DB.prepare('SELECT topic_id FROM runs WHERE instance_id = ?').bind('parent-of-child').first<{
      topic_id: number | null;
    }>();
    expect(row?.topic_id).toBe(output.topic?.id);
  });

  it('returns { topic: null } rather than throwing when nothing is uncovered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(rssFeed([{ title: 'Already covered', url: 'https://x.example/a' }]))),
    );
    await startRun(env.DB, 'parent-of-child-nothing');

    const output = await runPropose(
      env,
      liveStep(),
      proposeEvent({ coveredTopicTitles: ['already covered'], parentInstanceId: 'parent-of-child-nothing' }),
    );

    expect(output).toEqual({ topic: null });
  });
});

/**
 * A stateful fake of the `PROPOSE_WORKFLOW` binding surface
 * `createProposeChildren` touches - the same shape `fakePublishWorkflow()`
 * (test/workflow.test.ts) uses for its one-child sibling.
 */
function fakeProposeWorkflow(): {
  binding: Env['PROPOSE_WORKFLOW'];
  created: Map<string, ProposeParams>;
  setStatus: (id: string, status: InstanceStatus) => void;
  polled: string[];
} {
  const created = new Map<string, ProposeParams>();
  const statuses = new Map<string, InstanceStatus>();
  const polled: string[] = [];
  const defaultOutput: ProposeChildOutput = { topic: null };
  const defaultStatus: InstanceStatus = { status: 'complete', output: defaultOutput };

  const binding = {
    createBatch: async (options: WorkflowInstanceCreateOptions<ProposeParams>[]) => {
      for (const o of options) {
        if (o.id !== undefined && created.has(o.id)) {
          throw new Error(`Workflow instance ${o.id} already exists`);
        }
      }
      for (const o of options) {
        if (o.id === undefined) continue;
        created.set(o.id, o.params as ProposeParams);
        if (!statuses.has(o.id)) statuses.set(o.id, defaultStatus);
      }
      return options.map((o) => ({ id: o.id }) as unknown as WorkflowInstance);
    },
    get: async (id: string) => {
      if (!created.has(id)) throw new Error(`Workflow instance ${id} does not exist`);
      return {
        id,
        status: async () => {
          polled.push(id);
          return statuses.get(id) ?? defaultStatus;
        },
      } as unknown as WorkflowInstance;
    },
  } as unknown as Env['PROPOSE_WORKFLOW'];

  return { binding, created, polled, setStatus: (id, status) => statuses.set(id, status) };
}

function fakeTopic(overrides: Partial<Topic> = {}): Topic {
  return { id: 7, title: 'Fake Topic', angle: null, status: 'in_progress', origin: 'agent', createdAt: '2026-09-04T00:00:00Z', ...overrides };
}

describe('createProposeChildren()', () => {
  it('creates exactly one child, carrying coveredTopicTitles and the parent instance id, under a deterministic id', async () => {
    const fake = fakeProposeWorkflow();
    const proposeEnv: Env = { ...env, PROPOSE_WORKFLOW: fake.binding };

    const ids = await createProposeChildren(proposeEnv, 'parent-1', ['already covered title']);

    expect(ids).toEqual(['parent-1-x0']);
    expect(fake.created.get('parent-1-x0')).toEqual({
      coveredTopicTitles: ['already covered title'],
      parentInstanceId: 'parent-1',
    });
  });

  it('is idempotent on replay: a second call against an already-created id does not throw and returns the same id', async () => {
    const fake = fakeProposeWorkflow();
    const proposeEnv: Env = { ...env, PROPOSE_WORKFLOW: fake.binding };

    const first = await createProposeChildren(proposeEnv, 'parent-replay', []);
    const second = await createProposeChildren(proposeEnv, 'parent-replay', []);

    expect(second).toEqual(first);
    expect(fake.created.size).toBe(1); // not doubled
  });

  it('a genuine creation failure (not a duplicate id) still throws', async () => {
    const failing: Env['PROPOSE_WORKFLOW'] = {
      createBatch: async () => {
        throw new Error('quota exceeded');
      },
      get: async () => {
        throw new Error('Workflow instance does not exist');
      },
    } as unknown as Env['PROPOSE_WORKFLOW'];
    const proposeEnv: Env = { ...env, PROPOSE_WORKFLOW: failing };

    await expect(createProposeChildren(proposeEnv, 'parent-fail', [])).rejects.toThrow('quota exceeded');
  });
});

describe('pollProposeChildren()', () => {
  async function createChild(): Promise<{ fake: ReturnType<typeof fakeProposeWorkflow>; proposeEnv: Env; ids: string[] }> {
    const fake = fakeProposeWorkflow();
    const proposeEnv: Env = { ...env, PROPOSE_WORKFLOW: fake.binding };
    const ids = await createProposeChildren(proposeEnv, 'parent-poll', []);
    return { fake, proposeEnv, ids };
  }

  const fresh = (ids: string[]): ReturnType<typeof initialChildPollState<ProposeChildOutput>> => initialChildPollState<ProposeChildOutput>(ids);

  it('reads the proposed topic back off the completed child', async () => {
    const { fake, proposeEnv, ids } = await createChild();
    const topic = fakeTopic();
    fake.setStatus(ids[0]!, { status: 'complete', output: { topic } });

    const result = await pollProposeChildren(proposeEnv, ids, fresh(ids), 0);

    expect(result).toEqual({ done: true, topic });
    expect(fake.polled).toEqual(ids); // one child, so one subrequest per round
  });

  // The whole point of ProposeChildOutput wrapping the nullable topic
  // (src/lib/types.ts's doc comment): a child that legitimately found
  // nothing to propose must complete cleanly, not be mistaken by
  // `pollChildBatch`'s `outputs[id] ?? ...` fallback (workflow-children.ts)
  // for a child that never reached a polled completion at all. Without the
  // wrapper, this assertion fails with "propose child ... never reached a
  // polled completion" instead of resolving `{ done: true, topic: null }`.
  it('reads a legitimate "nothing to propose" completion as done, not as a missing result', async () => {
    const { fake, proposeEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'complete', output: { topic: null } });

    const result = await pollProposeChildren(proposeEnv, ids, fresh(ids), 0);

    expect(result).toEqual({ done: true, topic: null });
  });

  it('returns done: false while the child has not reached complete', async () => {
    const { fake, proposeEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'running' } as InstanceStatus);

    const result = await pollProposeChildren(proposeEnv, ids, fresh(ids), 0);

    expect(result).toEqual({ done: false, state: { pending: ids, outputs: {} } });
  });

  it('fails (visibly) the moment the child is errored', async () => {
    const { fake, proposeEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'errored' } as InstanceStatus);

    await expect(pollProposeChildren(proposeEnv, ids, fresh(ids), 0)).rejects.toThrow(/propose child .* errored/);
  });

  it('fails when the child is terminated', async () => {
    const { fake, proposeEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'terminated' } as InstanceStatus);

    await expect(pollProposeChildren(proposeEnv, ids, fresh(ids), 0)).rejects.toThrow(/propose child .* terminated/);
  });

  // At one child the derived cap `max(2, floor(budget / childCount))` divides
  // by 1, so PROPOSE_POLL_SUBREQUEST_BUDGET (2) *is* the poll count - the
  // floor `pollChildBatch` itself enforces, and the smallest a single-child
  // loop can ever cost (createProposeChildren's own comment has the
  // arithmetic this is sized against).
  it('fails rather than hangs once the derived round cap is reached', async () => {
    const { fake, proposeEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'running' } as InstanceStatus);

    await expect(pollProposeChildren(proposeEnv, ids, fresh(ids), 1)).rejects.toThrow(/after 2 polls/);
  });

  it('validates the completed output rather than casting it - a non-object output fails the step', async () => {
    const { fake, proposeEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'complete', output: 'not an object' });

    await expect(pollProposeChildren(proposeEnv, ids, fresh(ids), 0)).rejects.toThrow(/non-object/);
  });

  it('validates that a non-null topic is at least object-shaped with an id', async () => {
    const { fake, proposeEnv, ids } = await createChild();
    fake.setStatus(ids[0]!, { status: 'complete', output: { topic: 'not a topic' } });

    await expect(pollProposeChildren(proposeEnv, ids, fresh(ids), 0)).rejects.toThrow(/malformed topic/);
  });
});
