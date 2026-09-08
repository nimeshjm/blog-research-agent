import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { readReviewableDrafts, recordDraftReview } from './lib/d1';
import { pullRequestNumberFromUrl, readPullRequestState, researchRefSlug } from './lib/github';
import type { GithubConfig } from './lib/github';
import { ATTR_DRAFTS_REVIEWABLE, ATTR_DRAFT_STATE, ATTR_TOPIC_ID, tracerFor } from './lib/trace';
import type { DraftState, Env, ReviewSweepParams } from './lib/types';

/**
 * #116's decline sweep: reads each open draft's pull-request state and writes
 * the outcome, closing the gap requirement 2's amendment describes - a draft
 * whose pull request a human closes unmerged otherwise leaves its `topics`
 * row `done` forever, burning the topic.
 *
 * **A top-level Workflow on its own cron, not a child of a research run.**
 * `createProposeChildren`'s comment (src/workflow.ts) records the parent's
 * subrequest ledger at 49 of 50 on the queue-draining path and 50 of 50 on
 * the propose path - there is no room left in a research run's own
 * invocation for this read, and it would not make sense as a research-run
 * step anyway: it reads pull requests from runs that finished hours or days
 * earlier, not anything the current run produced. So it is its own
 * `WorkflowEntrypoint`, created straight from `scheduled()` (src/index.ts) on
 * a separate cron slot, with its own fresh 50-subrequest budget.
 *
 * **Read-only against GitHub, and it opens, commits and pushes nothing.**
 * CLAUDE.md's "the agent writes to branches only" is a rule about the
 * research pipeline's pull requests; this file only ever calls
 * `readPullRequestState`, a GET. It has no reason to import anything that
 * writes a branch or a file, and does not.
 *
 * **No inference at all**, so this sweep costs zero neurons. It is outside
 * `NEURON_BUDGET_PER_RUN` and the daily reserve guard (spec.md acceptance
 * criterion 8) entirely - neither gate has anything to check here.
 *
 * **Subrequest ledger: 1 + 2N.** `load-reviewable-drafts` is one D1 read.
 * Each draft step is `readPullRequestState` (one fetch) plus
 * `recordDraftReview` (one `db.batch()` - two statements batched into one
 * Workers subrequest, per that function's own comment) - two per draft. At
 * `REVIEW_SWEEP_MAX_DRAFTS = 5` that is **11 of 50**, nowhere near the
 * ceiling; the ceiling this sweep actually watches is CPU, below.
 *
 * **One step per draft is a CPU lever, not a subrequest one.** 1 + 2N stays
 * trivially inside 50 subrequests at any plausible `REVIEW_SWEEP_MAX_DRAFTS`.
 * The real constraint is the platform's 10 ms CPU per invocation. A step
 * boundary is not a fresh budget: Workflows packs consecutive fast steps into
 * one invocation (CLAUDE.md's "Platform rules"). N pull-request JSON parses
 * landing in one invocation is the same failure class run `bd33248b` hit
 * chunking gather by
 * feed count rather than measured volume: a step boundary is the only thing
 * that buys a *chance* of a fresh invocation, and it is a chance, not a
 * guarantee. `REVIEW_SWEEP_MAX_DRAFTS`'s value is unmeasured - see its own
 * comment in wrangler.toml.
 *
 * The body is `runReviewSweep`, a plain exported function - same reason
 * `runGather`, `runSummarize`, `runPublish` and `runPropose` are:
 * `WorkflowEntrypoint`'s real constructor rejects being `new`'d outside the
 * platform's own Workflows runtime, so `run()` itself is untestable in
 * isolation.
 */
export async function runReviewSweep(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<ReviewSweepParams>,
): Promise<number> {
  const traceStep = tracerFor(step, event);
  const config: GithubConfig = { apiBase: env.GITHUB_API_BASE, token: env.GITHUB_TOKEN, repo: env.BLOG_REPO };

  // Bounded output, the same argument ChildPollState makes (src/lib/types.ts):
  // the list is capped by REVIEW_SWEEP_MAX_DRAFTS, which is what makes
  // carrying it through as this step's own persisted output legitimate -
  // run() re-executes from the top on replay, so a replayed sweep recovers
  // the same work list from here rather than re-reading it.
  const drafts = await traceStep('load-reviewable-drafts', {}, async (span) => {
    const reviewable = await readReviewableDrafts(env.DB, Number(env.REVIEW_SWEEP_MAX_DRAFTS));
    span.setAttribute(ATTR_DRAFTS_REVIEWABLE, reviewable.length);
    return reviewable;
  });

  let terminalCount = 0;

  // One step per draft, named from the run id the step-1 output already
  // carries - never re-derived from anything that could change on replay.
  // `runs.instance_id` is a primary key, so these names are unique within
  // the sweep (step-names-unique) as well as stable across a replay
  // (step-names-static's dynamic-prefix allowance covers `review-draft:*`).
  for (const draft of drafts) {
    const state = await traceStep(`review-draft:${draft.runId}`, { [ATTR_TOPIC_ID]: draft.topicId }, async (span) => {
      const prNumber = pullRequestNumberFromUrl(draft.prUrl);
      const pr = await readPullRequestState(config, prNumber);
      const resolved: DraftState =
        pr === null ? 'unavailable' : pr.state === 'open' ? 'open' : pr.merged ? 'merged' : 'declined';

      await recordDraftReview(env.DB, {
        runId: draft.runId,
        prUrl: draft.prUrl,
        title: draft.topicTitle,
        // 'unknown' only when the pull request 404'd: `drafts.slug` is
        // NOT NULL and informational - it names the post the draft would
        // have become, which a gone pull request cannot tell us, and this
        // row exists to retire the draft from the work list rather than to
        // describe it. When the pull request answered, `researchRefSlug`
        // parses its head ref; the `?? pr.headRef` fallback is not expected
        // to fire - only pull requests this agent opened reach `runs.pr_url`,
        // so a ref outside the `research/<yyyy-mm-dd>-<slug>` shape should
        // not happen - and it records what the ref actually was rather than
        // inventing a slug or failing the sweep over a cosmetic column.
        slug: pr === null ? 'unknown' : (researchRefSlug(pr.headRef) ?? pr.headRef),
        state: resolved,
        topicReject: resolved === 'declined' ? draft.topicId : null,
      });

      span.setAttribute(ATTR_DRAFT_STATE, resolved);
      return resolved;
    });

    if (state !== 'open') terminalCount += 1;
  }

  // Idempotent end to end: each step body is one GitHub read plus one
  // converging upsert (recordDraftReview's own comment names
  // `ON CONFLICT(run_id)` as the mechanism), so a replay of run() re-running
  // a step already applied lands on the same row rather than a second one.
  return terminalCount;
}

export class ReviewSweepWorkflow extends WorkflowEntrypoint<Env, ReviewSweepParams> {
  run(event: WorkflowEvent<ReviewSweepParams>, step: WorkflowStep): Promise<number> {
    return runReviewSweep(this.env, step, event);
  }
}
