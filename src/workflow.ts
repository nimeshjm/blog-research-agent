import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  attachRunTopic,
  claimOldestQueuedTopic,
  claimTopicById,
  findOrProposeTopic,
  findSeenUrls,
  pruneRunCandidates,
  readRunCandidates,
  readSourceWeights,
  reclaimStaleTopics,
  recordRunOutcome,
  startRun,
} from './lib/d1';
import { fetchFeedItems } from './lib/feed-fetch';
import { loadFeeds, SOURCE_TIER_DEFAULT, SOURCE_TIER_DEFERRED, SOURCE_TIER_PRIORITY, sourceTiers, tierOf } from './lib/feeds';
import { listBlogPostSlugs } from './lib/github';
import { createLlm, neuronsFor } from './lib/llm';
import { buildReduceMessages, normaliseCitations, parseReduceResponse } from './lib/prompts';
import type { ReduceParseFailure } from './lib/prompts';
import { createChildBatch, initialChildPollState, pollChildBatch } from './lib/workflow-children';
import type { ChildReplacement } from './lib/workflow-children';
import type {
  ArticleSummary,
  Candidate,
  Draft,
  Env,
  GatherParams,
  GatherPollResult,
  GatherPollState,
  PublishParams,
  PublishPollResult,
  PublishPollState,
  ResearchParams,
  RunOutcome,
  Source,
  SummarizeChildOutput,
  SummarizeParams,
  SummarizePollResult,
  SummarizePollState,
  Topic,
} from './lib/types';
import {
  ATTR_GATHER_CHILDREN,
  ATTR_NEURONS_BUDGET,
  ATTR_NEURONS_SPENT,
  ATTR_PUBLISH_CHILDREN,
  ATTR_RUN_STATUS,
  ATTR_SOURCES_GATHERED,
  ATTR_SOURCES_SHORTLISTED,
  ATTR_SOURCES_USED,
  ATTR_SUMMARIZE_CHILDREN,
  ATTR_SUMMARIZE_REPLACEMENTS,
  ATTR_TOPIC_ID,
  tracerFor,
} from './lib/trace';

/**
 * The research pipeline.
 *
 * Structured as a Workflow rather than a plain cron handler because the free
 * plan caps `scheduled()` at 15 minutes of wall-clock for the whole run, and
 * a Workflow step carries no such cap. The 10 ms CPU budget is charged per
 * invocation, not reset at each `step.do`, and so is the 50-subrequest
 * ceiling - Workflows packs consecutive fast steps into one invocation
 * instead of starting fresh at each one. Gather runs in `GatherWorkflow`
 * children rather than the parent's own steps for exactly this reason
 * (feature 003, spec.md's "Gather in child instances"): 46 feeds' worth of
 * fetches and D1 writes exhausted the parent's own 50-subrequest budget
 * before a single article could be fetched (#75, run `0199648c`) - see
 * `createGatherChildren`'s comment for the arithmetic.
 *
 * Article summarization runs in `SummarizeWorkflow` children for the same
 * reason (requirement 2, extended 2026-08-31 after run `6f75e460` moved
 * gather out and the parent still failed its 15th article on `Too many
 * subrequests by single Worker invocation.`): the ~15 shortlisted articles'
 * fetches and model calls no longer run in this invocation either - see
 * `createSummarizeChildren`'s comment for the arithmetic, including the 1
 * MiB step-result sizing that lets a child return the summaries themselves
 * rather than a side channel.
 *
 * The pull request is opened in a `PublishWorkflow` child for the third time
 * on the same argument (requirement 2, extended 2026-09-01 after run
 * `0357f119` got all the way to `open-pull-request` with a real draft and
 * failed inside it on the same subrequest error): its seven GitHub calls are
 * no longer this invocation's problem either. What is left here is
 * `select-topic`, `load-sources`, `shortlist`, `synthesize` and the `runs`-row
 * bookkeeping - and `record-success` still runs here, after the child, because
 * the `pr_url` it writes is what the child returns. See
 * `createPublishChildren`'s comment for the parent's recounted bill.
 *
 * No step is retried (spec.md requirement 1; `tracedStep`'s zero-retry
 * policy). Every step body stays idempotent anyway, because `run()` itself
 * re-executes from the top on every replay even when a completed step's
 * cached result does not re-run.
 */
export class ResearchWorkflow extends WorkflowEntrypoint<Env, ResearchParams> {
  async run(event: WorkflowEvent<ResearchParams>, step: WorkflowStep): Promise<void> {
    const budget = Number(this.env.NEURON_BUDGET_PER_RUN);

    // Bound once so every step below is instrumented the same way and no call
    // site can forget the run-level attributes (instance id, workflow name) -
    // see src/lib/trace.ts. The span opens *inside* step.do's callback, so
    // replay of an already-completed step (cached result, body not re-run)
    // never emits a duplicate span.
    const traceStep = tracerFor(step, event);

    // Neuron spend is checked *between* steps, not mid-call: cost is only known
    // once a call returns. This total survives replay because it is rebuilt from
    // persisted step results, so it must never be mutated outside a step result.
    let neuronsSpent = 0;

    // 0. Written before anything that can fail, so a run that dies in
    // select-topic (or later) still leaves a runs row (spec.md req. 10). It
    // has to be its own step, ahead of select-topic, rather than folded into
    // it: select-topic is already a step that can fail, and the row must
    // exist before that can happen, not conditional on it succeeding.
    await traceStep('start-run', {}, async () => startRun(this.env.DB, event.instanceId));

    // 1. Queue first; the agent proposes a topic only when the queue is empty.
    // `agent.topic.id` is only known once the call returns, so it is set on
    // the span handed to the body rather than passed in as an attr.
    const topic = await traceStep('select-topic', {}, async (span) => {
      const result = await selectTopic(this.env, event.instanceId, event.payload.topicId);
      if (result !== null) span.setAttribute(ATTR_TOPIC_ID, result.id);
      return result;
    });

    if (topic === null) {
      await traceStep(
        'record-no-topic',
        {
          [ATTR_NEURONS_SPENT]: neuronsSpent,
          [ATTR_NEURONS_BUDGET]: budget,
          [ATTR_RUN_STATUS]: 'no_topic',
        },
        async () => {
          return recordOutcome(this.env, event.instanceId, { status: 'no_topic', neuronsSpent });
        },
      );
      return;
    }

    // 2. Gather runs in child Workflow instances, never the parent's own
    //    steps (spec.md requirement 2) - see the class doc comment above and
    //    `createGatherChildren`'s comment for why and for the subrequest
    //    arithmetic `GATHER_FEEDS_PER_CHILD` is sized against.
    //
    //    `create-gather-children` returns child ids as plain strings, never
    //    a `WorkflowInstance` - the platform's own examples return one from
    //    a step body, but an object carrying functions cannot be serialized
    //    as a step result (plan.md's question 3). `await-gather-children` polls -
    //    there is no blocking join on a child instance - and both steps are
    //    idempotent on replay: deterministic child ids mean a re-run of
    //    `create` recreates nothing (`createGatherChildren`'s own comment),
    //    and a re-run of `await` only re-reads status.
    const sources = await traceStep('load-sources', {}, async () => loadSources(this.env));

    const childIds = await traceStep('create-gather-children', {}, async (span) => {
      const ids = await createGatherChildren(this.env, event.instanceId, sources);
      span.setAttribute(ATTR_GATHER_CHILDREN, ids.length);
      return ids;
    });

    // Each round gets its own step name. The step name is the replay key
    // (CLAUDE.md), and whether Workflows disambiguates repeat occurrences of
    // one literal name by call order is not documented - only
    // `WorkflowInstanceRestartOptions.from.count`'s doc comment hints at it.
    // If it does not, round 1 would replay round 0's cached `{ done: false }`
    // forever and no run could ever observe a completion. A per-round name
    // costs nothing (1,024 steps per instance, and a poll loop is bounded by
    // `pollGatherChildren`'s derived cap) and removes the question entirely
    // rather than leaving it for acceptance criterion 2 to discover.
    //
    // `:` so `tracedStep` still reports `agent.step` as
    // `await-gather-children`, the same way `gather:<feed>` and
    // `summarize:<url>` already do - the round stays out of the attribute.
    // Threaded from one poll step's output into the next one's input, never
    // held across steps in this closure: `run()` re-executes from the top on
    // every replay (spec.md fact 2), and a step output is the only thing the
    // platform persists - so a replayed round recomputes from the same input
    // it originally saw. Same rule `neuronsSpent` above follows. See
    // `ChildPollState` (src/lib/types.ts) for what it carries and why.
    let gathered = 0;
    let gatherState: GatherPollState = initialChildPollState(childIds);
    for (let round = 0; ; round++) {
      // The wait comes *before* the poll, not after it. A round 0 that fires a
      // second after `createBatch` is guaranteed to find nothing complete and
      // to spend one subrequest per child finding that out: run `0357f119`
      // (2026-09-01) spent 5 of the parent's 50 that way here and 3 more in
      // the summarize loop below, then died inside `open-pull-request` on the
      // platform's own subrequest error. Gather's children converge in 5-8 s
      // (run `6f75e460`), so waiting first lands round 0 past convergence and
      // turns this loop's two rounds into one. `step.sleep` costs neither a
      // step nor concurrency (Workflows limits docs; plan.md's question 1),
      // so the wall-clock this spends on an already-finished batch is free
      // where the poll round it replaces was not.
      await step.sleep(`await-gather-children-wait:${round}`, GATHER_POLL_INTERVAL);
      const state = gatherState;
      const outcome: GatherPollResult = await traceStep(`await-gather-children:${round}`, {}, async (span) => {
        const result = await pollGatherChildren(this.env, childIds, state, round);
        span.setAttribute(ATTR_GATHER_CHILDREN, childIds.length);
        return result;
      });
      if (outcome.done) {
        gathered = outcome.total;
        break;
      }
      gatherState = outcome.state;
    }

    // Batched dedupe against seen_urls happens inside shortlistCandidates.
    // `gathered` is not otherwise read downstream - it lands on this span
    // alongside the shortlisted count so the two are readable together, even
    // though `gathered` itself is now a sum of child totals (`await-gather-
    // children`'s own span already carries the child count) rather than
    // something totalled across per-feed spans on the parent.
    const shortlist = await traceStep('shortlist', {}, async (span) => {
      const result = await shortlistCandidates(this.env, event.instanceId, topic);
      span.setAttribute(ATTR_SOURCES_GATHERED, gathered);
      span.setAttribute(ATTR_SOURCES_SHORTLISTED, result.length);
      return result;
    });

    if (shortlist.length < MIN_SOURCES) {
      await traceStep(
        'record-no-sources',
        {
          [ATTR_NEURONS_SPENT]: neuronsSpent,
          [ATTR_NEURONS_BUDGET]: budget,
          [ATTR_RUN_STATUS]: 'insufficient_sources',
        },
        async () => {
          return recordOutcome(this.env, event.instanceId, {
            status: 'insufficient_sources',
            topicId: topic.id,
            neuronsSpent,
          });
        },
      );
      return;
    }

    // 3. Map: summarization runs in SummarizeWorkflow children, never the
    //    parent's own steps (spec.md requirement 2, extended 2026-08-31) -
    //    see the class doc comment above and `createSummarizeChildren`'s
    //    comment for why and for the subrequest and 1 MiB arithmetic. Same
    //    create/poll/validate shape as gather; `budget - neuronsSpent -
    //    SYNTHESIS_NEURON_RESERVE` is what used to gate the parent's own
    //    per-article loop and is now split across children instead (see
    //    createSummarizeChildren's comment).
    //
    //    The available budget is one expression, read by the create step and
    //    by the replacement capability below, so a replacement provably
    //    recreates a child with the params the original was created with
    //    (spec.md requirement 4's narrowing - the ids are replay keys and the
    //    params behind them must not drift).
    const summarizeBudget = budget - neuronsSpent - SYNTHESIS_NEURON_RESERVE;
    const summarizeChildIds = await traceStep('create-summarize-children', {}, async (span) => {
      const ids = await createSummarizeChildren(this.env, event.instanceId, shortlist, topic, summarizeBudget);
      span.setAttribute(ATTR_SUMMARIZE_CHILDREN, ids.length);
      return ids;
    });
    const replaceSummarizeChild = summarizeReplacement(this.env, event.instanceId, shortlist, topic, summarizeBudget);

    // Per-round step names, same reason as `await-gather-children` above.
    // Same threading as the gather loop above, and the same reason.
    let summaries: ArticleSummary[] = [];
    let summarizeState: SummarizePollState = initialChildPollState(summarizeChildIds);
    for (let round = 0; ; round++) {
      // Wait-then-poll, same reason as `await-gather-children` above. It buys
      // less here: run `0357f119`'s three summarize children completed between
      // 62 s and 122 s after `createBatch`, so at `SUMMARIZE_POLL_INTERVAL`'s
      // 90 s this loop expects one round where that run spent three, and two
      // if a child lands past the first poll. Either way the round it drops is
      // the guaranteed-empty one, not one that finds children still working.
      await step.sleep(`await-summarize-children-wait:${round}`, SUMMARIZE_POLL_INTERVAL);
      const state = summarizeState;
      const outcome: SummarizePollResult = await traceStep(`await-summarize-children:${round}`, {}, async (span) => {
        const result = await pollSummarizeChildren(this.env, summarizeChildIds, state, round, replaceSummarizeChild);
        span.setAttribute(ATTR_SUMMARIZE_CHILDREN, summarizeChildIds.length);
        // A round that finished cannot have created a replacement - a fresh
        // replacement is pending by construction - so on that round the count
        // in force is the one this round started from. The replacement's *id*
        // is in the step output; only the count reaches the span.
        const replacements = result.done ? state.replacements : result.state.replacements;
        span.setAttribute(ATTR_SUMMARIZE_REPLACEMENTS, Object.keys(replacements ?? {}).length);
        return result;
      });
      if (outcome.done) {
        summaries = outcome.summaries;
        neuronsSpent += outcome.neuronsSpent;
        break;
      }
      summarizeState = outcome.state;
    }

    if (!isGrounded(summaries)) {
      await traceStep(
        'record-no-summaries',
        {
          [ATTR_NEURONS_SPENT]: neuronsSpent,
          [ATTR_NEURONS_BUDGET]: budget,
          [ATTR_RUN_STATUS]: 'insufficient_sources',
        },
        async () => {
          return recordOutcome(this.env, event.instanceId, {
            status: 'insufficient_sources',
            topicId: topic.id,
            neuronsSpent,
          });
        },
      );
      return;
    }

    // 4. Reduce: one synthesis call producing the brief and the draft.
    const synthesis = await traceStep('synthesize', {}, async () => {
      return synthesizeDraft(this.env, topic, summaries);
    });
    neuronsSpent += synthesis.neurons;

    // 5. Branch-only write, and it runs in a `PublishWorkflow` child rather
    //    than here (spec.md requirement 2, extended 2026-09-01) - see
    //    `createPublishChildren`'s comment for why and for the recounted
    //    subrequest arithmetic. The agent never pushes to BLOG_BASE_BRANCH:
    //    that rule now lives entirely in src/publish-workflow.ts, which is
    //    the only file left that reads the variable.
    //
    //    Same create/poll/validate shape as the two loops above, with one
    //    child instead of a chunked set - so a poll round costs exactly one
    //    subrequest, and `combine` receives a one-element array.
    const publishChildIds = await traceStep('create-publish-children', {}, async (span) => {
      const ids = await createPublishChildren(this.env, event.instanceId, synthesis.draft);
      span.setAttribute(ATTR_PUBLISH_CHILDREN, ids.length);
      return ids;
    });

    // Per-round step names, and wait-then-poll, for the same reasons the two
    // loops above give. `record-success` deliberately comes *after* this
    // loop: the `runs` row's `pr_url` is what the child returns, so the
    // parent still owns the bookkeeping and still writes it last (spec.md
    // requirement 8).
    let prUrl = '';
    let publishState: PublishPollState = initialChildPollState(publishChildIds);
    for (let round = 0; ; round++) {
      await step.sleep(`await-publish-children-wait:${round}`, PUBLISH_POLL_INTERVAL);
      const state = publishState;
      const outcome: PublishPollResult = await traceStep(`await-publish-children:${round}`, {}, async (span) => {
        const result = await pollPublishChildren(this.env, publishChildIds, state, round);
        span.setAttribute(ATTR_PUBLISH_CHILDREN, publishChildIds.length);
        return result;
      });
      if (outcome.done) {
        prUrl = outcome.prUrl;
        break;
      }
      publishState = outcome.state;
    }

    await traceStep(
      'record-success',
      {
        [ATTR_SOURCES_USED]: summaries.length,
        [ATTR_NEURONS_SPENT]: neuronsSpent,
        [ATTR_NEURONS_BUDGET]: budget,
        [ATTR_RUN_STATUS]: 'succeeded',
      },
      async () => {
        return recordOutcome(this.env, event.instanceId, {
          status: 'succeeded',
          topicId: topic.id,
          sourcesUsed: summaries.length,
          neuronsSpent,
          prUrl,
        });
      },
    );
  }
}

/**
 * The grounding gate. See spec req. 5.
 *
 * A draft needs at least one source carrying an attributable R&D practice or
 * research finding, corroborated by at least one further independent source.
 * A raw article count is the wrong shape: at a two-day cadence the good case is
 * one solid sourced practice, not three articles of commentary.
 */
const MIN_SOURCES = 2;
const MIN_PRACTICES = 1;

export function isGrounded(summaries: ArticleSummary[]): boolean {
  const practices = summaries.filter((s) => s.attributablePractice !== null);
  return summaries.length >= MIN_SOURCES && practices.length >= MIN_PRACTICES;
}

/**
 * Headroom the budget gate reserves for the synthesis call, so it is never
 * the call `run()` skips (spec.md req. 6). This PR measured a real
 * synthesis call - through `createLlm()`, the real `buildReduceMessages()`,
 * 15 production-shaped summaries, `SYNTHESIS_MAX_TOKENS` as the ceiling - at
 * **222 neurons** (2,576 input / 2,045 output tokens, `finish_reason:
 * "stop"`, well short of the 8,192-token ceiling; raw envelope in this PR's
 * body). 500 keeps roughly 2x margin over that single measurement rather
 * than matching it exactly - one sample, and a harder topic could reason
 * longer. This replaces the previous, pre-measurement value of 1,000.
 */
const SYNTHESIS_NEURON_RESERVE = 500;

/**
 * `maxTokens` for the synthesis call. `@cf/openai/gpt-oss-120b` spends
 * reasoning tokens before content ones (issue #18), and the reduce prompt
 * asks for a full MDX post body (blog-voice: 1,000-2,800 words, roughly
 * 1,300-3,700 content tokens) on top of that reasoning - `llm.ts`'s
 * `DEFAULT_MAX_TOKENS` (2,048) is nowhere near enough and would truncate the
 * draft body into the model's reasoning trace via `normalise()`'s fallback.
 * The measured call (see `SYNTHESIS_NEURON_RESERVE`) used 2,045 of this
 * 8,192 ceiling and returned `finish_reason: "stop"` - comfortable margin,
 * not a near-miss. `synthesizeDraft` below still treats
 * `finishReason === 'length'` as a hard failure rather than silently
 * committing a truncated draft, in case a harder topic ever reaches it.
 */
const SYNTHESIS_MAX_TOKENS = 8192;

/**
 * `run_candidates` is per-run scratch, not a second cross-run dedupe key -
 * `seen_urls` stays the only one. Pruned once per run, in `recordOutcome`,
 * so no terminal path needs its own step.
 */
export const RUN_CANDIDATE_RETENTION_DAYS = 7;
/**
 * How long a claim survives its claimant (spec.md req. 9, which asks for the
 * margin to be stated rather than implied). Six hours against a run bounded
 * by 46 gather steps plus 15 article steps plus inference - minutes, not
 * hours - and a 48-hour cron gap: too long to race a live run, too short to
 * strand a topic across a cycle.
 */
export const TOPIC_CLAIM_TTL_HOURS = 6;
/** Newest-first ceiling: 40 of D1's 50 queries, ten spare. */
export const SHORTLIST_MAX_CANDIDATES = 4000;
/**
 * Final shortlist size handed to the map step (spec.md's pipeline diagram:
 * "rank vs topic, cap at 15"). Sets the neuron bill - see spec.md ->
 * Inference: 15 summaries plus one synthesis call is the ~4,132/run figure
 * measured in #18, so this is not a knob to turn casually.
 */
export const SHORTLIST_TOP_N = 15;
/**
 * How many meaningful title-word overlaps with an existing (published or
 * drafted) post count as "already covered" when the agent proposes its own
 * topic (spec.md req. 3). Heuristic, not semantic - see "Deferred: Vectorize
 * semantic dedupe" in spec.md, which is what a real version of this check
 * would use. Two shared non-stopword tokens is deliberately low: a proposal
 * that shares that much vocabulary with something already on the blog is
 * cheap to skip and expensive to publish twice.
 */
export const DUPLICATE_TOKEN_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Step bodies.
//
// Each inference-bearing step returns its neuron cost alongside its result so
// the caller can enforce NEURON_BUDGET_PER_RUN between steps.
// ---------------------------------------------------------------------------

export async function selectTopic(env: Env, instanceId: string, topicId: number | undefined): Promise<Topic | null> {
  // A manually-targeted run (event.payload.topicId set) claims that specific
  // row rather than draining the queue - see ResearchParams in lib/types.ts.
  // This is already the manual recovery spec.md req. 8 describes (claimRow
  // recovers an in_progress row for a run that names it), so it does not
  // also reclaim - a hand-triggered run reclaiming *other* runs' stranded
  // topics would widen its blast radius for no gain.
  if (topicId !== undefined) {
    const named = await claimTopicById(env.DB, topicId);
    if (named !== null) await attachRunTopic(env.DB, instanceId, named.id);
    return named;
  }

  // Scheduled path only: a topic left in_progress past TOPIC_CLAIM_TTL_HOURS
  // is unattended by definition (spec.md req. 8), so reclaiming here, before
  // draining the queue, is what makes it selectable again without a human
  // passing its id.
  await reclaimStaleTopics(env.DB, TOPIC_CLAIM_TTL_HOURS);

  const queued = await claimOldestQueuedTopic(env.DB);
  if (queued !== null) {
    await attachRunTopic(env.DB, instanceId, queued.id);
    return queued;
  }

  // Only reached when the queue is empty (spec.md req. 2). Proposing a topic
  // needs BOTH a non-inference way to generate a candidate and a dedupe
  // check against BLOG_FEED_URL and `draft: true` posts in the blog repo
  // (spec req. 3 - drafts are absent from the feed, so a feed-only check
  // proposes what is already half-written). Neither read seam existed in
  // #46 (feeds.ts there is the allowlist *loader* only; github.ts there is
  // scoped to the branch/commit/PR write path). Both now do - feed.ts
  // (parsing) is new in this PR, and github.ts gained `listBlogPostSlugs`
  // here - so the reassignment plan.md records lands the work in this step
  // instead. See features/001-scheduled-research-drafts/plan.md, steps 3
  // and 4.
  const proposal = await proposeTopic(env);
  if (proposal === null) return null;

  // attachRunTopic runs on all three success paths, not only this one: a run
  // that dies later - in gather, not in select-topic - must still record
  // which topic it stranded, which is what pairs req. 8's reclaim with req.
  // 10's runs row (the runs row says which topic, the TTL brings it back).
  const proposed = await findOrProposeTopic(env.DB, proposal);
  await attachRunTopic(env.DB, instanceId, proposed.id);
  return proposed;
}

async function loadSources(_env: Env): Promise<Source[]> {
  return loadFeeds();
}

/**
 * Generates a candidate {title, angle} without inference (spec.md is
 * explicit that inference happens in exactly two places - summarizeArticle
 * and synthesizeDraft - neither of which is this). Deterministic and cheap
 * enough to run inside the single `select-topic` step's budget:
 *
 *  1. The "published" set: parse BLOG_FEED_URL (one fetch) for post titles.
 *  2. The "drafted" set: list post slugs under src/content/blog/ at the
 *     repo's default branch (one fetch, `listBlogPostSlugs` -
 *     github.ts) - no per-post read needed, because spec.md's own measured
 *     fact ("the repo holds 33 posts and the feed 30 - the 3 missing are
 *     all unpublished drafts") means repo slugs minus feed slugs already
 *     *is* the drafted set, without reading a single file's frontmatter.
 *  3. The candidate itself: the newest item from the first configured
 *     discovery feed (deterministic, and - at 62 items - small enough to
 *     parse well inside this step's CPU budget even alongside the two
 *     reads above) whose title does not overlap either covered set past
 *     DUPLICATE_TOKEN_THRESHOLD.
 *
 * Returns null on any read failure or when every candidate from the seed
 * feed is already covered - `selectTopic` falls through to the existing
 * `record-no-topic` exit either way.
 */
export async function proposeTopic(env: Env): Promise<{ title: string; angle: string | null } | null> {
  const [publishedTitles, draftedSlugs] = await Promise.all([
    fetchFeedTitles(env.BLOG_FEED_URL),
    listBlogPostSlugs({ apiBase: env.GITHUB_API_BASE, token: env.GITHUB_TOKEN, repo: env.BLOG_REPO }).catch(
      () => [] as string[],
    ),
  ]);

  const covered = new Set<string>();
  for (const title of publishedTitles) for (const word of tokenize(title)) covered.add(word);
  for (const slug of draftedSlugs) for (const word of tokenize(slug.replace(/-/g, ' '))) covered.add(word);

  const seed = loadFeeds()[0];
  if (seed === undefined) return null;
  const seedItems = await fetchFeedItems(seed.feedUrl);

  for (const item of seedItems) {
    if (item.title === '') continue;
    const words = tokenize(item.title);
    const overlap = words.filter((w) => covered.has(w)).length;
    if (overlap < DUPLICATE_TOKEN_THRESHOLD) {
      return { title: item.title, angle: null };
    }
  }
  return null;
}

async function fetchFeedTitles(feedUrl: string): Promise<string[]> {
  // No bound: the seed-feed read that backs proposeTopic wants the newest
  // item regardless of the window (spec.md req. 12 - bounding it could
  // change which topic gets proposed).
  const items = await fetchFeedItems(feedUrl);
  return items.map((i) => i.title);
}

/**
 * Weight for a source `readSourceWeights` returned nothing for: a feed added
 * since the last run, a feed that has been returning nothing, or every feed
 * on a first run against empty history. Those cases are indistinguishable -
 * `run_candidates` stores rows, not absences - so they share one default.
 *
 * 25 is roughly the measured mean, 1,117 items across 46 feeds on 2026-09-01
 * (spec.md's calibration table), rather than the median of 4. The asymmetry
 * is the point: under-weighting a new *large* feed is the exact failure
 * volume-balancing exists to prevent, while over-weighting a small one costs
 * only a slightly uneven split. It also has to be non-zero - with every
 * weight at 0 the placement below has nothing to balance and fills each bin
 * to its cap in turn; with every weight equal and non-zero it degrades to
 * round-robin, which is what count-based chunking did and is a fine floor.
 */
export const DEFAULT_SOURCE_WEIGHT = 25;

/**
 * Distributes `sources` across `ceil(sources.length / feedsPerChild)` bins by
 * estimated *item volume* rather than by feed count (spec.md requirement 3,
 * amended 2026-09-01 (#75) after run `bd33248b`).
 *
 * **Why volume.** Parse CPU scales with items parsed; the old chunking
 * counted feeds. Child `g0` of `bd33248b` drew both arXiv feeds, parsed 917
 * items across three feeds, and died with `Worker exceeded CPU time limit.`
 * on its fourth (20 items) while its four siblings carried light chunks and
 * finished. Cost drains cumulatively across a chunk, so what matters is a
 * chunk's total, and balancing the totals is the whole change. This is true
 * regardless of where today's boundary happens to sit - see requirement 6 and
 * spec.md's note that this bounds a growth term rather than asserting a
 * boundary.
 *
 * **Why the bin count is unchanged.** `ceil(sources.length / feedsPerChild)`
 * is still what derives it, and it must stay at or below 5: `pollChildBatch`
 * (src/lib/workflow-children.ts) computes `max(2, floor(
 * GATHER_POLL_SUBREQUEST_BUDGET / childCount))` polls, so at 6 children the
 * parent falls to that floor of two - `floor(10 / 6)` is 1 - and buys no
 * margin at all for the extra child it just added. That is why volume is fixed
 * by *rebalancing* a fixed number of children rather than by adding children.
 * The argument is weaker than it was before the cap was corrected on
 * 2026-09-02 (#92), where the sixth child cost the parent its only retry
 * rather than only its margin; it is not broken, because adding children still
 * trades a child-side failure for a parent-side one.
 *
 * **`feedsPerChild` keeps its name and changes its job.** It is no longer a
 * CPU knob - it never was one, which is the bug - but the per-child
 * *feed-count* cap, which is the child's own 50-subrequest bound: one fetch
 * plus one D1 `batch()` per feed is two subrequests, so 10 feeds is 20 of a
 * child's 50. A bin is skipped once it holds that many however light it is,
 * which is why `g0` below ends up with cs.AI plus the overflow the other
 * four bins have no room for.
 *
 * Greedy longest-processing-time-first: heaviest source first into the
 * least-loaded bin with room. Deterministic in both orderings, because the
 * child ids derived from these bins are replay keys - sources sort by weight
 * descending then name ascending, and bins tie-break on load, then feed
 * count, then index. The feed-count term is what makes an all-equal-weight
 * input (a first run) come out as round-robin instead of filling bin 0 first.
 *
 * **Assignment order and emission order are different questions** (#99,
 * spec.md requirement 3's 2026-09-02 amendment). Which bin
 * a source lands in is the balancing decision above and stays weight-driven.
 * The order a bin's sources come *out* in is a curation decision, and it is
 * `tierOf`'s (src/lib/feeds.ts): a chunk is emitted priority sources first,
 * deferred last, so the feed a child parses first is the one most worth
 * having if that child dies mid-chunk on the CPU limit.
 */
export function chunkSourcesByVolume(sources: Source[], weights: Map<string, number>, feedsPerChild: number): Source[][] {
  if (sources.length === 0) return [];

  const childCount = Math.ceil(sources.length / feedsPerChild);
  const bins: { load: number; sources: Source[] }[] = Array.from({ length: childCount }, () => ({ load: 0, sources: [] }));

  const weightOf = (s: Source): number => weights.get(s.name) ?? DEFAULT_SOURCE_WEIGHT;
  // `<`, not `localeCompare`: collation is locale- and ICU-dependent, and
  // these chunks key child ids that have to survive replay byte-identically.
  const ordered = [...sources].sort((a, b) => weightOf(b) - weightOf(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const source of ordered) {
    let target = -1;
    for (let i = 0; i < childCount; i++) {
      const bin = bins[i]!;
      if (bin.sources.length >= feedsPerChild) continue;
      const best = target === -1 ? null : bins[target]!;
      if (best === null || bin.load < best.load || (bin.load === best.load && bin.sources.length < best.sources.length)) {
        target = i;
      }
    }
    bins[target]!.sources.push(source);
    bins[target]!.load += weightOf(source);
  }

  // Assignment above stays heaviest-first - that is what balances the bins
  // (#75). Only the order each bin is *emitted* in is curated, because that
  // is all a child consumes it in (`for (const source of
  // event.payload.sources)`, src/gather-workflow.ts). Total, not
  // stability-dependent: these chunks key child ids that must survive replay
  // byte-identically, so the comparator repeats the assignment sort's own
  // weight-then-name terms behind the tier rather than leaning on
  // `Array.prototype.sort` being stable.
  return bins.map((b) =>
    [...b.sources].sort(
      (a, b2) =>
        tierOf(a) - tierOf(b2) ||
        weightOf(b2) - weightOf(a) ||
        (a.name < b2.name ? -1 : a.name > b2.name ? 1 : 0),
    ),
  );
}

/**
 * Creates one `GatherWorkflow` child per chunk of `sources` (spec.md
 * requirements 2/3), the chunks coming from `chunkSourcesByVolume` above.
 * `runId` passed to every child is the *parent's* own instance id, never the
 * child's - see `GatherParams.runId`'s doc comment - so every child writes
 * into the same `run_candidates` rows and `shortlist` needs no change.
 *
 * **Weights are measured, not declared.** `readSourceWeights` (src/lib/d1.ts)
 * averages `run_candidates` per source per distinct run, so the chunker
 * tracks feed volume as it drifts - cs.AI went 352 -> 783 items in five days,
 * and spec.md already warns that a hand-written table of these numbers rots.
 * It excludes this run's own `run_id`: this run's children write under it as
 * they complete, and counting them would make a replay of this step compute
 * different weights, hence different chunks, behind child ids that stayed the
 * same. It costs the parent one D1 call - the second subrequest of this step,
 * counted in `createSummarizeChildren`'s fixed-cost recount below.
 *
 * **The subrequest arithmetic `GATHER_FEEDS_PER_CHILD` is sized against**
 * (`wrangler.toml`, read 2026-08-31 against #75's corrected premise - CPU is
 * no longer what binds, 50 subrequests/invocation is): `gatherCandidates`
 * (src/gather-workflow.ts) costs one `fetch` plus one D1 `batch()` call per
 * feed - two Workers subrequests (CLAUDE.md: "any `fetch` *and* any D1, KV
 * or AI binding call"), independent of `writeRunCandidates`'s own two SQL
 * statements inside that one `batch()` call, which count separately against
 * D1's *own* 50-queries-per-invocation ceiling (`d1.ts`) but not again
 * against this one. That count is a floor, not the whole bill: "each
 * redirect counts" too (CLAUDE.md), and this arithmetic does not know how
 * many of the 46 allowlisted feeds redirect. At `GATHER_FEEDS_PER_CHILD =
 * 10` the floor is 20 of a child's 50 - comfortable margin even against a
 * feed or two redirecting - giving `ceil(46 / 10) = 5` children for the
 * current feed count. `GATHER_FEEDS_PER_CHILD = 15` (the fewer-children
 * alternative the poll-cost paragraph below argues for) would leave only 20
 * of margin for redirects and D1 queuing before the ceiling, which is the
 * concrete reason 10 wins that tension rather than a round number.
 *
 * **The parent's own poll cost is the other half of this trade** (spec.md's
 * risk table: "Polling children costs subrequests and parent CPU" - one
 * subrequest per child per round, spec.md's own figure). Fewer, larger
 * children (this choice) mean fewer poll subrequests per round for a given
 * feed count; more, smaller children would leave more margin per child but
 * cost more per round. 10 was chosen for the child-side margin, not the
 * poll-side cost, because a child that returns `1102`/subrequest-exhausted
 * fails the whole run outright (requirement 4) while an extra poll round or
 * two is only ever a few more subrequests and some wall-clock, which this
 * design already spends freely (`step.sleep` costs neither a step nor
 * concurrency).
 *
 * **This does not make the parent's own remaining invocation safe on its
 * own.** See `createSummarizeChildren`'s comment below for the fixed-cost
 * recount now that summarize has joined gather in leaving this invocation
 * (extended 2026-08-31, #75) - this function's own contribution is what that
 * recount assumes gone.
 *
 * Ids are deterministic (`${parentInstanceId}-g${index}`), which is what
 * makes this step idempotent on replay: `run()` re-executes from the top on
 * every replay (fact 2, spec.md), so a second call here must not create a
 * different set of children. `createChildBatch` (src/lib/workflow-children.ts)
 * is what verifies a duplicate-id failure against reality rather than
 * assuming it - see that function's own comment.
 *
 * Returns child ids as plain strings, never a `WorkflowInstance` - the
 * platform's own examples return one from a step body, while the docs
 * elsewhere say an object carrying functions cannot be serialized as a step
 * result (plan.md's question 3).
 */
export async function createGatherChildren(env: Env, parentInstanceId: string, sources: Source[]): Promise<string[]> {
  const weights = await readSourceWeights(env.DB, parentInstanceId);
  const chunks = chunkSourcesByVolume(sources, weights, Number(env.GATHER_FEEDS_PER_CHILD));

  const options = chunks.map((chunk, index) => ({
    id: `${parentInstanceId}-g${index}`,
    params: { runId: parentInstanceId, sources: chunk, index } satisfies GatherParams,
  }));

  return createChildBatch(env.GATHER_WORKFLOW, options);
}

/**
 * Poll cadence for `await-gather-children` (spec.md: "The parent waits by
 * polling child status in a step, not by holding a promise across `run()`").
 * `step.sleep` counts toward neither the 1,024-step limit nor concurrency
 * (Workflows limits docs; plan.md's question 1) - but it also does not force
 * a fresh invocation (`probe/FINDINGS.md` §4-6), so consecutive poll rounds
 * can land in the very same invocation as every round before them, sharing
 * its 50-subrequest ceiling with everything else the parent does, including
 * `await-summarize-children`'s own poll loop now that it exists.
 */
const GATHER_POLL_INTERVAL = '30 seconds';
/**
 * The poll backstop is a subrequest budget, not a round count (`pollChildBatch`'s
 * own comment). **Reduced from 30 to 10 on 2026-08-31 (#75).** 30 was sized
 * as "a deliberately small slice of the 50" when this was the *only* poll
 * loop in the parent; `SUMMARIZE_POLL_SUBREQUEST_BUDGET` now shares that
 * same invocation, and 30 + 30 sums past the 50 both backstops are meant to
 * stay clear of. See `createPublishChildren`'s comment for the full recount
 * (23 fixed + this + summarize's + publish's = 46 of 50).
 *
 * **Held at 10 on 2026-09-01 (#75) while summarize's came down.** 2 rounds
 * is the smallest cap that leaves a retry at all, and `floor(10 / 5)` is
 * exactly 2 - there is nothing to give back here without making the first
 * poll the only one. 10 still gives real
 * margin specifically for gather: run `6f75e460` measured all five children
 * completing in 5-8 seconds, so at the `GATHER_FEEDS_PER_CHILD = 10` default
 * (5 children) `floor(10 / 5) = 2` rounds - polls at roughly 30 s and 60 s,
 * now that the loop waits before each one - is generous against a measured
 * few-second convergence, not tight against it.
 *
 * **The 2026-09-02 cap correction (#92) made that sentence literal rather
 * than changing it.** The cap used to poll at rounds 0-2 where this comment
 * and the ledger both said two polls; it now polls at 0 and 1, i.e. 30 s and
 * 60 s. Both captures that reached this loop clear it with room: run
 * `6f75e460`'s five children completed in 5-8 s, and run `54ce776b`'s were
 * complete at the *first* poll. This interval is deliberately not lengthened
 * to compensate - there is nothing to compensate for at a two-second-to-30-s
 * ratio, and a longer wait would only delay a run that is converging.
 */
const GATHER_POLL_SUBREQUEST_BUDGET = 10;

/**
 * One `await-gather-children` round, via `pollChildBatch`
 * (src/lib/workflow-children.ts). `InstanceStatus.output` is typed
 * `unknown` - `validateGatherOutput` below checks it rather than casting it,
 * per plan.md's question 3's rule for exactly this value. `state` is the
 * previous round's own output, which is what lets a round skip the children
 * that already finished.
 */
export async function pollGatherChildren(
  env: Env,
  childIds: string[],
  state: GatherPollState,
  round: number,
): Promise<GatherPollResult> {
  const outcome = await pollChildBatch(
    env.GATHER_WORKFLOW,
    childIds,
    state,
    round,
    GATHER_POLL_SUBREQUEST_BUDGET,
    'gather',
    validateGatherOutput,
    (counts) => counts.reduce((total, count) => total + count, 0),
  );
  return outcome.done ? { done: true, total: outcome.result } : outcome;
}

/** `InstanceStatus.output` is `unknown` - this is what actually enforces a child's "returns its candidate count" contract, per plan.md's question 3 ("validates rather than casts"). */
function validateGatherOutput(output: unknown, childId: string): number {
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
    throw new Error(`gather child ${childId} returned a non-count output`);
  }
  return output;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are',
  'with', 'how', 'why', 'what', 'this', 'that', 'from', 'at', 'by', 'as',
  'it', 'its', 'be', 'we', 'you', 'your', 'new', 'v1', 'vs',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * A paper/finding/first-hand-practice writeup, favoured because that is
 * what the grounding gate (isGrounded, MIN_PRACTICES) needs at least one of.
 */
const PRACTICE_SIGNAL_RE =
  /\b(paper|study|studies|research|benchmark|arxiv|survey|dataset|evaluation|evaluat\w*|results?|findings?|we (built|found|measured|shipped)|case study)\b/i;
/** Roundups, opinion and newsletter framing, deprioritised in favour of attributable material. */
const COMMENTARY_SIGNAL_RE = /\b(opinion|thoughts on|roundup|newsletter|weekly|digest|why i think|announcing)\b/i;

/**
 * How much a source's tier moves its candidates, in the same units as the
 * signals above: a priority source gains this, a deferred one loses it, and
 * the default tier is untouched. 3 makes the spread between a priority and a
 * deferred source 6 - more than the practice signal (+2) and the commentary
 * signal (-1) combined, so tier dominates a same-topic tie, and less than a
 * strong topic overlap, so a deferred source's genuinely on-topic paper
 * still outranks a priority source's off-topic post.
 *
 * **Why an offset and not a sort key** (#99, and feature 001 spec.md's
 * 2026-09-02 amendment). Tier as a primary sort key would
 * empty the shortlist of everything else: nothing writes `seen_urls`, so
 * every run's unseen set is the whole gathered set, and at the 2026-09-01
 * calibration the 9 priority feeds alone supply ~103 candidates against
 * `SHORTLIST_TOP_N = 15`. The other 35 feeds and both arXiv feeds would then
 * be gathered and never summarized - and `isGrounded` would be left resting
 * on whatever those 9 published, with the allowlist's densest supply of
 * attributable findings ranked out of reach.
 */
const TIER_SCORE_WEIGHT = 3;

/**
 * Heuristic relevance score against `topic`. Takes no `Ai` binding by
 * design (spec.md: inference happens in exactly two places, and ranking is
 * not one of them, which is what keeps the feed count invariant to the
 * neuron bill). Word overlap with the topic's title/angle, nudged toward
 * material carrying an attributable practice or finding over commentary
 * (spec.md -> Inference: "Ranking in shortlist should therefore favour
 * material that carries an attributable practice or finding over
 * commentary"), then by the source's curation tier.
 *
 * `tiers` is passed in rather than read here because this is called once per
 * candidate over up to SHORTLIST_MAX_CANDIDATES of them; a candidate whose
 * source has left the allowlist scores at `SOURCE_TIER_DEFAULT` (see
 * `sourceTiers`).
 */
function relevanceScore(candidate: Candidate, topic: Topic, tiers: Map<string, number>): number {
  const topicWords = new Set([...tokenize(topic.title), ...tokenize(topic.angle ?? '')]);
  const candidateWords = tokenize(candidate.title);
  let overlap = 0;
  for (const word of candidateWords) if (topicWords.has(word)) overlap++;

  let score = overlap;
  if (PRACTICE_SIGNAL_RE.test(candidate.title)) score += 2;
  if (COMMENTARY_SIGNAL_RE.test(candidate.title)) score -= 1;
  const tier = tiers.get(candidate.sourceName) ?? SOURCE_TIER_DEFAULT;
  if (tier === SOURCE_TIER_PRIORITY) score += TIER_SCORE_WEIGHT;
  if (tier === SOURCE_TIER_DEFERRED) score -= TIER_SCORE_WEIGHT;
  return score;
}

/**
 * Reads the run's whole candidate set from D1, newest-first and capped at
 * SHORTLIST_MAX_CANDIDATES in SQL (`readRunCandidates`'s `ORDER BY`, not a
 * JS sort - see that function's doc comment for why undated items sort
 * last) - so this does zero `Date.parse` calls where it used to do one per
 * candidate. Then the batched `seen_urls` dedupe (`findSeenUrls`, chunked at
 * 100 params - `d1.ts` owns that chunking, not reimplemented here), then
 * heuristic ranking against `topic` - which now carries a source-tier term,
 * see `TIER_SCORE_WEIGHT` - then a cap of SHORTLIST_TOP_N. See spec.md,
 * "The aggregate ceiling in `shortlist`".
 */
export async function shortlistCandidates(env: Env, runId: string, topic: Topic): Promise<Candidate[]> {
  const capped = await readRunCandidates(env.DB, runId, SHORTLIST_MAX_CANDIDATES);

  const seen = await findSeenUrls(env.DB, capped.map((c) => c.url));
  const unseen = capped.filter((c) => !seen.has(c.url));

  // Read once, not per candidate: this runs over up to
  // SHORTLIST_MAX_CANDIDATES rows inside the parent's own invocation.
  const tiers = sourceTiers();

  return unseen
    .map((candidate) => ({ candidate, score: relevanceScore(candidate, topic, tiers) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST_TOP_N)
    .map((r) => r.candidate);
}

/**
 * Chunks `shortlist` into `SUMMARIZE_ARTICLES_PER_CHILD`-sized groups and
 * creates one `SummarizeWorkflow` child per chunk (spec.md requirement 2,
 * extended 2026-08-31 (#75)). Deterministic ids (`${parentInstanceId}-s${index}`)
 * and duplicate-id recovery are `createChildBatch`'s job
 * (src/lib/workflow-children.ts) - the same idempotency-on-replay mechanism
 * `createGatherChildren` uses, generalized rather than copied when this
 * became the second caller.
 *
 * **The subrequest arithmetic `SUMMARIZE_ARTICLES_PER_CHILD` is sized
 * against** (wrangler.toml): `summarizeArticle` (src/summarize-workflow.ts)
 * costs one article `fetch` plus one `env.AI.run` call per candidate - two
 * Workers subrequests, the same "any fetch and any D1, KV or AI binding
 * call" rule `GATHER_FEEDS_PER_CHILD`'s comment cites. At
 * `SUMMARIZE_ARTICLES_PER_CHILD = 5` that floor is 10 of a child's 50 -
 * *more* margin than gather's 20-of-50, deliberately: an article's domain is
 * whatever the allowlist's feeds happen to link to that day, not a fixed,
 * previously-fetched RSS host, so it is more likely to redirect or be slow
 * than the 46-feed allowlist gather already has data on. At
 * `SHORTLIST_TOP_N = 15` this gives `ceil(15 / 5) = 3` children.
 *
 * **The parent's remaining invocation is counted in one place**, and it is no
 * longer here: `createPublishChildren`'s comment below carries it, because the
 * term this one used to argue about - `open-pull-request`'s 7 GitHub calls -
 * left the parent's invocation on 2026-09-01 (#75) and that is the change the
 * recount is anchored on. The figure this comment reached, ~29 fixed against a
 * measured 20 on run `0357f119`, is 23 there for that reason. What still
 * belongs here is only the half that concerns this function: `shortlist`'s 13
 * at 1,118 candidates is now the largest single term in the fixed cost and the
 * only one that follows the feed allowlist, and `SHORTLIST_MAX_CANDIDATES`'s
 * 4,000-row ceiling would make it 41 - spec.md's risk table records that
 * rather than tuning around it.
 *
 * **The neuron budget is split, not shared - and the split bounds slices,
 * not spend.** `availableBudget` (this function's own parameter, `run()`'s
 * `budget - neuronsSpent - SYNTHESIS_NEURON_RESERVE`) is divided across
 * children in proportion to how many candidates each chunk carries, so the
 * sum of every child's `neuronBudget` **slice** equals `availableBudget`
 * exactly. Children run concurrently with no shared state, so without this
 * split every child would see the *same* full `availableBudget` and their
 * combined spend could reach `availableBudget * childCount` - the split
 * closes that.
 *
 * It does not close the smaller overshoot the old single-loop gate always
 * had: each child's own gate (`runSummarize`, src/summarize-workflow.ts) is
 * a pre-flight check against `SUMMARY_NEURON_ESTIMATE`, an estimate, not the
 * call's real cost - a call that spends more than the estimate can carry a
 * child's own actual spend past its slice by that difference, same as the
 * old parent loop could overshoot the whole run's budget by at most one
 * article call. Splitting into children changes *how many times* that can
 * happen in one run - up to once per child (3, at the current config)
 * rather than once total - not whether it can happen at all. At the
 * measured ~1-2 neuron cost per map call against a 300-neuron estimate
 * (`SUMMARY_NEURON_ESTIMATE`'s own comment) this is nowhere near the budget
 * in practice; it is stated here so a future change to the estimate or the
 * model doesn't quietly rely on a bound that was never actually enforced.
 *
 * **A slice below `SUMMARY_NEURON_ESTIMATE` summarizes nothing, not
 * fewer.** The gate is `neuronsSpent + SUMMARY_NEURON_ESTIMATE >
 * neuronBudget`, checked before the *first* candidate too, so a child whose
 * slice never reaches the estimate breaks on iteration one. At this
 * config's default (`NEURON_BUDGET_PER_RUN = 6000`, `SHORTLIST_TOP_N = 15`,
 * 3 children) each slice is ~1,833 - far above the 300-neuron floor - but a
 * much smaller `NEURON_BUDGET_PER_RUN` could split into slices too thin for
 * any child to summarize even one article, where the old shared-budget loop
 * would have summarized a couple. Worth remembering before lowering that var.
 *
 * Returns child ids as plain strings, per plan.md's question 3 - the same
 * reason `createGatherChildren` does.
 */
export async function createSummarizeChildren(
  env: Env,
  parentInstanceId: string,
  shortlist: Candidate[],
  topic: Topic,
  availableBudget: number,
): Promise<string[]> {
  return createChildBatch(env.SUMMARIZE_WORKFLOW, summarizeChildOptions(env, parentInstanceId, shortlist, topic, availableBudget));
}

/**
 * The id-and-params derivation `createSummarizeChildren` creates from, split
 * out so `summarizeReplacement` below can recreate one child with the params
 * it was created with rather than with a recomputed near-miss. Pure and
 * deterministic in its inputs, which is what makes the two agree: the same
 * `availableBudget` reaches both from one expression in `run()`.
 */
function summarizeChildOptions(
  env: Env,
  parentInstanceId: string,
  shortlist: Candidate[],
  topic: Topic,
  availableBudget: number,
): { id: string; params: SummarizeParams }[] {
  const chunkSize = Number(env.SUMMARIZE_ARTICLES_PER_CHILD);
  const chunks: Candidate[][] = [];
  for (let i = 0; i < shortlist.length; i += chunkSize) chunks.push(shortlist.slice(i, i + chunkSize));

  const totalCandidates = shortlist.length;
  return chunks.map((chunk, index) => ({
    id: `${parentInstanceId}-s${index}`,
    params: {
      candidates: chunk,
      topic,
      neuronBudget: totalCandidates === 0 ? 0 : (availableBudget * chunk.length) / totalCandidates,
      index,
    } satisfies SummarizeParams,
  }));
}

/**
 * Subrequests the replacement mechanism may spend in the summarize poll loop
 * (spec.md requirement 4's narrowing, 2026-09-01 (#92)): one `createBatch`
 * for the replacement plus `SUMMARIZE_REPLACEMENT_POLL_ROUNDS` polls of it.
 * `floor(3 / (1 + 2))` is what makes it **one replacement per run** -
 * "once per child" bounds nothing useful, because three children could each
 * be replaced once.
 *
 * 3 is what the parent's ledger has: 46 of 50 pessimal
 * (`createPublishChildren`'s recount), four spare, and this takes it to 49.
 * And 3 is reachable rather than nominal: the round that *creates* the
 * replacement can itself still cost `childIds.length`, because its siblings
 * may be the ones that completed in that very round - only the rounds *after*
 * it are guaranteed to poll a single child.
 *
 * If the parent's fixed cost grows, this is the first thing that stops
 * fitting, and the honest answer then is that the allowance goes rather than
 * that the arithmetic is restated. `shortlist` is the term that grows.
 */
const SUMMARIZE_REPLACEMENT_SUBREQUEST_ALLOWANCE = 3;
/**
 * Extra poll rounds a replacement grants, on top of the cap
 * `SUMMARIZE_POLL_SUBREQUEST_BUDGET` derives. They have to be an explicit
 * grant rather than reclaimed slack, because there is no slack: a child has to
 * hang before it errors, so by the time the parent can see the error most of
 * the cap is spent. Run `54ce776b`'s child errored ~311 s in, which at 180 s
 * is round 1 of the three the cap allows - one round left, and zero if it
 * hangs any longer. A replacement swapped into `pending` with the cap
 * untouched gets whatever happens to remain, which is what makes the
 * mechanism dead code on the very run that motivated it.
 *
 * 2, because a from-scratch summarize child needs a full child duration -
 * 62-122 s measured on run `0357f119` - and at `SUMMARIZE_POLL_INTERVAL`'s
 * 180 s one round already covers that with margin. The second is the margin,
 * and it is affordable at one subrequest per round: 360 s against a measured
 * 122 s worst case.
 */
const SUMMARIZE_REPLACEMENT_POLL_ROUNDS = 2;

/**
 * The capability to replace a transiently-failed summarize child, handed to
 * `pollSummarizeChildren` and to no other poll loop (spec.md requirement 4's
 * narrowing; see `ChildReplacement`, src/lib/workflow-children.ts, for why the
 * asymmetry is structural rather than a comment - a summarize child writes
 * nothing outside its return value, and publish carries GitHub's 422).
 *
 * `${childId}r1` keeps the replacement's id deterministic, derived from the
 * `${parentInstanceId}-s${index}` scheme it replaces, so a replay of `run()`
 * recreates the *same* replacement rather than a fresh one per replay -
 * `createChildBatch`'s verified-against-reality already-exists tolerance is
 * what makes that idempotent. It is also why "never twice for the same child"
 * needs no extra guard against a replacement of a replacement: `-s0r1` is not
 * one of the ids `summarizeChildOptions` derives.
 *
 * **It re-spends what the dead child had already produced**, and that is a
 * priced cost rather than an overlooked one. The replacement receives the same
 * `neuronBudget` slice the original did, so a run with one replacement can
 * spend `availableBudget` plus one slice - ~1,833 of `NEURON_BUDGET_PER_RUN`'s
 * 6,000 at today's config, on a run that costs ~4,300. Run `54ce776b` threw
 * away three summaries' worth for nothing, which is the comparison.
 */
export function summarizeReplacement(
  env: Env,
  parentInstanceId: string,
  shortlist: Candidate[],
  topic: Topic,
  availableBudget: number,
): ChildReplacement {
  return {
    allowance: SUMMARIZE_REPLACEMENT_SUBREQUEST_ALLOWANCE,
    extraRounds: SUMMARIZE_REPLACEMENT_POLL_ROUNDS,
    create: async (childId) => {
      const original = summarizeChildOptions(env, parentInstanceId, shortlist, topic, availableBudget).find((o) => o.id === childId);
      if (original === undefined) throw new Error(`summarize child ${childId} has no create-time params to replace it with`);
      const [replacementId] = await createChildBatch(env.SUMMARIZE_WORKFLOW, [{ id: `${childId}r1`, params: original.params }]);
      if (replacementId === undefined) throw new Error(`summarize child ${childId} replacement was not created`);
      return replacementId;
    },
  };
}

/**
 * Poll interval for `await-summarize-children`. Deliberately a multiple of
 * `GATHER_POLL_INTERVAL`'s 30 s: `step.sleep` costs no subrequest, no step,
 * and no concurrency (`GATHER_POLL_INTERVAL`'s own comment), so lengthening
 * it is the cheap lever for wall-clock margin and does not touch the
 * subrequest arithmetic `SUMMARIZE_POLL_SUBREQUEST_BUDGET` sizes.
 *
 * It exists because gather's margin does not transfer: gather's 5 children
 * measured 5-8 s to converge (run `6f75e460`) against 2 rounds x 30 s = 60 s,
 * roughly 8x. A summarize child does a fetch to an arbitrary article domain
 * *and* a `gpt-oss-120b` call at `MAP_MAX_TOKENS = 4096` per candidate,
 * neither of which this repo has measured the latency of - a reasoning
 * model at that ceiling taking 10-30 s per call is not a pessimistic guess.
 * At 30 s intervals, 5 candidates/child x up to ~30 s each could approach or
 * exceed the poll allowance on its own, before any redirect or slow
 * article. 60 s keeps the round count `SUMMARIZE_POLL_SUBREQUEST_BUDGET`
 * derives unchanged while roughly doubling the wall-clock each round buys -
 * criterion 2's five consecutive runs are what actually settles whether
 * this margin is enough, not this arithmetic.
 *
 * **60 s -> 90 s on 2026-09-01 (#75), because the round count came down.**
 * Run `0357f119`'s three children took between 62 s and 122 s to converge, so
 * the 10-30 s-per-call estimate above was the right order of magnitude. But
 * `SUMMARIZE_POLL_SUBREQUEST_BUDGET` now allows three rounds rather than
 * five, and at 60 s that would have shortened the slowest child this loop
 * tolerates from ~240 s to ~180 s - a 1.2x margin over the 150 s worst case
 * the paragraph above sizes against, where it used to be 1.6x. Lengthening
 * the interval is what gives that back: 90/180/270 s costs exactly the same
 * three subrequests per round, and round 0 at 90 s can now catch the measured
 * convergence outright where 60 s never could. The interval is the free
 * lever and the round count is the dear one, so spend the free one.
 *
 * **90 s -> 180 s on 2026-09-02 (#92), spending the free lever again.** The
 * round cap was corrected to count the poll it throws in (`pollChildBatch`,
 * src/lib/workflow-children.ts), which takes this loop from four polls to
 * three and its pessimal bill from 12 subrequests to the 9 the ledger always
 * claimed. 180 s buys the dropped round's wall-clock back and more: the loop
 * now reaches 540 s where four rounds at 90 s reached 360 s. That matters for
 * requirement 4's narrowing specifically, and it is what makes it live code
 * rather than dead code. On run `54ce776b`'s own timeline the summarize
 * children were created at ~18:33:23 and the transient surfaced at 18:38:34,
 * i.e. **~311 s** in: three polls at 90/180/270 s never see it and the run
 * dies on the cap instead, where 180/360/540 s see it at round 1 and leave
 * rounds 2-4 for the replacement. Round 0 at 180 s also now catches the
 * measured 62-122 s convergence outright, which is why the typical bill falls
 * to 3 as well.
 *
 * **The 15-minute cron cap does not reach this**, which is what makes
 * wall-clock the free lever here rather than merely the cheap one: `scheduled()`
 * awaits `RESEARCH_WORKFLOW.create()` and returns (src/index.ts), so the cap
 * is charged against that handler, not against the run. Worth stating because
 * this loop's worst case - three base polls to 540 s plus two granted rounds
 * to 900 s - now exceeds 15 minutes on its own, where at 90 s it did not.
 */
const SUMMARIZE_POLL_INTERVAL = '180 seconds';
/**
 * The poll backstop is a subrequest budget, not a round count
 * (`pollChildBatch`'s own comment) - see `createSummarizeChildren`'s
 * arithmetic for why this is a single-figure share of the parent's 50 rather
 * than a third of it.
 *
 * **Reduced from 15 to 9 on 2026-09-01 (#75).** 15 allowed `floor(15 / 3) =
 * 5` rounds and was sized when nothing about a summarize child's latency had
 * been measured. Run `0357f119` measured it: three children created at
 * 13:57:17 were still running when polled 62 s later and were complete when
 * polled at 122 s. With the loop now waiting before each poll and
 * `SUMMARIZE_POLL_INTERVAL` at 90 s, rounds land at 90 s, 180 s and 270 s, so
 * `floor(9 / 3) = 3` covers that measured window twice over - round 0 may
 * catch it and round 1 must - rather than holding five rounds of headroom
 * against a guess. The wall-clock the dropped rounds would have bought is
 * bought back by the interval instead, which costs nothing.
 *
 * The reduction is not optional slack, either: the ~29 fixed subrequests in
 * force when it was made left ~21 for both poll loops, and the old 10 + 15 =
 * 25 never fitted inside that. Run `0357f119` spent 19 of them and died in
 * `open-pull-request`. Publication leaving the parent later the same day took
 * the fixed cost to 23 (`createPublishChildren`'s recount) and so gave the
 * 15 back on paper - it is not taken back, because the reason this is 9 is the
 * measured 62-122 s convergence above, not the room there happens to be.
 *
 * **Held at 9 on 2026-09-02 (#92), and re-costed rather than re-tuned.** The
 * cap derivation was corrected to count the poll it throws in, so 9 now buys
 * `max(2, floor(9 / 3)) = 3` polls costing exactly 9 where it used to buy
 * four costing 12. That correction is what pays for requirement 4's
 * narrowing: it returns the 3 subrequests
 * `SUMMARIZE_REPLACEMENT_SUBREQUEST_ALLOWANCE` spends, so the parent's
 * pessimal total goes 46 -> 49 rather than 55 -> 58. The dropped round's
 * wall-clock is bought back by `SUMMARIZE_POLL_INTERVAL` instead, which costs
 * nothing.
 */
const SUMMARIZE_POLL_SUBREQUEST_BUDGET = 9;

/**
 * One `await-summarize-children` round: reads the `status()` of every child
 * still pending via `pollChildBatch` (src/lib/workflow-children.ts), then
 * combines every child's validated output once the last one lands.
 * `InstanceStatus.output` is typed `unknown` - `validateSummarizeOutput`
 * below checks it rather than casting it. A child that is `errored` or
 * `terminated` fails this step immediately (spec.md requirement 4). While any
 * child is still incomplete, this returns the state the next round resumes
 * from, which carries the summaries the finished children already returned.
 *
 * **The one loop that carries a `ChildReplacement`** (spec.md requirement 4's
 * narrowing, 2026-09-01 (#92)): a child that errored with a recognised
 * transient platform class is replaced once instead of failing the run.
 * `replace` is a required parameter rather than an optional one so a caller
 * cannot silently drop the capability - `pollGatherChildren` and
 * `pollPublishChildren` pass none, which is what keeps the mechanism absent
 * from those loops rather than merely unused.
 */
export async function pollSummarizeChildren(
  env: Env,
  childIds: string[],
  state: SummarizePollState,
  round: number,
  replace: ChildReplacement,
): Promise<SummarizePollResult> {
  const outcome = await pollChildBatch(
    env.SUMMARIZE_WORKFLOW,
    childIds,
    state,
    round,
    SUMMARIZE_POLL_SUBREQUEST_BUDGET,
    'summarize',
    validateSummarizeOutput,
    (children) => ({
      summaries: children.flatMap((child) => child.summaries),
      neuronsSpent: children.reduce((total, child) => total + child.neuronsSpent, 0),
    }),
    replace,
  );
  return outcome.done ? { done: true, ...outcome.result } : outcome;
}

function isArticleSummary(v: unknown): v is ArticleSummary {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.url === 'string' &&
    typeof o.title === 'string' &&
    typeof o.summary === 'string' &&
    typeof o.relevance === 'number' &&
    Array.isArray(o.claims) &&
    o.claims.every((c) => typeof c === 'string') &&
    (o.attributablePractice === null || typeof o.attributablePractice === 'string')
  );
}

/** `InstanceStatus.output` is `unknown` - this is what actually enforces a summarize child's "returns its summaries and neuron spend" contract, per plan.md's question 3 ("validates rather than casts"), the same rule `validateGatherOutput` applies to a gather child's count. */
function validateSummarizeOutput(output: unknown, childId: string): SummarizeChildOutput {
  if (typeof output !== 'object' || output === null) {
    throw new Error(`summarize child ${childId} returned a non-object output`);
  }
  const o = output as Record<string, unknown>;
  if (!Array.isArray(o.summaries) || !o.summaries.every(isArticleSummary)) {
    throw new Error(`summarize child ${childId} returned a malformed summaries array`);
  }
  if (typeof o.neuronsSpent !== 'number' || !Number.isFinite(o.neuronsSpent) || o.neuronsSpent < 0) {
    throw new Error(`summarize child ${childId} returned a non-count neuronsSpent`);
  }
  return { summaries: o.summaries, neuronsSpent: o.neuronsSpent };
}

/**
 * Creates the run's single `PublishWorkflow` child (spec.md requirement 2,
 * extended 2026-09-01 (#75)), so `open-pull-request`'s seven GitHub calls are
 * spent in a fresh 50-subrequest budget rather than in whatever the parent has
 * left. Run `0357f119` is why: it reached that step with `synthesize` already
 * done and a real draft in hand, and failed on the platform's own `Too many
 * subrequests by single Worker invocation.`
 *
 * **One child, and therefore no chunk size.** A run publishes one draft, so
 * unlike `GATHER_FEEDS_PER_CHILD` and `SUMMARIZE_ARTICLES_PER_CHILD` there is
 * no per-child workload to cap and `wrangler.toml` gains no var. The one-element
 * array is still `createChildBatch`'s shape rather than a bare `create()`: the
 * duplicate-id-verified-against-reality mechanism that makes this idempotent on
 * replay (`run()` re-executes from the top - spec.md fact 2) is worth more than
 * the array wrapper costs, and `pollChildBatch` on the other side wants an id
 * list either way.
 *
 * **What the child is handed, and why it fits.** A whole `Draft`, via
 * `PublishParams` - see that type's doc comment for the 1 MiB event-payload
 * limit this sits two orders of magnitude under, and for why every field is
 * either fixed-size or capped by `SHORTLIST_TOP_N` rather than growing with
 * the allowlist.
 *
 * **The parent's remaining invocation, recounted 2026-09-01 (#75) with
 * publication gone too.** Taking run `0357f119`'s measured terms and removing
 * the one this PR moves: `start-run` + `select-topic` (~3 D1 calls) +
 * `load-sources` (0) + `create-gather-children` (2) + `shortlist` (**13** at
 * that run's 1,118 candidates: one `readRunCandidates` plus `ceil(1118 / 100) =
 * 12` `findSeenUrls` chunks) + `create-summarize-children` (1) + `synthesize`
 * (1 AI call) + `create-publish-children` (1) + `record-success` (2) = **23
 * fixed**, where it was ~29 with `open-pull-request`'s 7 in it. On the typical
 * poll shape - 5 for a gather round that finds all five children complete
 * (measured 5-8 s against a 30 s wait), 3 for a summarize round that finds all
 * three complete (measured 62-122 s against `SUMMARIZE_POLL_INTERVAL`'s 180 s)
 * and 1 for a publish round that lands past a child measured in seconds - the
 * parent spends about **32 of 50**, against the ~48 that killed `0357f119`.
 * It was ~35 before the poll cap was corrected below and the summarize
 * interval lengthened to catch that convergence in round 0.
 *
 * The pessimal figure is worth stating too, because it is what the backstops
 * actually permit: 23 fixed plus every poll budget exhausted
 * (`GATHER_POLL_SUBREQUEST_BUDGET` 10 + `SUMMARIZE_POLL_SUBREQUEST_BUDGET` 9 +
 * `PUBLISH_POLL_SUBREQUEST_BUDGET` 4) is **46 of 50**, which fits where 29 +
 * 10 + 9 would not have. Four spare is not margin, and that is deliberate: the
 * backstops are there to fail loudly before the platform does, and a run
 * reaching all three of them has a worse problem than four subrequests.
 *
 * **Those three budgets only became the parent's real bill on 2026-09-02
 * (#92).** `pollChildBatch`'s cap counted rounds *before* the one it throws
 * in, which polls once more than the budget pays for: 10 + 9 + 4 was really
 * 15 + 12 + 5, so this paragraph's 46 was **55 of 50** and the backstops
 * could not fire before the platform's own subrequest error did. The
 * derivation was corrected there rather than the numbers restated here - see
 * that function's comment for the arithmetic and for what each loop's poll
 * count becomes.
 *
 * **Requirement 4's narrowing spends three of the four spare**, and that is
 * the whole of what it costs the parent:
 * `SUMMARIZE_REPLACEMENT_SUBREQUEST_ALLOWANCE` is 1 create plus 2 polls of the
 * replacement, taking the pessimal total to **49 of 50, one spare**. The
 * replacement's polls cost one subrequest each rather than three because a
 * replacement is only ever created when the failed child is the last one not
 * complete (`isReplaceable`, src/lib/workflow-children.ts).
 *
 * **`shortlist` is still the term that grows and still is not mitigated.** It
 * was 4 at run `6f75e460`'s 264 candidates and 13 at `0357f119`'s 1,118 five
 * days later; D1 caps a statement at 100 bound parameters, so `ceil(candidates
 * / 100)` is a floor set by the platform rather than a knob here. With
 * publication moved out, it is now the largest single term in the 23 and the
 * only one that follows the feed allowlist - spec.md's risk table records that
 * rather than tuning around it.
 */
export async function createPublishChildren(env: Env, parentInstanceId: string, draft: Draft): Promise<string[]> {
  return createChildBatch(env.PUBLISH_WORKFLOW, [
    { id: `${parentInstanceId}-p0`, params: { draft } satisfies PublishParams },
  ]);
}

/**
 * Poll cadence for `await-publish-children`. Shorter than either of the other
 * two because the work is shorter: a publish child makes seven sequential
 * GitHub REST calls and nothing else - no feed parse, no model call - so its
 * convergence is gather's order of magnitude (5-8 s, run `6f75e460`) rather
 * than summarize's (62-122 s, run `0357f119`). 15 s is the wait-first
 * ordering's whole point applied to that: round 0 lands past a child measured
 * in single-digit seconds instead of a second after `createBatch`.
 *
 * Not measured for *this* child, which has never run - it is the same
 * seven calls `open-pull-request` made in the parent, which no capture times
 * individually. Acceptance criterion 2's five runs are what settle it, and the
 * round count below is sized so a wrong guess here costs rounds rather than
 * the run.
 */
const PUBLISH_POLL_INTERVAL = '15 seconds';
/**
 * The poll backstop is a subrequest budget, not a round count
 * (`pollChildBatch`'s own comment) - but at **one** child the two coincide:
 * `max(2, floor(budget / childCount))` divides by 1, so this number *is* the
 * poll count, and since the corrected cap counts the poll it throws in, it is
 * also literally this loop's subrequest bill. That makes it the cheapest of
 * the three backstops per round of tolerance bought, which is why 4 polls cost
 * 4 subrequests here where summarize's 3 cost 9.
 *
 * 4 rather than more: 23 fixed subrequests (`createPublishChildren`'s recount)
 * plus gather's 10 and summarize's 9 leaves 8, and taking half of it keeps a
 * few spare for the redirects the arithmetic cannot see. 4 rounds at
 * `PUBLISH_POLL_INTERVAL` covers 60 s against a child expected to finish in
 * seconds - generous rather than tight, and the interval is the free lever if
 * that turns out wrong (`SUMMARIZE_POLL_INTERVAL`'s comment has the argument).
 */
const PUBLISH_POLL_SUBREQUEST_BUDGET = 4;

/**
 * One `await-publish-children` round, via `pollChildBatch`
 * (src/lib/workflow-children.ts). One child, so a round costs one subrequest
 * and `combine` receives a one-element array - `[url]` destructured rather
 * than joined, because there is nothing to aggregate. A child that is
 * `errored` or `terminated` fails this step immediately, which is what makes a
 * failed publication a failed run rather than a `runs` row claiming success
 * with a null `pr_url` (spec.md requirement 4).
 */
export async function pollPublishChildren(
  env: Env,
  childIds: string[],
  state: PublishPollState,
  round: number,
): Promise<PublishPollResult> {
  const outcome = await pollChildBatch(
    env.PUBLISH_WORKFLOW,
    childIds,
    state,
    round,
    PUBLISH_POLL_SUBREQUEST_BUDGET,
    'publish',
    validatePublishOutput,
    ([url]) => url ?? '',
  );
  return outcome.done ? { done: true, prUrl: outcome.result } : outcome;
}

/**
 * `InstanceStatus.output` is `unknown` - this is what actually enforces a
 * publish child's "returns the pull request URL" contract, per plan.md's
 * question 3 ("validates rather than casts"), the same rule
 * `validateGatherOutput` applies to a gather child's count.
 *
 * Non-empty is the substance of it: `githubOpenPullRequest` returns GitHub's
 * own `html_url`, so an empty string means the child completed without ever
 * reaching a pull request, and letting that through would write a `runs` row
 * with `status = 'succeeded'` and a blank `pr_url` - exactly the outcome
 * acceptance criterion 2 is stated against.
 */
function validatePublishOutput(output: unknown, childId: string): string {
  if (typeof output !== 'string' || output === '') {
    throw new Error(`publish child ${childId} returned no pull request URL`);
  }
  return output;
}

/** kebab-case, ASCII-only, matching mdx.ts's `SLUG_RE`. Falls back to a topic-id-based slug if a title yields nothing usable. */
function slugify(title: string, fallbackId: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return slug === '' ? `research-topic-${fallbackId}` : slug;
}

const MAX_PARSE_FAILURE_KEYS = 20;
const MAX_PARSE_FAILURE_KEY_LENGTH = 40;

/**
 * Renders a parse failure as safe structural metadata only - the response
 * text, article text, prompt text and URLs are never allowed into an error
 * message that reaches the trace (CLAUDE.md's observability rule), so this
 * reports only the failure reason, the response length, and (when the text
 * parsed to an object) the top-level key *names* the model actually sent.
 * Key names are themselves model-controlled text, so they are capped and
 * truncated rather than trusted to be short.
 */
function describeParseFailure(reason: ReduceParseFailure, textLength: number, keys?: readonly string[]): string {
  const parts = [`reason=${reason}`, `length=${textLength}`];
  if (keys !== undefined) {
    const shown = keys
      .slice(0, MAX_PARSE_FAILURE_KEYS)
      .map((k) => (k.length > MAX_PARSE_FAILURE_KEY_LENGTH ? `${k.slice(0, MAX_PARSE_FAILURE_KEY_LENGTH)}…` : k));
    const overflow = keys.length > MAX_PARSE_FAILURE_KEYS ? `,+${keys.length - MAX_PARSE_FAILURE_KEYS} more` : '';
    parts.push(`keys=[${shown.join(',')}${overflow}]`);
  }
  return parts.join(' ');
}

/**
 * One `Llm` call producing the draft's model-authored fields (title,
 * description, tags, body), applying the `blog-voice` rules embedded in
 * `src/lib/prompts.ts` - including the `OPENING INCIDENT: needs a real
 * example` marker instruction, asked for in MDX comment syntax rather than
 * HTML because MDX v3 rejects the latter and the blog's build fails on it
 * (#96; the literal delimiters are omitted here only because they would end
 * this comment). Never invents a war story: that
 * instruction is the single most important rule in the skill, and nothing
 * here gives the model room to originate one - see prompts.ts's
 * REDUCE_SYSTEM_PROMPT.
 *
 * `slug`, `date`, `authors`, `draft` and the source list are computed here
 * in TypeScript, never asked of the model: this is also what makes
 * `openPullRequest`'s branch name deterministic across a retry (see its own
 * comment) - `date` is fixed once, at the point `synthesizeDraft`'s
 * `step.do` result is first cached, and never recomputed afterwards.
 */
export async function synthesizeDraft(
  env: Env,
  topic: Topic,
  summaries: ArticleSummary[],
): Promise<{ draft: Draft; neurons: number }> {
  const llm = createLlm(env);
  const result = await llm.complete({
    messages: buildReduceMessages(topic, summaries),
    maxTokens: SYNTHESIS_MAX_TOKENS,
  });
  const neurons = neuronsFor(result);

  if (result.finishReason === 'length') {
    throw new Error(`synthesizeDraft: completion truncated at maxTokens=${SYNTHESIS_MAX_TOKENS} before the draft finished`);
  }

  const parsed = parseReduceResponse(result.text);
  if (!parsed.ok) {
    const detail = describeParseFailure(parsed.reason, result.text.length, parsed.keys);
    throw new Error(`synthesizeDraft: model response was not valid JSON in the expected shape (${detail})`);
  }
  const draftFields = parsed.value;

  const draft: Draft = {
    slug: slugify(draftFields.title, topic.id),
    title: draftFields.title,
    description: draftFields.description,
    date: new Date().toISOString().slice(0, 10),
    authors: ['nimeshjm'],
    tags: draftFields.tags,
    draft: true,
    brief: renderBrief(topic, summaries),
    // REDUCE_SYSTEM_PROMPT asks for markdown-link citations but a prompt is a
    // request, not a guarantee - a production completion (#75) cited every
    // source as a bracket-wrapped bare URL instead, so this makes the shape
    // deterministic rather than hoped-for.
    body: normaliseCitations(draftFields.body, summaries),
    sources: summaries.map((s) => s.url),
  };

  return { draft, neurons };
}

/** The pull request body: deterministic, never model-authored, so a source link can never be hallucinated (spec.md req. 7). */
function renderBrief(topic: Topic, summaries: ArticleSummary[]): string {
  const lines = [`# Research brief: ${topic.title}`, ''];
  if (topic.angle !== null) lines.push(`**Angle:** ${topic.angle}`, '');
  lines.push('## Sources', '');
  for (const s of summaries) {
    const practice = s.attributablePractice ?? 'commentary';
    lines.push(`- [${s.title}](${s.url}) — ${practice}`);
  }
  return lines.join('\n');
}

async function recordOutcome(
  env: Env,
  instanceId: string,
  outcome: {
    status: RunOutcome['status'];
    topicId?: number;
    sourcesUsed?: number;
    neuronsSpent: number;
    prUrl?: string | null;
  },
): Promise<void> {
  // INSERT ... ON CONFLICT(instance_id) DO UPDATE, keyed on the Workflow
  // instance id: spec requirement 9 wants exactly one row per run whatever
  // the outcome, and every record-* step above is retried like any other.
  await recordRunOutcome(env.DB, {
    instanceId,
    topicId: outcome.topicId ?? null,
    status: outcome.status,
    neuronsSpent: outcome.neuronsSpent,
    sourcesUsed: outcome.sourcesUsed ?? 0,
    prUrl: outcome.prUrl ?? null,
  });

  // `run_candidates` is per-run scratch, not a second cross-run dedupe key -
  // `seen_urls` stays the only one. Every terminal path (record-no-topic,
  // record-no-sources, record-no-summaries, record-success) routes through
  // this function, so pruning here covers all of them without a new step.
  //
  // The order matters and no test covers it: retention runs *after* the
  // outcome write, never before. Reversed, a prune that threw would fail the
  // step before the row existed, and spec req. 10's "every run writes a runs
  // row, including one that dies mid-step" would quietly become "unless the
  // prune threw". This way the step retries with the row already written and
  // `recordRunOutcome`'s ON CONFLICT rewrites it identically.
  await pruneRunCandidates(env.DB, RUN_CANDIDATE_RETENTION_DAYS);
}
