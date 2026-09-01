/** Bindings and vars declared in wrangler.toml. */
export interface Env {
  AI: Ai;
  DB: D1Database;
  RESEARCH_WORKFLOW: Workflow<ResearchParams>;
  /** feature 003: the child Workflow gather runs in, not the parent's own steps. See src/gather-workflow.ts. */
  GATHER_WORKFLOW: Workflow<GatherParams>;
  /** feature 003, extended 2026-08-31 (#75): the child Workflow article summarization runs in, not the parent's own steps. See src/summarize-workflow.ts. */
  SUMMARIZE_WORKFLOW: Workflow<SummarizeParams>;
  /** feature 003, extended 2026-09-01 (#75): the child Workflow the pull request is opened from, not the parent's own steps. See src/publish-workflow.ts. */
  PUBLISH_WORKFLOW: Workflow<PublishParams>;

  BLOG_REPO: string;
  BLOG_BASE_BRANCH: string;
  BLOG_FEED_URL: string;
  LLM_MODEL: string;
  AI_GATEWAY: string;
  NEURON_BUDGET_PER_RUN: string;
  /** Base URL for the GitHub REST client (src/lib/github.ts). Keeps that file free of a URL literal. */
  GITHUB_API_BASE: string;
  /** How many feeds one GatherWorkflow child parses. See its own comment in src/workflow.ts for the subrequest arithmetic this is sized against. */
  GATHER_FEEDS_PER_CHILD: string;
  /** How many shortlisted candidates one SummarizeWorkflow child processes. See createSummarizeChildren's comment in src/workflow.ts for the subrequest arithmetic this is sized against. */
  SUMMARIZE_ARTICLES_PER_CHILD: string;

  /** Set with `wrangler secret put GITHUB_TOKEN`. Never in wrangler.toml. */
  GITHUB_TOKEN: string;
}

export type TopicStatus = 'queued' | 'in_progress' | 'done' | 'rejected';

/** A row of the curated queue. Queue-first; the agent proposes only when empty. */
export interface Topic {
  id: number;
  title: string;
  angle: string | null;
  status: TopicStatus;
  /** 'human' when curated, 'agent' when proposed from the archive. */
  origin: 'human' | 'agent';
  createdAt: string;
}

/** One entry in the RSS/Atom allowlist. */
export interface Source {
  name: string;
  feedUrl: string;
}

/**
 * One item as parsed from a raw RSS or Atom feed (src/lib/feed.ts), before
 * the source name is attached and the recency window applied - both of
 * which `gatherCandidates` (src/workflow.ts) does to turn this into a
 * `Candidate`.
 */
export interface FeedItem {
  url: string;
  title: string;
  /** Raw date text from the feed (RFC 822 `pubDate` or RFC 3339 `published`/`updated`), or null if absent/unparseable. */
  publishedAt: string | null;
}

/**
 * A `FeedItem` carrying the epoch-ms of `publishedAt`, parsed once during
 * `parseFeed` (src/lib/feed.ts) so neither the bounded parse's stop condition
 * nor `applyGatherWindow`'s filter has to `Date.parse` it again. Named for
 * when it is produced, not for the window: `parseFeed` returns this *before*
 * any window is applied, so a name like `WindowedItem` would be a lie about
 * an unwindowed parse.
 */
export type ParsedItem = FeedItem & { publishedMs: number | null };

/** A candidate article discovered in a feed, before it has been read. */
export interface Candidate {
  url: string;
  title: string;
  publishedAt: string | null;
  /** Epoch-ms of `publishedAt` as parsed by `applyGatherWindow`, or null when undated - surfaced rather than recomputed, so `shortlist` can order in SQL. */
  publishedMs: number | null;
  sourceName: string;
}

/** Output of the per-article map step. */
export interface ArticleSummary {
  url: string;
  title: string;
  summary: string;
  relevance: number;
  claims: string[];
  /**
   * The R&D practice or research finding this source attributably supports, or
   * null if it is commentary. A run needs at least one non-null to be worth a
   * draft - see MIN_SOURCES / MIN_PRACTICES in workflow.ts and spec req. 5.
   */
  attributablePractice: string | null;
}

/**
 * Output of the reduce step: what the pull request carries.
 *
 * Maps onto the blog's content-collection schema (src/content.config.ts).
 * `draft` is always true and `image` is deliberately absent - the Astro
 * `image()` helper resolves to a real file, so emitting one without committing
 * it breaks the site build. See .claude/skills/blog-voice/SKILL.md.
 */
export interface Draft {
  /** kebab-case, no spaces. Becomes src/content/blog/<slug>/index.mdx. */
  slug: string;
  title: string;
  description: string;
  /** yyyy-mm-dd. */
  date: string;
  authors: string[];
  tags: string[];
  draft: true;
  /** The research brief. Becomes the pull request body, not the post. */
  brief: string;
  /** MDX body, without frontmatter. */
  body: string;
  sources: string[];
}

/** Workflow input. One instance per scheduled run. */
export interface ResearchParams {
  triggeredAt: string;
  /** Set to skip topic selection and research a specific queue row. */
  topicId?: number;
}

/**
 * `GatherWorkflow`'s input (feature 003, spec.md's "Gather in child
 * instances"). One instance per chunk of `GATHER_FEEDS_PER_CHILD` feeds.
 */
export interface GatherParams {
  /**
   * The PARENT's Workflow instance id, deliberately not the child's own -
   * children write into the parent's `run_candidates` rows under this id, so
   * `shortlist` (keyed on the run/parent id) needs no change at all.
   */
  runId: string;
  sources: Source[];
  /** 0-based position among the parent's children. Carried only for the `agent.gather.child_index` span attribute - never used to derive a step name (that stays the static `gather:<feed name>` literal). */
  index: number;
}

/**
 * What one poll round of a child batch hands to the next: which children are
 * still worth a `status()` call, and the validated output of every child that
 * has already finished (`pollChildBatch`, src/lib/workflow-children.ts).
 *
 * It travels as part of the poll step's own *output*, never in a closure:
 * `run()` re-executes from the top on every replay (spec.md fact 2), so a
 * replayed round has to recompute from its input, and a step output is the
 * only thing the platform persists. `outputs` is what makes it safe to stop
 * polling a finished child - `combine` still needs every child's result, so a
 * child no longer polled must have its result carried.
 *
 * Bounded, which requirement 5 and criterion 8 hold this to: both fields are
 * keyed by child id, so they are sized by child count, and a summarize
 * child's output is capped by its own chunk of `SHORTLIST_TOP_N`. Carrying
 * outputs forward means every round now holds what only the final round used
 * to; the ceiling is unchanged, and it stays unchanged only while that
 * per-child cap does.
 */
export interface ChildPollState<TOutput> {
  pending: string[];
  outputs: Record<string, TOutput>;
}

/** A gather child returns its candidate count, so that is what is carried. */
export type GatherPollState = ChildPollState<number>;

/**
 * Outcome of one `await-gather-children` poll round (src/workflow.ts). A
 * discriminated union rather than a `done` flag with meaningless siblings:
 * `state` is what the next round needs and `total` is what the run needs, and
 * carrying both on the terminal round would put every child's output in the
 * final step result twice.
 */
export type GatherPollResult = { done: true; total: number } | { done: false; state: GatherPollState };

/**
 * `SummarizeWorkflow`'s input (feature 003, extended 2026-08-31 (#75) once
 * gather's own child shape proved out: run `6f75e460` moved 46 feeds off the
 * parent and the parent still failed its 15th article on
 * `Too many subrequests by single Worker invocation.`). One instance per
 * chunk of `SUMMARIZE_ARTICLES_PER_CHILD` shortlisted candidates.
 */
export interface SummarizeParams {
  candidates: Candidate[];
  topic: Topic;
  /**
   * This child's share of the run's remaining neuron budget - see
   * `createSummarizeChildren`'s comment (src/workflow.ts) for how it is
   * derived and why a proportional split, not the whole budget, is what
   * keeps concurrent children from jointly overspending it.
   */
  neuronBudget: number;
  /** 0-based position among the parent's children. Carried only for the `agent.summarize.child_index` span attribute - never used to derive a step name (that stays the static `summarize:<url>` literal). */
  index: number;
}

/** What one `SummarizeWorkflow` child returns, validated - `synthesize` needs the summaries themselves, not a count (requirement 5's size reading). */
export interface SummarizeChildOutput {
  summaries: ArticleSummary[];
  neuronsSpent: number;
}

export type SummarizePollState = ChildPollState<SummarizeChildOutput>;

/** Outcome of one `await-summarize-children` poll round (src/workflow.ts), the same union shape and for the same reason as `GatherPollResult`. */
export type SummarizePollResult =
  | { done: true; summaries: ArticleSummary[]; neuronsSpent: number }
  | { done: false; state: SummarizePollState };

/**
 * `PublishWorkflow`'s input (feature 003, extended 2026-09-01 (#75) once run
 * `0357f119` reached `open-pull-request` and died inside it on the parent's
 * own subrequest ceiling). Exactly one instance per run - there is nothing to
 * chunk, so this carries no `index` and `wrangler.toml` gains no
 * per-child-size var.
 *
 * **One field, because `Draft` already carries the brief.** `draft.brief` is
 * the pull request body and `draft.body` is the post, both computed in the
 * parent's `synthesize` step (`synthesizeDraft`, src/workflow.ts), so the
 * child receives a finished `Draft` and authors nothing.
 *
 * **It fits the platform's params limit with room to spare.** A Workflow's
 * maximum event payload is **1 MiB (2^20 bytes)** on Free and Paid alike
 * ([Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)),
 * the same figure as the non-stream step-result cap `createSummarizeChildren`
 * sizes its return against. A draft body is 1,000-2,800 words
 * (`.claude/skills/blog-voice/SKILL.md`), roughly 6-20 KB of UTF-8, plus a
 * brief of one line per shortlisted source (at most `SHORTLIST_TOP_N` = 15)
 * and a handful of short frontmatter fields - a few tens of KB against 1,048,576,
 * two orders of magnitude under. Unlike a candidate list it also does not grow
 * with the feed allowlist: every field is either fixed-size or capped by
 * `SHORTLIST_TOP_N`.
 */
export interface PublishParams {
  draft: Draft;
}

/** A publish child returns the pull request URL, so that is what is carried. */
export type PublishPollState = ChildPollState<string>;

/** Outcome of one `await-publish-children` poll round (src/workflow.ts), the same union shape and for the same reason as `GatherPollResult`. */
export type PublishPollResult = { done: true; prUrl: string } | { done: false; state: PublishPollState };

/** Recorded in the `runs` table for observability and budget tracking. */
export interface RunOutcome {
  instanceId: string;
  topicId: number | null;
  neuronsSpent: number;
  sourcesUsed: number;
  prUrl: string | null;
  status: 'succeeded' | 'no_topic' | 'insufficient_sources' | 'failed';
}
