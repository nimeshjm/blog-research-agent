import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { ArticleSummary, Candidate, Draft, Env, ResearchParams, Source, Topic } from './lib/types';
import {
  ATTR_NEURONS_BUDGET,
  ATTR_NEURONS_SPENT,
  ATTR_RUN_STATUS,
  ATTR_SOURCES_GATHERED,
  ATTR_SOURCES_SHORTLISTED,
  ATTR_SOURCES_USED,
  ATTR_TOPIC_ID,
  tracerFor,
} from './lib/trace';

/**
 * The research pipeline.
 *
 * Structured as a Workflow rather than a plain cron handler because the free
 * plan gives 10 ms of CPU per *invocation* and 15 minutes of wall-clock for a
 * whole cron run, whereas a Workflow gets 10 ms of CPU per *step* with no
 * wall-clock cap. Parsing ~46 feeds and ~15 articles cannot fit in one 10 ms
 * budget, so each fetch-and-parse is its own step.
 *
 * Every step body must be idempotent: Workflows retry steps on failure.
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

    // 1. Queue first; the agent proposes a topic only when the queue is empty.
    // `agent.topic.id` is only known once the call returns, so it is set on
    // the span handed to the body rather than passed in as an attr.
    const topic = await traceStep('select-topic', {}, async (span) => {
      const result = await selectTopic(this.env, event.payload.topicId);
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
          return recordOutcome(this.env, { status: 'no_topic', neuronsSpent });
        },
      );
      return;
    }

    // 2. One step per feed. 50 subrequests per step on the free plan, so a
    //    single feed fetch per step leaves generous headroom for redirects.
    //    Parsing only - dedupe is batched in `shortlist`, because a per-item
    //    seen_urls query would blow both the 10 ms CPU and the 50-query budget.
    //    Each gather applies GATHER_WINDOW_DAYS before returning. That is not
    //    tuning: most of the allowlist is whole archives rather than rolling
    //    feeds, and unwindowed they put 4,742 candidates into `shortlist`,
    //    whose chunked seen_urls batch would then need 48 of D1's 50 queries
    //    per invocation. Windowed it is 678 candidates and 7 queries.
    const sources = await traceStep('load-sources', {}, async () => loadSources(this.env));

    const candidates: Candidate[] = [];
    for (const source of sources) {
      // `agent.step` on this span is the `gather` prefix, not the full step
      // name - `tracedStep` strips after the first `:` so a per-feed span
      // never needs a source name judged sensitive enough to redact by hand.
      const found = await traceStep(`gather:${source.name}`, {}, async (span) => {
        const result = await gatherCandidates(source);
        span.setAttribute(ATTR_SOURCES_GATHERED, result.length);
        return result;
      });
      candidates.push(...found);
    }

    // Batched dedupe against seen_urls happens here, in one query.
    const shortlist = await traceStep('shortlist', {}, async (span) => {
      const result = await shortlistCandidates(this.env, candidates, topic);
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
          return recordOutcome(this.env, {
            status: 'insufficient_sources',
            topicId: topic.id,
            neuronsSpent,
          });
        },
      );
      return;
    }

    // 3. Map: one step per article. Keeps each parse inside its own CPU budget
    //    and bounds spend per article rather than per run. The budget check is
    //    between calls, so a run may overshoot by at most one article call.
    const summaries: ArticleSummary[] = [];
    for (const candidate of shortlist) {
      if (neuronsSpent + SUMMARY_NEURON_ESTIMATE > budget - SYNTHESIS_NEURON_RESERVE) break;

      // `agent.step` on this span is the `summarize` prefix. `candidate.url`
      // stays out of every span attribute - REVIEW.md pass 2 forbids a URL
      // there - even though it still passes through to step.do unchanged,
      // because that is the replay key.
      const result = await traceStep(`summarize:${candidate.url}`, {}, async () => {
        return summarizeArticle(this.env, candidate, topic);
      });
      neuronsSpent += result.neurons;
      if (result.summary !== null) summaries.push(result.summary);
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
          return recordOutcome(this.env, {
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

    // 5. Branch-only write. The agent never pushes to BLOG_BASE_BRANCH.
    const prUrl = await traceStep('open-pull-request', {}, async () => {
      return openPullRequest(this.env, synthesis.draft);
    });

    await traceStep(
      'record-success',
      {
        [ATTR_SOURCES_USED]: summaries.length,
        [ATTR_NEURONS_SPENT]: neuronsSpent,
        [ATTR_NEURONS_BUDGET]: budget,
        [ATTR_RUN_STATUS]: 'succeeded',
      },
      async () => {
        return recordOutcome(this.env, {
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

function isGrounded(summaries: ArticleSummary[]): boolean {
  const practices = summaries.filter((s) => s.attributablePractice !== null);
  return summaries.length >= MIN_SOURCES && practices.length >= MIN_PRACTICES;
}

/** Conservative per-article and synthesis estimates used for the budget gate. */
const SUMMARY_NEURON_ESTIMATE = 300;
const SYNTHESIS_NEURON_RESERVE = 1000;

/**
 * Discovery bounds. They exist because D1 allows 100 bound parameters per query
 * and 50 queries per invocation, and `shortlist` checks every candidate against
 * `seen_urls` in one batched pass. See spec.md, "The recency window in
 * `gather`".
 *
 * The window is what the agent is for - it reports on recent work, not on
 * archives - and the D1 arithmetic wants the same rule for its own reasons.
 *
 * There is deliberately no per-feed cap on *dated* items. arXiv publishes a
 * whole day at once - cs.AI carries 352 items, cs.SE 62, all inside the window -
 * and truncating that would starve the grounding gate of the papers it exists to
 * find. The date window bounds the common case; SHORTLIST_MAX_CANDIDATES bounds
 * a feed that dumps its archive with fresh timestamps.
 */
const GATHER_WINDOW_DAYS = 30;
/** Backstop for items with no parseable date only. Zero such items today. */
const GATHER_UNDATED_MAX_PER_FEED = 20;
/** Newest-first ceiling: 40 of D1's 50 queries, ten spare. */
const SHORTLIST_MAX_CANDIDATES = 4000;

// ---------------------------------------------------------------------------
// Step bodies. Implemented in feature 001's build stage; see
// features/001-scheduled-research-drafts/plan.md.
//
// Each inference-bearing step returns its neuron cost alongside its result so
// the caller can enforce NEURON_BUDGET_PER_RUN between steps.
// ---------------------------------------------------------------------------

function notImplemented(what: string): never {
  throw new Error(`NotImplemented: ${what}`);
}

async function selectTopic(_env: Env, _topicId: number | undefined): Promise<Topic | null> {
  // Dedupe must cover BOTH the published feed and `draft: true` posts in the blog
  // repo - drafts are absent from the feed, so a feed-only check proposes topics
  // that are already half-written. See spec requirement 3.
  return notImplemented('selectTopic - drain the queue, else propose vs feed + repo drafts');
}

async function loadSources(_env: Env): Promise<Source[]> {
  return notImplemented('loadSources - read the approved RSS/Atom allowlist');
}

async function gatherCandidates(_source: Source): Promise<Candidate[]> {
  // Apply GATHER_WINDOW_DAYS here, in the per-feed step, never in `shortlist` -
  // the point is to bound the candidate count before it is aggregated across 46
  // feeds. Dated items are filtered by date, never truncated by rank;
  // GATHER_UNDATED_MAX_PER_FEED applies only to items carrying no parseable date.
  void GATHER_WINDOW_DAYS;
  void GATHER_UNDATED_MAX_PER_FEED;
  return notImplemented('gatherCandidates - fetch one feed, window it, parse with HTMLRewriter, no D1');
}

async function shortlistCandidates(
  _env: Env,
  _candidates: Candidate[],
  _topic: Topic,
): Promise<Candidate[]> {
  // Take the newest SHORTLIST_MAX_CANDIDATES *before* touching D1: the batch is
  // chunked at 100 bound params per query against a 50-query invocation budget.
  void SHORTLIST_MAX_CANDIDATES;
  return notImplemented(
    'shortlistCandidates - cap at 4,000, seen_urls in chunks of 100 params, rank, cap at 15',
  );
}

async function summarizeArticle(
  _env: Env,
  _candidate: Candidate,
  _topic: Topic,
): Promise<{ summary: ArticleSummary | null; neurons: number }> {
  return notImplemented('summarizeArticle - fetch, extract text, one LLM call, report neurons');
}

async function synthesizeDraft(
  _env: Env,
  _topic: Topic,
  _summaries: ArticleSummary[],
): Promise<{ draft: Draft; neurons: number }> {
  return notImplemented('synthesizeDraft - brief + draft, applying the blog-voice skill');
}

async function openPullRequest(_env: Env, _draft: Draft): Promise<string> {
  // Writes src/content/blog/<slug>/index.mdx on a research/* branch. Validate
  // frontmatter against src/content.config.ts first; never emit an `image` key
  // (the Astro image() helper needs a real file, so it would break the build).
  return notImplemented('openPullRequest - validate vs content.config.ts, branch-only');
}

async function recordOutcome(
  _env: Env,
  _outcome: {
    status: string;
    topicId?: number;
    sourcesUsed?: number;
    neuronsSpent: number;
    prUrl?: string | null;
  },
): Promise<void> {
  return notImplemented('recordOutcome - insert into runs');
}
