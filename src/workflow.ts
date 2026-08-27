import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { claimOldestQueuedTopic, claimTopicById, findOrProposeTopic, findSeenUrls, recordRunOutcome } from './lib/d1';
import { applyGatherWindow, parseFeed } from './lib/feed';
import { loadFeeds } from './lib/feeds';
import { listBlogPostSlugs } from './lib/github';
import type { ArticleSummary, Candidate, Draft, Env, FeedItem, ResearchParams, RunOutcome, Source, Topic } from './lib/types';
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
          return recordOutcome(this.env, event.instanceId, { status: 'no_topic', neuronsSpent });
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
          return recordOutcome(this.env, event.instanceId, {
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
export const GATHER_WINDOW_DAYS = 30;
/** Backstop for items with no parseable date only. Zero such items today. */
export const GATHER_UNDATED_MAX_PER_FEED = 20;
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
// Step bodies. Implemented in feature 001's build stage; see
// features/001-scheduled-research-drafts/plan.md.
//
// Each inference-bearing step returns its neuron cost alongside its result so
// the caller can enforce NEURON_BUDGET_PER_RUN between steps.
// ---------------------------------------------------------------------------

function notImplemented(what: string): never {
  throw new Error(`NotImplemented: ${what}`);
}

export async function selectTopic(env: Env, topicId: number | undefined): Promise<Topic | null> {
  // A manually-targeted run (event.payload.topicId set) claims that specific
  // row rather than draining the queue - see ResearchParams in lib/types.ts.
  if (topicId !== undefined) {
    return claimTopicById(env.DB, topicId);
  }

  const queued = await claimOldestQueuedTopic(env.DB);
  if (queued !== null) return queued;

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

  return findOrProposeTopic(env.DB, proposal);
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

async function fetchFeedItems(feedUrl: string): Promise<FeedItem[]> {
  try {
    const response = await fetch(feedUrl);
    if (!response.ok) return [];
    return await parseFeed(response);
  } catch {
    return [];
  }
}

async function fetchFeedTitles(feedUrl: string): Promise<string[]> {
  const items = await fetchFeedItems(feedUrl);
  return items.map((i) => i.title);
}

/**
 * One fetch, streamed parse (src/lib/feed.ts), no D1. The 30-day window and
 * the undated-item cap are applied here, per feed, never in `shortlist` -
 * see GATHER_WINDOW_DAYS / GATHER_UNDATED_MAX_PER_FEED above and spec.md,
 * "The recency window in `gather`". A feed that cannot be fetched or fails
 * to parse contributes zero candidates rather than failing the step: one
 * dead feed must not fail the run (spec.md risk table), and a feed that
 * consistently returns nothing is a review finding against the allowlist,
 * visible via `agent.sources.gathered` on the step's own span.
 */
export async function gatherCandidates(source: Source): Promise<Candidate[]> {
  const items = await fetchFeedItems(source.feedUrl);
  const windowed = applyGatherWindow(items, {
    windowDays: GATHER_WINDOW_DAYS,
    undatedMax: GATHER_UNDATED_MAX_PER_FEED,
  });
  return windowed.map((item) => ({ ...item, sourceName: source.name }));
}

/** Sort key for "newest first": undated items sort last, so they are the first the SHORTLIST_MAX_CANDIDATES ceiling drops. */
function dateKey(publishedAt: string | null): number {
  if (publishedAt === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(publishedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
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
 * Heuristic relevance score against `topic`. Takes no `Ai` binding by
 * design (spec.md: inference happens in exactly two places, and ranking is
 * not one of them, which is what keeps the feed count invariant to the
 * neuron bill). Word overlap with the topic's title/angle, nudged toward
 * material carrying an attributable practice or finding over commentary
 * (spec.md -> Inference: "Ranking in shortlist should therefore favour
 * material that carries an attributable practice or finding over
 * commentary").
 */
function relevanceScore(candidate: Candidate, topic: Topic): number {
  const topicWords = new Set([...tokenize(topic.title), ...tokenize(topic.angle ?? '')]);
  const candidateWords = tokenize(candidate.title);
  let overlap = 0;
  for (const word of candidateWords) if (topicWords.has(word)) overlap++;

  let score = overlap;
  if (PRACTICE_SIGNAL_RE.test(candidate.title)) score += 2;
  if (COMMENTARY_SIGNAL_RE.test(candidate.title)) score -= 1;
  return score;
}

/**
 * Newest-first cap at SHORTLIST_MAX_CANDIDATES *before* touching D1 (D1
 * caps a query at 100 bound params and an invocation at 50 queries), then
 * the batched `seen_urls` dedupe (`findSeenUrls`, chunked at 100 params -
 * `d1.ts` owns that chunking, not reimplemented here), then heuristic
 * ranking against `topic`, then a cap of SHORTLIST_TOP_N. See spec.md, "The
 * aggregate ceiling in `shortlist`".
 */
export async function shortlistCandidates(env: Env, candidates: Candidate[], topic: Topic): Promise<Candidate[]> {
  const capped = [...candidates].sort((a, b) => dateKey(b.publishedAt) - dateKey(a.publishedAt)).slice(0, SHORTLIST_MAX_CANDIDATES);

  const seen = await findSeenUrls(env.DB, capped.map((c) => c.url));
  const unseen = capped.filter((c) => !seen.has(c.url));

  return unseen
    .map((candidate) => ({ candidate, score: relevanceScore(candidate, topic) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST_TOP_N)
    .map((r) => r.candidate);
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
  return recordRunOutcome(env.DB, {
    instanceId,
    topicId: outcome.topicId ?? null,
    status: outcome.status,
    neuronsSpent: outcome.neuronsSpent,
    sourcesUsed: outcome.sourcesUsed ?? 0,
    prUrl: outcome.prUrl ?? null,
  });
}
