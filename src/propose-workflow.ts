import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { attachRunTopic, findOrProposeTopic } from './lib/d1';
import { fetchFeedItems } from './lib/feed-fetch';
import { loadFeeds } from './lib/feeds';
import { listBlogPostSlugs } from './lib/github';
import { tokenize } from './lib/text';
import type { Env, ProposeChildOutput, ProposeParams } from './lib/types';
import { tracerFor } from './lib/trace';

/**
 * feature 003's fourth child instance (#109), the same shape
 * `PublishWorkflow` is: one child, no chunking, doing a fixed block of I/O
 * that used to run in the parent's own `select-topic` step.
 *
 * **Why this exists.** `select-topic`'s propose branch - reached only when
 * the queue is empty - reads the blog feed, the blog repo's drafted-post
 * directory and a seed feed, then reads and possibly writes `topics` and
 * `runs`. Measured against the current tree (issue #109; the seed feed's
 * `http://` redirect #109 originally charged this two for is fixed by
 * commit `b00e96c` - both arXiv feeds are `https://` now, so every fetch
 * below costs exactly one subrequest, no redirect): `fetchFeedTitles` (1) +
 * `listBlogPostSlugs` (1) + the seed `fetchFeedItems` (1) + `findOrProposeTopic`'s
 * `SELECT` (1) + its `INSERT` (1, new proposal only) + `attachRunTopic` (1) =
 * 6 recovering an existing proposal, 7 for a new one - on top of the
 * `reclaimAndClaim` batch and `create-propose-children` step the parent
 * still pays (`createProposeChildren`'s comment, src/workflow.ts, has the
 * parent-side recount). Run inline in the parent, that pushed the
 * queue-draining path's ~3-subrequest `select-topic` term to 6-7, taking the
 * pessimal total over the platform's 50-subrequest-per-invocation ceiling
 * the moment #108 lets the queue actually drain (issue #109's whole point).
 * Here, it spends a fresh child's own 50 instead - comfortably, at 6-7 of it.
 *
 * **`attachRunTopic` runs inside this child, not back in the parent.** Every
 * other write this child's params support - `findOrProposeTopic`'s
 * SELECT/INSERT - already had to happen wherever `proposeTopic`'s result
 * landed, and `attachRunTopic` only needs the *parent's* instance id
 * (`ProposeParams.parentInstanceId`) to write the parent's own `runs` row -
 * the same shape `GatherParams.runId` already uses to let a child write into
 * a row keyed by an id that is not its own. Doing it here rather than after
 * polling saves the parent a subrequest it would otherwise spend on every
 * propose-path run (`createProposeChildren`'s comment has the arithmetic).
 *
 * The body is `runPropose`, a plain function - same reason `runGather`,
 * `runSummarize` and `runPublish` are: `WorkflowEntrypoint`'s real
 * constructor rejects being `new`'d outside the platform's own Workflows
 * runtime, so `run()` itself is untestable in isolation.
 */
export async function runPropose(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<ProposeParams>,
): Promise<ProposeChildOutput> {
  const traceStep = tracerFor(step, event);

  // One step, not several - the same argument `runPublish`'s comment makes:
  // a child has 50 subrequests to itself, so there is nothing to buy by
  // splitting six-or-fewer sequential reads/writes across step boundaries,
  // and an all-or-nothing step is what keeps the idempotency argument
  // simple (`proposeAndPersistTopic`'s own comment has it).
  return traceStep('propose-topic', {}, async () =>
    proposeAndPersistTopic(env, event.payload.coveredTopicTitles, event.payload.parentInstanceId),
  );
}

export class ProposeWorkflow extends WorkflowEntrypoint<Env, ProposeParams> {
  run(event: WorkflowEvent<ProposeParams>, step: WorkflowStep): Promise<ProposeChildOutput> {
    return runPropose(this.env, step, event);
  }
}

/**
 * `proposeTopic` (below) plus the persistence `selectTopic` (src/workflow.ts)
 * used to do inline once `proposeTopic` returned - `findOrProposeTopic`'s
 * find-or-insert, then `attachRunTopic`. Split out as its own exported
 * function, rather than folded straight into `runPropose`, for the same
 * reason `openPullRequest` is separate from `runPublish`: it is what keeps
 * the existing `selectTopic()`-level test coverage of the propose path
 * intact with only its call target changed, not its bodies or assertions,
 * and it is what makes `runPropose` a one-line `traceStep` wrapper.
 *
 * Idempotent end to end, for the replay reason every step body in this repo
 * has to be (`run()` re-executes on replay, and this child's own step is
 * not retried either): `findOrProposeTopic` recovers an earlier attempt's
 * row by exact title match rather than inserting a second one, and
 * `attachRunTopic`'s `UPDATE ... WHERE instance_id = ?` is idempotent by
 * construction.
 *
 * Returns `{ topic: null }`, never a bare `null`, when `proposeTopic` finds
 * nothing uncovered. `pollChildBatch`'s `outputs[id] ?? (replacement...)`
 * (src/lib/workflow-children.ts) treats a `null` output the same as
 * `undefined` - `??` does not distinguish them - so a bare nullable return
 * would make a legitimate "nothing to propose" completion indistinguishable
 * from "this child never reached a polled completion" and throw instead of
 * falling through to `record-no-topic`. Wrapping it in an object side-steps
 * that entirely: `outputs[id]` is the object, always defined once the child
 * completes, and `.topic` is what carries the nullability.
 */
export async function proposeAndPersistTopic(
  env: Env,
  coveredTopicTitles: string[],
  parentInstanceId: string,
): Promise<ProposeChildOutput> {
  const proposal = await proposeTopic(env, coveredTopicTitles);
  if (proposal === null) return { topic: null };

  const proposed = await findOrProposeTopic(env.DB, proposal);
  await attachRunTopic(env.DB, parentInstanceId, proposed.id);
  return { topic: proposed };
}

/**
 * How many meaningful title-word overlaps with an existing published post,
 * drafted post, or previously-claimed `topics` row count as "already
 * covered" when the agent proposes its own topic (spec.md req. 3). Heuristic,
 * not semantic - see "Deferred: Vectorize semantic dedupe" in spec.md, which
 * is what a real version of this check would use. Two shared non-stopword
 * tokens is deliberately low: a proposal that shares that much vocabulary
 * with something already on the blog - or already claimed by this agent - is
 * cheap to skip and expensive to publish twice (#104: PRs #2 and #3 shared
 * four).
 *
 * Moved here unchanged from src/workflow.ts (#109, alongside `proposeTopic`
 * itself) - its value is unchanged and out of this change's scope.
 */
export const DUPLICATE_TOKEN_THRESHOLD = 2;

/**
 * Generates a candidate {title, angle} without inference (spec.md is
 * explicit that inference happens in exactly two places - summarizeArticle
 * and synthesizeDraft - neither of which is this). Moved here unchanged from
 * src/workflow.ts (#109) when the propose branch became a child instance -
 * see this file's own header comment for why, and for the subrequest
 * arithmetic.
 *
 *  1. The "published" set: parse BLOG_FEED_URL (one fetch) for post titles.
 *  2. The "drafted" set: list post slugs under src/content/blog/ at the
 *     repo's default branch (one fetch, `listBlogPostSlugs` - github.ts).
 *     This catches a *hand-written* draft with `draft: true` committed
 *     straight to the default branch - it does not catch the agent's own
 *     drafts, because the agent never commits there. CLAUDE.md: "The agent
 *     writes to branches only" - `research/<yyyy-mm-dd>-<slug>`, reaching
 *     `main` only once a human merges the pull request it opens.
 *  3. The agent's own "previously claimed" set: `coveredTopicTitles`, read by
 *     the parent's `select-topic` step (`reclaimAndClaim`, src/lib/d1.ts,
 *     #104) and passed in as a param at no extra subrequest to this child -
 *     see `ProposeParams.coveredTopicTitles`'s doc comment. This is what
 *     catches the case the two reads above cannot: a topic the agent
 *     proposed and is still drafting, or already drafted, on a branch
 *     neither the feed nor the repo's default branch has ever seen.
 *  4. The candidate itself: the newest item from the first configured
 *     discovery feed (deterministic, and - at 62 items - small enough to
 *     parse well inside this child's own 10 ms-per-invocation CPU budget
 *     alongside the reads above) whose title does not overlap the union of
 *     all three covered sets past DUPLICATE_TOKEN_THRESHOLD.
 *
 * Returns null on any read failure or when every candidate from the seed
 * feed is already covered - the caller (`proposeAndPersistTopic` above)
 * returns `{ topic: null }` either way, and `selectTopic` falls through to
 * the existing `record-no-topic` exit.
 */
export async function proposeTopic(
  env: Env,
  coveredTopicTitles: string[],
): Promise<{ title: string; angle: string | null } | null> {
  const [publishedTitles, draftedSlugs] = await Promise.all([
    fetchFeedTitles(env.BLOG_FEED_URL),
    listBlogPostSlugs({ apiBase: env.GITHUB_API_BASE, token: env.GITHUB_TOKEN, repo: env.BLOG_REPO }).catch(
      () => [] as string[],
    ),
  ]);

  const covered = new Set<string>();
  for (const title of publishedTitles) for (const word of tokenize(title)) covered.add(word);
  for (const slug of draftedSlugs) for (const word of tokenize(slug.replace(/-/g, ' '))) covered.add(word);
  for (const title of coveredTopicTitles) for (const word of tokenize(title)) covered.add(word);

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
