import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  attachRunTopic,
  claimOldestQueuedTopic,
  claimTopicById,
  findOrProposeTopic,
  findSeenUrls,
  pruneRunCandidates,
  readRunCandidates,
  reclaimStaleTopics,
  recordRunOutcome,
  startRun,
  writeRunCandidates,
} from './lib/d1';
import { extractArticleText } from './lib/extract';
import { applyGatherWindow, parseFeed } from './lib/feed';
import type { ParseBound } from './lib/feed';
import { loadFeeds } from './lib/feeds';
import {
  createBranch,
  listBlogPostSlugs,
  openPullRequest as githubOpenPullRequest,
  putFile,
  readBaseRefSha,
  readRepoFile,
} from './lib/github';
import type { GithubConfig } from './lib/github';
import { createLlm, neuronsFor } from './lib/llm';
import { blogPostPath, renderMdx, validateAgainstContentConfig, validateDraft } from './lib/mdx';
import { buildMapMessages, buildReduceMessages, normaliseCitations, parseMapResponse, parseReduceResponse } from './lib/prompts';
import type { ReduceParseFailure } from './lib/prompts';
import type { ArticleSummary, Candidate, Draft, Env, ParsedItem, ResearchParams, RunOutcome, Source, Topic } from './lib/types';
import {
  ATTR_NEURONS_BUDGET,
  ATTR_NEURONS_SPENT,
  ATTR_RUN_STATUS,
  ATTR_SOURCES_GATHERED,
  ATTR_SOURCES_SHORTLISTED,
  ATTR_SOURCES_USED,
  ATTR_SUMMARIZE_SKIP_REASON,
  ATTR_TOPIC_ID,
  tracerFor,
} from './lib/trace';

/**
 * The research pipeline.
 *
 * Structured as a Workflow rather than a plain cron handler because the free
 * plan caps `scheduled()` at 15 minutes of wall-clock for the whole run, and
 * a Workflow step carries no such cap. The 10 ms CPU budget is charged per
 * invocation, *not* reset at each `step.do` - Workflows packs consecutive
 * fast steps into one invocation instead (measured 2026-08-27, #61: one feed
 * parse in an invocation passes, two pass, three fail with Workers error
 * `1102`). What a step boundary buys is a *chance* of a fresh invocation,
 * never a guarantee - so parsing ~46 feeds and ~15 articles still has to
 * stay one fetch-and-parse per step, on the chance that pays off, not on a
 * promise the platform never made.
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

    // 2. One step per feed. 50 subrequests per step on the free plan, so a
    //    single feed fetch per step leaves generous headroom for redirects.
    //    Parsing only - dedupe is batched in `shortlist`, because a per-item
    //    seen_urls query would blow both the 10 ms CPU and the 50-query budget.
    //    Each gather applies GATHER_WINDOW_DAYS before returning. That is not
    //    tuning: most of the allowlist is whole archives rather than rolling
    //    feeds, and unwindowed they put 4,742 candidates into `shortlist`,
    //    whose chunked seen_urls batch would then need 48 of D1's 50 queries
    //    per invocation. Windowed it is 678 candidates and 7 queries.
    //
    //    `gathered` stays an integer, not an array: `run()` re-executes from
    //    the top on every replay, so anything it accumulates here is rebuilt
    //    once per attempt, and replay cost grows with the number of
    //    *completed* gathers (requirement 4). Each feed writes its own
    //    candidates straight to D1 (`gatherCandidates`); this loop only
    //    totals the counts.
    const sources = await traceStep('load-sources', {}, async () => loadSources(this.env));

    let gathered = 0;
    for (const source of sources) {
      // `agent.step` on this span is the `gather` prefix, not the full step
      // name - `tracedStep` strips after the first `:` so a per-feed span
      // never needs a source name judged sensitive enough to redact by hand.
      gathered += await traceStep(`gather:${source.name}`, {}, async (span) => {
        const count = await gatherCandidates(this.env, event.instanceId, source);
        span.setAttribute(ATTR_SOURCES_GATHERED, count);
        return count;
      });
    }

    // Batched dedupe against seen_urls happens inside shortlistCandidates.
    // `gathered` is not otherwise read downstream - it lands on this span
    // alongside the shortlisted count, so acceptance criterion 5 ("all 46
    // feeds gathered with no CPU failure") is readable from one span instead
    // of summed by hand across 46 gather spans.
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

    // 3. Map: one article per step. CPU is charged per invocation and a step
    //    boundary is not a fresh budget, so keeping a single parse to a step is
    //    the only lever there is. It also bounds spend per article rather than
    //    per run: the budget check is between calls, so a run may overshoot by
    //    at most one article call.
    const summaries: ArticleSummary[] = [];
    for (const candidate of shortlist) {
      if (neuronsSpent + SUMMARY_NEURON_ESTIMATE > budget - SYNTHESIS_NEURON_RESERVE) break;

      // `agent.step` on this span is the `summarize` prefix. `candidate.url`
      // stays out of every span attribute - REVIEW.md pass 2 forbids a URL
      // there - even though it still passes through to step.do unchanged,
      // because that is the replay key.
      const result = await traceStep(`summarize:${candidate.url}`, {}, async (span) => {
        const outcome = await summarizeArticle(this.env, candidate, topic);
        if (outcome.skipReason !== undefined) span.setAttribute(ATTR_SUMMARIZE_SKIP_REASON, outcome.skipReason);
        return outcome;
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

export function isGrounded(summaries: ArticleSummary[]): boolean {
  const practices = summaries.filter((s) => s.attributablePractice !== null);
  return summaries.length >= MIN_SOURCES && practices.length >= MIN_PRACTICES;
}

/** Conservative per-article estimate used for the budget gate - see spec.md's cost table (measured, #18). */
const SUMMARY_NEURON_ESTIMATE = 300;
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
 * `maxTokens` for the map call. Matches what `plan.md` step 2's probe used
 * (4,096) - the 203/223-neuron measurements in spec.md's cost table were
 * taken at this ceiling, so raising it materially would need remeasuring.
 */
const MAP_MAX_TOKENS = 4096;
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
/**
 * How many consecutive dated, out-of-window items `parseFeed` reads before it
 * cancels the response body rather than draining the rest of the archive
 * (spec.md req. 1). The margin it rests on is the differential over all 46
 * live feeds (acceptance criterion 2), not a derivation - it only has to
 * absorb the local disorder of a feed that is mostly, not perfectly,
 * newest-first.
 */
export const GATHER_STALE_RUN = 10;
/**
 * Requirement 3's backstop only: a wholly undated feed can never trip
 * `GATHER_STALE_RUN`, so without a raw-item ceiling it would be unbounded.
 * The margin is stated both ways it could be wrong: the largest raw item
 * count in the allowlist is OpenAI's 1,155, and the largest legitimate
 * *kept* count is arXiv cs.AI's 352-item announcement day (requirement 6
 * forbids truncating that). 2,000 sits far enough above both that it can
 * never truncate a real day - it is a safety net, not a tuning knob, and
 * deliberately not sized anywhere near 352.
 */
export const GATHER_RAW_ITEM_MAX = 2000;
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

/**
 * `bound`, when given, is threaded two places: as the `fetch`'s abort
 * signal (so cancelling it actually stops the network read, not only the
 * in-process parse) and into `parseFeed` (so it can decide when to stop
 * reading and call `bound.abort.abort()` itself). `parseFeed` absorbs the
 * rejection that abort causes in its own drain - see its module doc comment
 * - so by the time control reaches this function's `catch`, an aborted
 * bounded parse has already returned normally with whatever it read. This
 * `catch` therefore only ever sees a genuine fetch/parse failure, never the
 * bound firing; if that stopped being true, a bound tripping on every
 * archive feed would look identical to a dead feed here, and every one of
 * them would silently contribute zero candidates.
 */
async function fetchFeedItems(feedUrl: string, bound?: ParseBound): Promise<ParsedItem[]> {
  try {
    const response = await fetch(feedUrl, bound === undefined ? undefined : { signal: bound.abort.signal });
    if (!response.ok) return [];
    return await parseFeed(response, bound);
  } catch {
    return [];
  }
}

async function fetchFeedTitles(feedUrl: string): Promise<string[]> {
  // No bound: the seed-feed read that backs proposeTopic wants the newest
  // item regardless of the window (spec.md req. 12 - bounding it could
  // change which topic gets proposed).
  const items = await fetchFeedItems(feedUrl);
  return items.map((i) => i.title);
}

/**
 * One fetch, streamed parse (src/lib/feed.ts), then one D1 write
 * (`writeRunCandidates`). The 30-day window and the undated-item cap are
 * applied here, per feed, never in `shortlist` - see GATHER_WINDOW_DAYS /
 * GATHER_UNDATED_MAX_PER_FEED above and spec.md, "The recency window in
 * `gather`". A feed that cannot be fetched or fails to parse contributes
 * zero candidates rather than failing the step: `fetchFeedItems` already
 * swallows that failure and returns `[]`, so one dead feed must not fail the
 * run (spec.md risk table), and a feed that consistently returns nothing is
 * a review finding against the allowlist, visible via `agent.sources.gathered`
 * on the step's own span. A D1 write failure, though, does still fail the
 * step, and should - that is not a dead feed, it is a dead database.
 *
 * `now` is computed once and shared between the bound's `cutoffMs` and
 * `applyGatherWindow`'s own cutoff, so the parse-time stop and the
 * post-parse filter agree on exactly the same window boundary rather than
 * drifting apart across the (sub-millisecond) gap between two separate
 * `Date.now()` reads.
 */
export async function gatherCandidates(env: Env, runId: string, source: Source): Promise<number> {
  const now = new Date();
  const bound: ParseBound = {
    abort: new AbortController(),
    cutoffMs: now.getTime() - GATHER_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    staleRun: GATHER_STALE_RUN,
    rawMax: GATHER_RAW_ITEM_MAX,
  };
  const items = await fetchFeedItems(source.feedUrl, bound);
  const windowed = applyGatherWindow(items, {
    windowDays: GATHER_WINDOW_DAYS,
    undatedMax: GATHER_UNDATED_MAX_PER_FEED,
    now,
  });
  return writeRunCandidates(env.DB, runId, source.name, windowed);
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
 * Reads the run's whole candidate set from D1, newest-first and capped at
 * SHORTLIST_MAX_CANDIDATES in SQL (`readRunCandidates`'s `ORDER BY`, not a
 * JS sort - see that function's doc comment for why undated items sort
 * last) - so this does zero `Date.parse` calls where it used to do one per
 * candidate. Then the batched `seen_urls` dedupe (`findSeenUrls`, chunked at
 * 100 params - `d1.ts` owns that chunking, not reimplemented here), then
 * heuristic ranking against `topic`, then a cap of SHORTLIST_TOP_N. See
 * spec.md, "The aggregate ceiling in `shortlist`".
 */
export async function shortlistCandidates(env: Env, runId: string, topic: Topic): Promise<Candidate[]> {
  const capped = await readRunCandidates(env.DB, runId, SHORTLIST_MAX_CANDIDATES);

  const seen = await findSeenUrls(env.DB, capped.map((c) => c.url));
  const unseen = capped.filter((c) => !seen.has(c.url));

  return unseen
    .map((candidate) => ({ candidate, score: relevanceScore(candidate, topic) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST_TOP_N)
    .map((r) => r.candidate);
}

/**
 * Every way `summarizeArticle` can skip an article without failing the run.
 * Machine-readable so a `describe`d step output (or the `agent.summarize.skip_reason`
 * span attribute) can say *which* early return fired instead of collapsing
 * all of them into one indistinguishable `summary: null` - the gap that made
 * a real run (525a5386-deb0-4d4b-8242-d4246462884e, 2026-08-31) where all 15
 * `summarize` steps skipped look identical whether that was one shared cause
 * or 15 unrelated ones.
 */
export type SummarizeSkipReason = 'fetch-threw' | 'http-error' | 'empty-extract' | 'truncated' | 'unparseable';

/**
 * `errorMessage` and `status` are diagnostics for the *step output* only -
 * `wrangler workflows instances describe` persists whatever `summarizeArticle`
 * returns, which is the only channel that survived to read the deployed run
 * this type was added for. They must never reach a span attribute: CLAUDE.md
 * forbids an error message (or a URL) there, constructor name only via
 * `error.type` - see `ATTR_SUMMARIZE_SKIP_REASON`'s comment in `trace.ts` for
 * why the step output is a different, permitted channel.
 */
export interface SummarizeResult {
  summary: ArticleSummary | null;
  neurons: number;
  skipReason?: SummarizeSkipReason;
  /** Set only for `skipReason: 'http-error'`. */
  status?: number;
  /** Set only for `skipReason: 'fetch-threw'`, capped so a huge message can't bloat the step output. */
  errorMessage?: string;
}

const ERROR_MESSAGE_MAX_LEN = 100;

/** A Cloudflare subrequest-limit failure surfaces as a plain `Error` - the message, not the constructor, carries the signal. */
function truncatedMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > ERROR_MESSAGE_MAX_LEN ? message.slice(0, ERROR_MESSAGE_MAX_LEN) : message;
}

/**
 * One fetch, streamed extraction (`src/lib/extract.ts`), one `Llm` call.
 * Returns `summary: null` - never throws for anything short of the `Llm`
 * call itself failing - so one bad article (unfetchable, unextractable, or a
 * response that doesn't parse as the expected JSON) cannot fail the run
 * (spec.md risk table). `neurons` is still reported on every path that
 * actually spent them, so the budget gate in `run()` stays accurate even
 * when the article was a bust.
 */
export async function summarizeArticle(env: Env, candidate: Candidate, topic: Topic): Promise<SummarizeResult> {
  let response: Response;
  try {
    response = await fetch(candidate.url);
  } catch (err) {
    return { summary: null, neurons: 0, skipReason: 'fetch-threw', errorMessage: truncatedMessage(err) };
  }
  if (!response.ok) return { summary: null, neurons: 0, skipReason: 'http-error', status: response.status };

  const articleText = await extractArticleText(response);
  if (articleText === '') return { summary: null, neurons: 0, skipReason: 'empty-extract' };

  const llm = createLlm(env);
  const result = await llm.complete({
    messages: buildMapMessages(topic, candidate, articleText),
    maxTokens: MAP_MAX_TOKENS,
  });
  const neurons = neuronsFor(result);

  // A truncated completion's text (if any survived) is not trustworthy JSON
  // - skip parsing it rather than risk parseMapResponse accepting a
  // partial/malformed object by accident.
  if (result.finishReason === 'length') return { summary: null, neurons, skipReason: 'truncated' };

  // Never throws on a rejection (see parseMapResponse's doc comment). The
  // parser's own finer-grained reason is still discarded: one bad article
  // must not fail the run, and distinguishing it from a truncated completion
  // is as far as this caller needs to go - unlike synthesizeDraft, which does
  // throw and reports its ReduceParseFailure below.
  const parsed = parseMapResponse(result.text);
  if (!parsed.ok) return { summary: null, neurons, skipReason: 'unparseable' };

  return {
    summary: { url: candidate.url, title: candidate.title, ...parsed.value },
    neurons,
  };
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
 * `src/lib/prompts.ts` - including the `<!-- OPENING INCIDENT: needs a real
 * example -->` marker instruction. Never invents a war story: that
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

/**
 * Validates frontmatter (statically, then against the blog's live
 * `content.config.ts`), creates `research/<yyyy-mm-dd>-<slug>`, commits
 * `src/content/blog/<slug>/index.mdx`, opens the PR with the brief as its
 * body. Idempotent on retry - see the module-level comment below for the
 * mechanism-by-mechanism breakdown; every write here delegates to
 * `src/lib/github.ts`'s own idempotent primitives, none of it reimplemented.
 *
 * The agent never pushes to `BLOG_BASE_BRANCH`: `prParams.base` below is the
 * only read of it, inline inside a `base:` property so
 * `base-branch-not-a-write-target` can prove that structurally, and it is
 * only ever passed to `readBaseRefSha` (a GET) and as the PR's `base` field
 * - never to `createBranch` or `putFile`, which are what could write to it.
 */
export async function openPullRequest(env: Env, draft: Draft): Promise<string> {
  validateDraft(draft);

  const config: GithubConfig = { apiBase: env.GITHUB_API_BASE, token: env.GITHUB_TOKEN, repo: env.BLOG_REPO };

  // Dynamic check against the live schema - spec.md: "the PR step reads it
  // ... rather than trusting the copy above, so a schema change upstream
  // surfaces as a failed step instead of a broken build." A missing schema
  // file is itself surfaced the same way (readRepoFile returns null here
  // only on 404; any other failure already threw inside it).
  const schemaSource = await readRepoFile(config, 'src/content.config.ts');
  if (schemaSource === null) {
    throw new Error('openPullRequest: src/content.config.ts not found in the blog repo - cannot validate frontmatter');
  }
  validateAgainstContentConfig(schemaSource);

  const prParams = {
    title: draft.title,
    body: draft.brief,
    head: `research/${draft.date}-${draft.slug}`,
    base: env.BLOG_BASE_BRANCH,
  };

  const baseSha = await readBaseRefSha(config, prParams.base);
  await createBranch(config, prParams.head, baseSha); // idempotent: 422 (already exists) is success

  await putFile(config, {
    path: blogPostPath(draft.slug),
    content: renderMdx(draft),
    message: `Add research draft: ${draft.title}`,
    branch: prParams.head,
  }); // idempotent: reads the file's current sha on that branch first

  return githubOpenPullRequest(config, prParams); // idempotent: reuses an existing open PR for this head
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
