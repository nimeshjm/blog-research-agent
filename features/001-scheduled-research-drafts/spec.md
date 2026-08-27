# Spec: Scheduled research drafts

> Stage 2. Written from the approved `intent.md`. **Approved** — see
> [#1](https://github.com/nimeshjm/blog-research-agent/issues/1). Implementation is
> planned in [`plan.md`](plan.md); the step bodies it describes are not written yet.

## Summary

A Cloudflare cron trigger fires every two days and starts a Workflow that selects a topic, reads a curated
allowlist of RSS/Atom feeds, summarizes the most relevant articles one at a time,
synthesizes a research brief and a draft post, and opens a pull request against the blog
repo. All inference runs on the Workers AI free allocation. The agent writes to a branch
and stops; a human merges.

## Requirements

1. The pipeline runs on a schedule without human involvement, every two days
   (`0 6 */2 * *`).
2. When the topic queue has a `queued` row, the run uses the oldest one. Only when the
   queue is empty does the agent propose its own topic.
3. A proposed topic must not duplicate anything already **published or drafted**. The
   published set comes from `BLOG_FEED_URL`; the drafted set comes from the blog repo,
   because posts with `draft: true` are absent from the feed. At the time of writing the
   repo holds 33 posts and the feed 30 — the 3 missing are all unpublished drafts.
4. An article already seen in a previous run is not re-read or re-summarized.
5. **The grounding gate.** A run produces a pull request only if it has at least one
   source carrying an **attributable R&D practice or research finding** (a paper, a
   published practice, survey data, a vendor engineering writeup), corroborated by at
   least one further independent source. Otherwise it records why and opens nothing.
   A raw article count is the wrong shape: at a two-day cadence the good case is one
   solid sourced practice, not three pieces of commentary.
6. Inference spend is accumulated across steps and checked **between** calls, against
   `NEURON_BUDGET_PER_RUN` (6,000 of the 10,000 daily neurons). Cost is only known once
   a call returns, so a run may overshoot by at most one article call; the gate reserves
   headroom for the synthesis call so it is never the call that is skipped. On reaching
   the ceiling the run stops summarizing and proceeds with what it has, or records a
   partial outcome.
7. The pull request body contains the research brief with a link to every source used.
   The committed file is `src/content/blog/<slug>/index.mdx` and its frontmatter
   validates against `src/content.config.ts` (see below).
10. Every generated post sets `draft: true`, and omits `image`.
8. The agent never pushes to `BLOG_BASE_BRANCH` and never merges.
9. Every run writes exactly one row to `runs`, whatever the outcome.

## Design

### Pipeline

```
cron (06:00 UTC, every 2nd day of month)
  └─> ResearchWorkflow instance
        select-topic            queue first, else propose from archive + feeds
        load-sources            read the allowlist
        gather:<source>         ── one step per feed ──┐  fetch, parse, apply the
                                                          30-day window; no D1
        shortlist               cap at 4,000, batched seen_urls, rank vs topic, cap at 15
        summarize:<url>         ── one step per article ──┐  fetch, extract, 1 LLM call
        synthesize              1 LLM call: brief + draft
        open-pull-request       branch, commit, PR
        record-*                write the runs row
```

The step boundaries are load-bearing, not cosmetic. The free plan allows 10 ms of CPU
per step and 50 subrequests per step; one feed or one article per step keeps both well
inside budget, and gives Workflows a natural retry unit. This is also why orchestration
cannot live in the `scheduled()` handler, which is capped at 15 minutes of wall-clock
for the whole run.

#### The recency window in `gather`

`gather:<source>` emits only items **published in the last 30 days**. Items with no
parseable date are kept, newest-first, up to **20 per feed**. Both rules are applied in
the gather step, per feed, never in `shortlist`.

**The window is the point of the pipeline, not a workaround.** This agent reports on what
is happening now, at a two-day cadence; an article from 2019 is not news and the archive
it sits in has been indexed by everything else on the internet for years. Discovery is
scoped to recent publication because that is what the blog is for. The platform arithmetic
below is a second, independent reason to want the same rule.

That arithmetic: the 34 syndicated feeds carry *whole archives* rather than a rolling
window — 372 items for The Batch, 232 for Paul Graham, 256 for Anthropic News — and the
first-party list already had one (`openai.com/blog/rss.xml`, 1,149 items). Fetched together
on 2026-08-26 the 46 feeds yield **4,742 items**, nearly all years old and already
summarized, rejected or seen on an earlier run.

`shortlist` checks candidates against `seen_urls` in one batched pass, and D1 caps a query
at **100 bound parameters** and an invocation at **50 queries** (free plan). Unwindowed,
4,742 candidates is **48 chunked queries of the 50 available** — inside the limit by two,
on a number that rises every time any of these archives gains a post. Applying the window
on the same day gives **678 candidates, 7 queries**.

**There is deliberately no flat per-feed cap on dated items.** The obvious version of this
rule — take the 20 newest from each feed — is wrong here, and wrong in the most expensive
direction. arXiv publishes a whole day's announcements in one feed: `cs.AI` carries 352
items and `cs.SE` 62, all dated, all inside the window. A 20-item cap would discard 94% of
`cs.AI`, and arXiv is where the *papers* come from — the material requirement 5 gates on.
The cap that would have bounded D1 is the cap that would have starved the grounding gate.

The date window bounds the common case; the aggregate ceiling below bounds the pathological
one. Per-feed truncation of dated items does neither without cost.

#### The aggregate ceiling in `shortlist`

The window bounds what feeds *usually* return, not what they *can* return: a source that
dumps its archive with fresh timestamps would pass it untouched. `shortlist` therefore
takes at most **4,000 candidates**, newest first, before it queries `seen_urls` — 40 of
the 50 available queries, ten spare for everything else the step does.

Measured on 2026-08-26, none of the three bounds binds: 681 candidates against a 4,000
ceiling, 7 queries against 50, zero undated items across all 46 feeds. They exist so the
failure is a truncated shortlist rather than a step that dies on a D1 limit.

Both are discovery filters only. They bound what a *run* considers; `seen_urls` remains
the cross-run dedupe key, and a genuinely old article reaches the pipeline through the
topic queue rather than through `gather`.

### Data model (D1, database `blog_research`)

```sql
CREATE TABLE topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  angle      TEXT,
  status     TEXT NOT NULL CHECK (status IN ('queued','in_progress','done','rejected')),
  origin     TEXT NOT NULL CHECK (origin IN ('human','agent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE seen_urls (
  url        TEXT PRIMARY KEY,
  title      TEXT,
  source     TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE runs (
  instance_id   TEXT PRIMARY KEY,
  topic_id      INTEGER REFERENCES topics(id),
  status        TEXT NOT NULL,
  neurons_spent INTEGER NOT NULL DEFAULT 0,
  sources_used  INTEGER NOT NULL DEFAULT 0,
  pr_url        TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);

CREATE TABLE drafts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL REFERENCES runs(instance_id),
  slug    TEXT NOT NULL,
  title   TEXT NOT NULL,
  pr_url  TEXT,
  state   TEXT NOT NULL
);
```

`seen_urls` is the dedupe key across runs, queried in one batched pass in `shortlist`
rather than once per candidate: D1 allows 50 queries per invocation and 100 bound
parameters per query, and a single feed can carry many times more items than either. The
batch is therefore chunked at 100 URLs per query, and the 30-day window in `gather` is
what keeps the chunk count in single figures — 7 rather than 49. `runs.neurons_spent` is what makes requirement 6 auditable after
the fact.

### Source allowlist

RSS and Atom only: no API key, no search-provider spend, which is what makes the
free-inference constraint hold end to end. 46 discovery feeds plus the blog's own
archive; all 47 were fetched live on 2026-08-26 and returned 200.

#### First-party feeds (12 + the archive)

Published by the source itself, at a URL the source controls.

| Source | Feed | Why |
|---|---|---|
| The blog's own archive | `https://nimeshjm.com/rss.xml` | Voice matching and "already covered" dedupe. Carries full post bodies in `content:encoded`. |
| arXiv cs.SE | `http://export.arxiv.org/rss/cs.SE` | Software engineering research |
| arXiv cs.AI | `http://export.arxiv.org/rss/cs.AI` | AI research |
| OpenAI | `https://openai.com/blog/rss.xml` | Vendor capability announcements |
| Cloudflare | `https://blog.cloudflare.com/rss/` | Platform and agent infrastructure |
| GitHub | `https://github.blog/feed/` | Developer tooling and AI in the SDLC |
| Stack Overflow | `https://stackoverflow.blog/feed/` | Practitioner adoption data |
| Martin Fowler | `https://martinfowler.com/feed.atom` | Architecture and practice |
| Will Larson | `https://lethain.com/feeds.xml` | Engineering leadership and org design |
| Simon Willison | `https://simonwillison.net/atom/everything/` | Hands-on LLM practice |
| The Pragmatic Engineer | `https://newsletter.pragmaticengineer.com/feed` | Industry reporting |
| DX | `https://newsletter.getdx.com/feed` | Developer productivity research |
| Honeycomb | `https://www.honeycomb.io/feed` | Observability, incl. for agents |

**`danluu.com/atom.xml` was in this list and has been removed.** It is a full-archive Atom
feed: 6.15 MiB and 128 items, of which **3** fell inside the 30-day window on 2026-08-26.
It was 55% of every byte the run fetched and 0.4% of the candidates, and at 6.15 MiB it was
the single largest parse in the pipeline — the one feed most likely to break the 10 ms
per-step CPU budget. Long-form retrospectives are also the genre the recency window is
least able to serve. Do not re-add it without a per-feed streaming cap.

#### Syndicated feeds (34), via `Olshansk/rss-feeds`

These 34 sources publish no usable feed of their own. [`Olshansk/rss-feeds`][olsh] scrapes
each one on a schedule and commits the generated XML, so the feed is a **third-party
reconstruction**, not the publisher's own. Base URL, prepended to every `File` below:

```
https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/
```

The ref is `refs/heads/main`, deliberately unpinned. The `otel_span.py` precedent in
`CLAUDE.md` — vendor at a SHA so drift is visible — inverts here: pinning a feed would
freeze its contents, which is the one thing a feed must not do.

| Source | File | Items | Latest item | Why |
|---|---|---|---|---|
| Anthropic News | `feed_anthropic_news.xml` | 256 | 2026-08-14 | Vendor capability announcements |
| Anthropic Engineering | `feed_anthropic_engineering.xml` | 25 | 2026-04-23 | Agent engineering practice, first-hand |
| Anthropic Research | `feed_anthropic_research.xml` | 17 | 2026-08-13 | Research findings |
| Anthropic Frontier Red Team | `feed_anthropic_red.xml` | 21 | 2026-06-03 | Evaluation and model-risk findings |
| Claude | `feed_claude.xml` | 226 | 2026-08-25 | Applied-agent writeups |
| OpenAI Developer | `feed_openai_developer.xml` | 25 | 2026-08-25 | Developer-facing platform change |
| OpenAI Engineering | `feed_openai_engineering.xml` | 19 | 2026-08-03 | Vendor engineering writeups |
| OpenAI Research | `feed_openai_research.xml` | 194 | 2026-07-08 | Research findings |
| Google Developers — AI | `feed_google_ai.xml` | 10 | 2026-08-24 | Developer tooling |
| AI at Meta | `feed_meta_ai.xml` | 88 | 2026-07-21 | Research and open-weight releases |
| Mistral AI | `feed_mistral.xml` | 54 | 2026-04-29 | Model releases |
| Cohere | `feed_cohere.xml` | 50 | 2026-03-03 | Applied enterprise LLM practice |
| xAI | `feed_xainews.xml` | 39 | 2026-05-19 | Model releases |
| Cursor | `feed_cursor.xml` | 18 | 2026-08-18 | AI inside the IDE — squarely on-topic |
| Windsurf Blog | `feed_windsurf_blog.xml` | 181 | 2026-05-06 | AI coding-agent product practice |
| Windsurf Changelog | `feed_windsurf_changelog.xml` | 118 | 2026-05-17 | Shipping cadence of a coding agent |
| Windsurf Next Changelog | `feed_windsurf_next_changelog.xml` | 147 | 2026-05-22 | Pre-release channel of the above |
| Ollama | `feed_ollama.xml` | 57 | 2026-08-11 | Local inference, the self-hosted end |
| Groq | `feed_groq.xml` | 24 | 2026-02-16 | Inference infrastructure and cost |
| Perplexity | `feed_perplexity_hub.xml` | 117 | 2026-05-14 | Retrieval product practice |
| Pinecone | `feed_pinecone.xml` | 125 | 2026-08-12 | Vector search and RAG practice |
| Weaviate | `feed_weaviate.xml` | 60 | 2026-08-11 | Vector search and RAG practice |
| Dagster | `feed_dagster.xml` | 187 | 2026-07-30 | Data-platform engineering practice |
| Surge AI | `feed_blogsurgeai.xml` | 48 | 2026-08-18 | Human evaluation and labelling practice |
| The Batch (DeepLearning.AI) | `feed_the_batch.xml` | 372 | 2026-05-22 | Weekly research roundup |
| UK AI Safety Institute | `feed_aisi.xml` | 95 | 2026-07-23 | Evaluation methodology, publicly funded |
| FAR.AI | `feed_far_ai.xml` | 58 | 2026-02-19 | Safety and evaluation publications |
| Goodfire | `feed_goodfire.xml` | 38 | 2026-06-23 | Interpretability research |
| Transluce | `feed_transluce.xml` | 13 | 2025-12-18 | Interpretability and auditing research |
| Timaeus | `feed_timaeus.xml` | 19 | 2026-01-20 | Learning-theory research |
| EleutherAI Papers | `feed_eleuther_papers.xml` | 5 | 2025-08-25 | Open research output |
| Paul Graham Essays | `feed_paulgraham.xml` | 232 | 2026-06-01 | Long-form essays on building |
| Chander Ramesh | `feed_chanderramesh.xml` | 8 | 2025-02-08 | Individual practitioner essays |
| AI FIRST Podcast | `feed_ai_first_podcast.xml` | 3 | 2026-08-14 | Practitioner interviews on adoption |

[olsh]: https://github.com/Olshansk/rss-feeds/tree/main/feeds

Three things follow from this table that the design has to answer, below: the archives
are **whole** rather than rolling, several sources are **already stale**, and four of them
**overlap** feeds already in the first-party list.

**Anthropic is now covered — by reconstruction, not by a first-party feed.** The previous
version of this spec recorded that Anthropic's blog was wanted and unavailable, because
neither `anthropic.com/news` nor `/engineering` exposes a discoverable RSS or Atom feed.
That is still true of Anthropic; the gap is closed by five scraped feeds above
(`_news`, `_engineering`, `_research`, `_red`, `feed_claude`). If a first-party feed ever
appears, move those rows to the first-party table — the scraper is a workaround, not the
preferred source.

**Overlap is tolerated, not deduped by hand.** `openai.com/blog/rss.xml` is already in the
first-party table and returns 1,149 items covering the same ground as
`feed_openai_research`, `_developer` and `_engineering`. Duplicate *sources* are harmless
because dedupe is per-URL in `seen_urls`, and the scraped feeds carry the publisher's own
canonical links. Duplicate *items* cost nothing: they collapse in `shortlist` before any
inference happens. Removing the overlap by hand would be guesswork about which feed
carries a given article first.

**Staleness is the failure mode here, not death.** Six sources have not published in over
six months as of 2026-08-26 (`eleuther_papers` 2025-08, `transluce` 2025-12,
`chanderramesh` 2025-02, `timaeus` 2026-01, `groq` 2026-02, `far_ai` 2026-02). Some of
that is the source being quiet; some may be the scraper having broken. A scraped feed that
breaks still returns 200 and still parses — see the risks table.

The list lives in a version-controlled file so changes to it go through review like any
other change.

### Inference

Two prompt shapes, both on `@cf/openai/gpt-oss-120b` via `src/lib/llm.ts`:

- **map** — one call per article: article text in, structured summary out (summary,
  relevance score, extracted claims). Small input, small output, ~15 per run.
- **reduce** — one call: topic plus all summaries in, brief and draft out. Applies the
  `blog-voice` skill. The agent grounds the draft in a **sourced R&D practice for the
  SDLC**, never in an invented incident: it emits an
  `<!-- OPENING INCIDENT: needs a real example -->` marker where the author's own war
  story belongs. Ranking in `shortlist` should therefore favour material that carries an
  attributable practice or finding over commentary.

Map-reduce rather than one long-context call. The model holds 128k, so this is not a
context workaround: it keeps each step's parse inside 10 ms of CPU, bounds spend per
article rather than per run, and lets a single failed article retry on its own.

Estimated cost per run at 31,818 neurons/M input and 68,182/M output. The summary row is
now **measured**, not assumed: [#18](https://github.com/nimeshjm/blog-research-agent/issues/18)
found `@cf/openai/gpt-oss-120b` is a reasoning model whose thinking is billed inside
`completion_tokens` alongside `content`, so the original table (below, historical) assumed
*produced-text* length rather than the true completion cost. `plan.md` step 2 closed that
gap with two real `complete()` calls, through `createLlm()` and AI Gateway, at production
prompt size, deliberately spanning easy and hard: an off-topic legacy-modernization article
(Martin Fowler's "Patterns of Legacy Displacement," a first-party allowlist feed — the model
scored it `relevance: 0.2`) and a squarely on-topic one (Anthropic's "How we built our
multi-agent research system" — `relevance: 0.93`), both summarized with the step-5 map
prompt's shape. Reasoning tracks task difficulty, not article length, so a single easy
sample would not have been evidence for the fifteen the pipeline actually runs; both raw
envelopes are recorded in the body of the pull request that closed #18.

| Article | Input tokens | Output tokens (content + reasoning) | Neurons | `finish_reason` |
|---|---|---|---|---|
| Fowler, "Legacy Displacement" (relevance 0.2) | 5,987 | 464 | 223 | `stop` |
| Anthropic, "Multi-agent research system" (relevance 0.93) | 4,946 | 669 | 203 | `stop` |

The on-topic article produced 44% more completion tokens than the off-topic one — reasoning
did scale with difficulty, as #18 predicted — but its neuron cost still came in *lower*,
because its input was shorter and input tokens outweigh the difference at these ratios.
Both land comfortably inside the `SUMMARY_NEURON_ESTIMATE = 300` the budget gate in
`src/workflow.ts` already used, so that constant is unchanged. Neither call was truncated.

| Stage | Tokens | Neurons |
|---|---|---|
| 15 article summaries | 89.8k in, 7.0k out (× the higher-cost of the two measured articles, 5,987 in / 464 out) | ~3,332 |
| 1 synthesis | 12k in, 6k out (still assumed — step 5 measures this) | ~800 |
| **Total** | | **~4,132 of 10,000/day** |

The projection uses the higher-neuron measurement of the two (Fowler, 223/article) rather
than an average, to stay conservative. Two samples are still not fifteen, but they now
bracket both ends of the relevance range the grounding gate cares about, and the fact that
the harder sample cost *less* (shorter input outweighed longer reasoning) is itself evidence
against "harder article always costs more." The projected total, synthesis estimate
included, leaves ~1,868 of headroom under `NEURON_BUDGET_PER_RUN` (6,000).

**Growing the allowlist from 13 feeds to 46 does not move this number.** Inference happens
in exactly two places — `summarizeArticle`, capped at 15 by `shortlist`, and one
`synthesizeDraft` call. `gatherCandidates` and `shortlistCandidates` take no `Ai` binding
and never will: discovery is fetch, parse and rank, and ranking is heuristic. The cap on
summaries is what sets the bill, so the source count is invariant to it. More feeds buy a
better-chosen 15, not a larger 15.

What the extra 34 feeds do move is everything measured in steps, bytes and CPU:

| Per run | 13 feeds (before) | 46 feeds (after) | Headroom |
|---|---|---|---|
| Neurons | ~4,132 | ~4,132 | 10,000/day |
| `gather` steps | 13 | 46 | — |
| Steps total | ~34 | ~67 | 1,024 per instance |
| Feed bytes fetched | 9.50 MiB | **4.99 MiB** | wall-clock is uncapped |
| Largest single feed | 6.15 MiB (`danluu.com`) | **0.73 MiB** (arXiv cs.AI) | 10 ms CPU per step |
| Items across all feeds | 1,921 | 4,742 | — |
| Candidates after the 30-day window | 592 | 678 | 4,000 ceiling in `shortlist` |
| `seen_urls` queries in `shortlist` | 6 | 7 | 50 per invocation |
| …were the window removed | 20 | **48** | 50 per invocation |

Three of those rows deserve reading twice. **Steps**: 67 of 1,024 is 7%, so feed count is
nowhere near the binding constraint — the allowlist could grow several times over before
steps mattered. **Bytes and largest-feed both fall despite tripling the feed count**, which
is not a rounding artefact: dropping `danluu.com` removed 6.15 MiB, and the biggest of the
34 additions is The Batch at 222 KiB. Per-step parse CPU was the one real pre-existing risk
in this design and this change *retires* it — the worst parse is now arXiv cs.AI at
743 KiB, an eighth of what it was. **The last row is the one that decides the change**:
unwindowed, 46 feeds need 48 of D1's 50 queries per invocation, so the recency window is
not hardening — it is what makes the allowlist shippable at this size. All measured on
2026-08-26; the counts move, the ratio is the point.

One row is worth reading a third time, because it is the honest summary of what this
change buys. The 34 feeds add **2,949 items** but only **86 candidates inside the 30-day
window** (592 → 678, of which 3 are lost with `danluu.com`). Most of what they carry is
archive: written years ago, already indexed, and outside the window on every run from here
on. The value of the addition is therefore not volume — it is the ~89 recent items a
fortnight from sources the first-party set does not cover, chiefly Anthropic, the
coding-agent vendors, and the evaluation labs.

### Target repo and post format

`nimeshjm/nimeshjm.com` — private, Astro, default branch `main`. Posts live at
`src/content/blog/<slug>/index.mdx` with images co-located in the same directory.

The collection schema, from `src/content.config.ts`:

```ts
z.object({
  title:       z.string(),
  description: z.string(),
  date:        z.coerce.date(),
  order:       z.number().optional(),
  image:       image().optional(),
  tags:        z.array(z.string()).optional(),
  authors:     z.array(z.string()).optional(),
  draft:       z.boolean().optional(),
})
```

Generated frontmatter is therefore exactly:

```yaml
title: "<title>"
description: "<one or two sentence hook stating the tension>"
authors: ['nimeshjm']
date: "<yyyy-mm-dd>"
tags: ["<from the existing tag vocabulary>"]
draft: true
```

Three rules, each with a concrete failure behind it:

- **`draft: true` always.** A second safety layer under the merge gate: even a merged
  agent draft does not appear on the site. Matches how the author's own three
  in-progress drafts are marked.
- **Omit `image`.** The schema uses Astro's `image()` helper, which resolves the path to
  a real file at build time. Emitting `image: './header.svg'` without committing that
  file **breaks the site build**. All three existing `draft: true` posts have no
  `image` key; every published post does. Header images are a publishing step, and image
  generation is a non-goal.
- **Slug is kebab-case, no spaces.** One existing directory contains a space
  (`ai-developing agents`); do not copy that.

`src/content.config.ts` is the source of truth. The PR step reads it (or the most recent
existing post) rather than trusting the copy above, so a schema change upstream surfaces
as a failed step instead of a broken build.

Branch name `research/<yyyy-mm-dd>-<slug>`. Base `BLOG_BASE_BRANCH`. The PR body is the
research brief; the committed file is the draft.

## Platform constraints applied

| Constraint | How the design respects it |
|---|---|
| 10 ms CPU per step | One feed or one article per step; no aggregate parsing. Largest feed in the allowlist is 743 KiB (arXiv cs.AI); `danluu.com` was dropped at 6.15 MiB |
| 50 subrequests per step | A single fetch per step |
| 1,024 steps per instance | 46 feeds + 15 articles + 6 fixed = ~67 steps, 7% of the cap |
| D1: 100 bound params/query, 50 queries/invocation | The 30-day window in `gather` takes 4,742 raw items to 678 candidates (7 chunked queries, measured); `shortlist`'s 4,000 ceiling bounds the pathological case at 40 |
| Cron 15 min wall-clock | Cron only creates the instance; steps have no wall-clock cap |
| 10,000 neurons/day | ~4,132 per run (measured, #18), hard-stopped at `NEURON_BUDGET_PER_RUN` |
| Steps are retried | Every step body must be idempotent (enforced by `REVIEW.md` pass 3) |
| 5 cron triggers | One used |
| No paid search | Feeds only |

## Acceptance criteria

1. `npx wrangler deploy --dry-run` resolves every binding.
2. A manually triggered run with a queued topic opens a pull request against
   `BLOG_REPO` on a `research/*` branch, and `BLOG_BASE_BRANCH` is unchanged.
3. The PR's file is at `src/content/blog/<slug>/index.mdx`, parses as valid MDX, has
   `draft: true`, has no `image` key, and validates against `src/content.config.ts`.
   Checking out the branch and running the blog's own build succeeds.
4. A second run on the same day re-reads no article present in `seen_urls`.
5. With an empty queue, a run proposes a topic that duplicates neither the published
   feed nor any `draft: true` post in the repo.
6. A run whose sources carry no attributable practice, or only one source in total,
   opens no PR and writes a `runs` row with status `insufficient_sources` — even if
   several articles were summarized.
7. `runs.neurons_spent` is populated for every run, is checked between steps, and
   exceeds `NEURON_BUDGET_PER_RUN` by no more than the cost of a single article call.
8. Each run stays inside a single day's free allocation. `*/2` is day-of-month, so the
   31st and the 1st are consecutive; both must still succeed, which they do because the
   allowance resets daily and one run costs ~4,132 of 10,000 (measured, #18).
9. Every feed in the allowlist returns 200 and parses. `gather` emits no *dated* item
   published more than 30 days ago, and no more than 20 *undated* items from any one
   feed; it does not truncate a feed's dated items, so a full arXiv day survives intact.
   `shortlist` takes at most 4,000 candidates and its chunked `seen_urls` batch stays
   under 50 D1 queries.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Draft quality is below what is worth reviewing | Framed as brief + draft for a human rewrite, not a finished post. If it stays unusable, swap the model behind AI Gateway rather than lowering the merge bar. |
| A feed dies or changes format | One step per feed, so one failure does not fail the run; a dead feed is a review finding against the allowlist. |
| A syndicated feed silently freezes | 34 of the 46 feeds are scraped and committed by one third-party repo, so the interesting failure is not a 404 — a broken scraper keeps serving the last good XML, which still returns 200, still parses, and quietly stops being news. Six sources are already >6 months cold and it is not knowable from the feed which of those are quiet publishers. Mitigation is a review finding, not a step failure: audit `latest item` per source against the allowlist table on the same cadence the allowlist itself is reviewed. Cost of missing it is bounded — stale items fall outside the 30-day window and never reach inference. |
| The upstream feed repo disappears or rewrites paths | 34 feeds resolve through one `raw.githubusercontent.com` path. Losing it fails 34 gather steps, not the run: the first-party 12 still gather, and the grounding gate decides whether what is left is worth a draft. |
| Neuron budget overshoot | The gate is between calls and reserves synthesis headroom, so overshoot is bounded at one article call. A hard mid-call cap is not possible: cost is only known on return. |
| HTML extraction blows the 10 ms CPU budget on a large article | Use `HTMLRewriter` (streaming) rather than regex over the body; cap extracted length before it reaches the model. |
| A two-day cadence produces filler | Requirement 5 is the load-bearing guard and matters more at this cadence than at a weekly one. It gates on *grounding quality* rather than article count, so a cycle full of commentary produces nothing. Most cycles should produce nothing. |
| 15 runs/month rather than 4 | Each run is bounded by `NEURON_BUDGET_PER_RUN` and the allowance is per-day, so cadence does not change per-run cost. Watch `runs.neurons_spent` for drift. |
| Workflows is in open beta | Local and remote behaviour can differ; verify with `wrangler dev --remote` before trusting a local result. |
| Token leak via logs | `REVIEW.md` pass 2. |
| A generated post breaks the blog build | `image` omitted (the `image()` helper requires a real file) and frontmatter validated against `src/content.config.ts` before the PR is opened. |
| A merged draft publishes accidentally | `draft: true` on every generated post, independent of the merge gate. |
| Proposing a topic already drafted but unpublished | Dedupe reads repo drafts as well as the feed (requirement 3). |

## Deferred

- **Vectorize semantic dedupe** — v1 uses URL and title similarity in D1. Worth adding
  once there are enough runs for near-duplicate topics to actually show up.
- **A real search API** (Brave free tier) — widens discovery past the allowlist, but is
  neither Cloudflare nor key-free. Most likely second iteration.
- **Continuous evals** (playbook stage 4) — needs real drafts to evaluate first.
- **`bands.yaml` control-band monitoring** (playbook stage 6) — needs production traffic
  to band.
- **Auto-closing a topic row on merge** — open question in `intent.md`; needs a webhook
  or a second scheduled check.
- **An exact 48-hour cadence.** `0 6 */2 * *` fires on odd days, giving 179 two-day gaps
  and 7 one-day gaps a year (after each 31-day month). If a stable 48-hour rhythm is ever
  wanted, fire daily and no-op in the first step when `runs.started_at` is under ~40
  hours old — one extra D1 read on skipped days. Not worth the step today.
