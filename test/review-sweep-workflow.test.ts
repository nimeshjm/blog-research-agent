import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readReviewableDrafts } from '../src/lib/d1';
import type { Env, ReviewSweepParams } from '../src/lib/types';
import { runReviewSweep } from '../src/review-sweep-workflow';
import { applySchema } from './schema';

/**
 * `runReviewSweep`'s own behaviour - the exported plain function, never the
 * `ReviewSweepWorkflow` class: `WorkflowEntrypoint`'s real constructor
 * rejects being `new`'d outside the platform's own Workflows runtime, the
 * same reason `runGather`/`runSummarize`/`runPublish`/`runPropose` are
 * exported and tested this way in their own suites.
 */

const rawEnv = testEnv as unknown as Env;
const env: Env = {
  ...rawEnv,
  BLOG_REPO: 'nimeshjm/nimeshjm.com',
  GITHUB_API_BASE: 'https://api.test.example',
  GITHUB_TOKEN: 'test-token',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// Schema setup lives in ./schema.ts, shared across the suite.
async function resetSchema(): Promise<void> {
  for (const table of ['drafts', 'runs', 'run_candidates', 'seen_urls', 'topics']) {
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

/** Inserts one `runs` row (status 'succeeded', pr_url set) attached to a fresh 'done' topic - the shape `readReviewableDrafts` picks up. */
async function insertReviewable(runId: string, prNumber: number, finishedAt: string): Promise<number> {
  const topic = await env.DB.prepare(`INSERT INTO topics (title, angle, status, origin) VALUES (?, NULL, 'done', 'human') RETURNING id`)
    .bind(`topic-${runId}`)
    .first<{ id: number }>();
  const topicId = topic?.id as number;
  await env.DB.prepare(`INSERT INTO runs (instance_id, topic_id, status, pr_url, finished_at) VALUES (?, ?, 'succeeded', ?, ?)`)
    .bind(runId, topicId, `https://github.com/${env.BLOG_REPO}/pull/${prNumber}`, finishedAt)
    .run();
  return topicId;
}

type PrFixture = { status: number; body?: { state: string; merged: boolean; head: { ref: string } } };

/** A stateful fake of the one GitHub surface a sweep touches: `GET .../pulls/<number>`, keyed by PR number. */
function fakeGithubReads(responses: Record<number, PrFixture>): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET') throw new Error(`fakeGithubReads: unexpected non-GET ${String(init?.method)}`);
    const path = new URL(String(input)).pathname;
    const match = /\/pulls\/(\d+)$/.exec(path);
    if (match === null) throw new Error(`fakeGithubReads: unexpected path ${path}`);
    const n = Number(match[1]);
    const fixture = responses[n];
    if (fixture === undefined) throw new Error(`fakeGithubReads: no fixture for PR #${n}`);
    if (fixture.status === 404) return new Response('not found', { status: 404 });
    return jsonResponse(fixture.status, fixture.body);
  });
}

function openFixture(headRef = 'research/2026-09-01-x'): PrFixture {
  return { status: 200, body: { state: 'open', merged: false, head: { ref: headRef } } };
}
function mergedFixture(headRef = 'research/2026-09-01-x'): PrFixture {
  return { status: 200, body: { state: 'closed', merged: true, head: { ref: headRef } } };
}
function declinedFixture(headRef = 'research/2026-09-01-x'): PrFixture {
  return { status: 200, body: { state: 'closed', merged: false, head: { ref: headRef } } };
}
function notFoundFixture(): PrFixture {
  return { status: 404 };
}

/**
 * As `gather-workflow.test.ts`'s and `publish-workflow.test.ts`'s: actually
 * runs the step body, recording each step name in call order - the property
 * these tests pin.
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

function sweepEvent(): WorkflowEvent<ReviewSweepParams> {
  return {
    instanceId: 'sweep-instance-id',
    workflowName: 'review-sweep-workflow',
    payload: { triggeredAt: '2026-09-08T07:45:00Z' },
  } as unknown as WorkflowEvent<ReviewSweepParams>;
}

describe('runReviewSweep()', () => {
  it('names the steps verbatim, in the work list order: load-reviewable-drafts then one review-draft:<runId> per draft', async () => {
    await insertReviewable('run-a', 1, '2026-09-01T00:00:00Z');
    await insertReviewable('run-b', 2, '2026-09-02T00:00:00Z');
    await insertReviewable('run-c', 3, '2026-09-03T00:00:00Z');
    vi.stubGlobal('fetch', fakeGithubReads({ 1: openFixture(), 2: openFixture(), 3: openFixture() }));
    const names: string[] = [];

    await runReviewSweep(env, liveStep(names), sweepEvent());

    // Also proves "one step per draft": three drafts, exactly four steps -
    // not one step doing three pull-request reads.
    expect(names).toEqual(['load-reviewable-drafts', 'review-draft:run-a', 'review-draft:run-b', 'review-draft:run-c']);
  });

  describe('the state machine', () => {
    it('an open PR writes drafts.state = open, leaves the topic done, and the draft is still reviewable on a second sweep', async () => {
      const topicId = await insertReviewable('run-open', 1, '2026-09-01T00:00:00Z');
      vi.stubGlobal('fetch', fakeGithubReads({ 1: openFixture() }));

      await runReviewSweep(env, liveStep(), sweepEvent());

      const draft = await env.DB.prepare('SELECT state FROM drafts WHERE run_id = ?').bind('run-open').first<{ state: string }>();
      const topic = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(topicId).first<{ status: string }>();
      expect(draft?.state).toBe('open');
      expect(topic?.status).toBe('done');

      const stillReviewable = (await readReviewableDrafts(env.DB, 10)).map((r) => r.runId);
      expect(stillReviewable).toContain('run-open');
    });

    it('closed + merged writes drafts.state = merged, leaves the topic done, and is not returned by a second sweep', async () => {
      const topicId = await insertReviewable('run-merged', 1, '2026-09-01T00:00:00Z');
      vi.stubGlobal('fetch', fakeGithubReads({ 1: mergedFixture() }));

      await runReviewSweep(env, liveStep(), sweepEvent());

      const draft = await env.DB.prepare('SELECT state FROM drafts WHERE run_id = ?').bind('run-merged').first<{ state: string }>();
      const topic = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(topicId).first<{ status: string }>();
      expect(draft?.state).toBe('merged');
      expect(topic?.status).toBe('done');

      const stillReviewable = (await readReviewableDrafts(env.DB, 10)).map((r) => r.runId);
      expect(stillReviewable).not.toContain('run-merged');
    });

    it('closed + not merged writes drafts.state = declined, moves the topic to rejected, and is not returned by a second sweep', async () => {
      const topicId = await insertReviewable('run-declined', 1, '2026-09-01T00:00:00Z');
      vi.stubGlobal('fetch', fakeGithubReads({ 1: declinedFixture() }));

      await runReviewSweep(env, liveStep(), sweepEvent());

      const draft = await env.DB.prepare('SELECT state FROM drafts WHERE run_id = ?').bind('run-declined').first<{ state: string }>();
      const topic = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(topicId).first<{ status: string }>();
      expect(draft?.state).toBe('declined');
      expect(topic?.status).toBe('rejected');

      const stillReviewable = (await readReviewableDrafts(env.DB, 10)).map((r) => r.runId);
      expect(stillReviewable).not.toContain('run-declined');
    });

    it('a 404 writes drafts.state = unavailable, leaves the topic done, is not returned by a second sweep, and drafts.slug is unknown', async () => {
      const topicId = await insertReviewable('run-gone', 1, '2026-09-01T00:00:00Z');
      vi.stubGlobal('fetch', fakeGithubReads({ 1: notFoundFixture() }));

      await runReviewSweep(env, liveStep(), sweepEvent());

      const draft = await env.DB.prepare('SELECT state, slug FROM drafts WHERE run_id = ?').bind('run-gone').first<{
        state: string;
        slug: string;
      }>();
      const topic = await env.DB.prepare('SELECT status FROM topics WHERE id = ?').bind(topicId).first<{ status: string }>();
      expect(draft?.state).toBe('unavailable');
      expect(draft?.slug).toBe('unknown');
      expect(topic?.status).toBe('done');

      const stillReviewable = (await readReviewableDrafts(env.DB, 10)).map((r) => r.runId);
      expect(stillReviewable).not.toContain('run-gone');
    });
  });

  it('the return value counts only terminal states: one open and two closed among three drafts returns 2', async () => {
    await insertReviewable('run-open', 1, '2026-09-01T00:00:00Z');
    await insertReviewable('run-merged', 2, '2026-09-02T00:00:00Z');
    await insertReviewable('run-declined', 3, '2026-09-03T00:00:00Z');
    vi.stubGlobal(
      'fetch',
      fakeGithubReads({ 1: openFixture(), 2: mergedFixture(), 3: declinedFixture() }),
    );

    const terminalCount = await runReviewSweep(env, liveStep(), sweepEvent());

    expect(terminalCount).toBe(2);
  });

  describe('slug, from the PR head ref via researchRefSlug', () => {
    it('a research/<yyyy-mm-dd>-<slug> head ref lands its hyphenated slug in drafts.slug', async () => {
      await insertReviewable('run-slug', 1, '2026-09-01T00:00:00Z');
      vi.stubGlobal('fetch', fakeGithubReads({ 1: mergedFixture('research/2026-09-01-some-hyphenated-slug') }));

      await runReviewSweep(env, liveStep(), sweepEvent());

      const draft = await env.DB.prepare('SELECT slug FROM drafts WHERE run_id = ?').bind('run-slug').first<{ slug: string }>();
      expect(draft?.slug).toBe('some-hyphenated-slug');
    });

    it('a head ref outside the research/<date>-<slug> shape lands verbatim - the documented fallback', async () => {
      await insertReviewable('run-odd-ref', 1, '2026-09-01T00:00:00Z');
      vi.stubGlobal('fetch', fakeGithubReads({ 1: mergedFixture('main') }));

      await runReviewSweep(env, liveStep(), sweepEvent());

      const draft = await env.DB.prepare('SELECT slug FROM drafts WHERE run_id = ?').bind('run-odd-ref').first<{ slug: string }>();
      expect(draft?.slug).toBe('main');
    });
  });

  it('an empty work list runs exactly one step and returns 0', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const names: string[] = [];

    const terminalCount = await runReviewSweep(env, liveStep(names), sweepEvent());

    expect(names).toEqual(['load-reviewable-drafts']);
    expect(terminalCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('REVIEW_SWEEP_MAX_DRAFTS is honoured: a limit of 1 against three eligible drafts produces two steps total', async () => {
    await insertReviewable('run-a', 1, '2026-09-01T00:00:00Z');
    await insertReviewable('run-b', 2, '2026-09-02T00:00:00Z');
    await insertReviewable('run-c', 3, '2026-09-03T00:00:00Z');
    vi.stubGlobal('fetch', fakeGithubReads({ 1: openFixture() }));
    const limitedEnv: Env = { ...env, REVIEW_SWEEP_MAX_DRAFTS: '1' };
    const names: string[] = [];

    await runReviewSweep(limitedEnv, liveStep(names), sweepEvent());

    expect(names).toEqual(['load-reviewable-drafts', 'review-draft:run-a']);
  });

  // The replay property REVIEW.md pass 3 requires: a declined draft's topic
  // moves off 'done', so a second sweep's own load-reviewable-drafts step
  // naturally excludes it - the same guarded-transition mechanism
  // recordDraftReview's own tests (test/d1.test.ts) prove directly. This is
  // what makes running the whole sweep twice safe rather than merely untested.
  it('running runReviewSweep twice over the same declined draft leaves exactly one drafts row and the topic rejected', async () => {
    await insertReviewable('run-replay', 1, '2026-09-01T00:00:00Z');
    vi.stubGlobal('fetch', fakeGithubReads({ 1: declinedFixture() }));

    const firstNames: string[] = [];
    await runReviewSweep(env, liveStep(firstNames), sweepEvent());
    const secondNames: string[] = [];
    const secondTerminalCount = await runReviewSweep(env, liveStep(secondNames), sweepEvent());

    expect(firstNames).toEqual(['load-reviewable-drafts', 'review-draft:run-replay']);
    expect(secondNames).toEqual(['load-reviewable-drafts']); // no longer in the work list
    expect(secondTerminalCount).toBe(0);

    const rows = await env.DB.prepare('SELECT state FROM drafts WHERE run_id = ?').bind('run-replay').all<{ state: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.state).toBe('declined');
    const topic = await env.DB.prepare(`SELECT status FROM topics WHERE title = 'topic-run-replay'`).first<{ status: string }>();
    expect(topic?.status).toBe('rejected');
  });

  it('makes no writes to GitHub - every recorded request is a GET', async () => {
    await insertReviewable('run-a', 1, '2026-09-01T00:00:00Z');
    await insertReviewable('run-b', 2, '2026-09-02T00:00:00Z');
    await insertReviewable('run-c', 3, '2026-09-03T00:00:00Z');
    const fetchMock = fakeGithubReads({ 1: openFixture(), 2: mergedFixture(), 3: notFoundFixture() });
    vi.stubGlobal('fetch', fetchMock);

    await runReviewSweep(env, liveStep(), sweepEvent());

    const methods = fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET');
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) expect(method).toBe('GET');
  });
});
