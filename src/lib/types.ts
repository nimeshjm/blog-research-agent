/** Bindings and vars declared in wrangler.toml. */
export interface Env {
  AI: Ai;
  DB: D1Database;
  RESEARCH_WORKFLOW: Workflow<ResearchParams>;
  /** feature 003: the child Workflow gather runs in, not the parent's own steps. See src/gather-workflow.ts. */
  GATHER_WORKFLOW: Workflow<GatherParams>;

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
 * Outcome of one `await-gather-children` poll round (src/workflow.ts).
 * `done: false` means at least one child has not yet reached `complete`;
 * `total` is meaningless until `done` is true.
 */
export interface GatherPollResult {
  done: boolean;
  total: number;
}

/** Recorded in the `runs` table for observability and budget tracking. */
export interface RunOutcome {
  instanceId: string;
  topicId: number | null;
  neuronsSpent: number;
  sourcesUsed: number;
  prUrl: string | null;
  status: 'succeeded' | 'no_topic' | 'insufficient_sources' | 'failed';
}
