# Spec: Scheduled research drafts

> Stage 2. Written from the approved `intent.md`. **Awaiting approval** — nothing in
> here is implemented, and `plan.md` is deliberately still the template.

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
        gather:<source>         ── one step per feed ──┐  fetch and parse only, no D1
        shortlist               one batched seen_urls query, rank vs topic, cap at 15
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

`seen_urls` is the dedupe key across runs, queried once per run in `shortlist` rather
than once per candidate: D1 allows 50 queries per invocation and a single feed can carry
more items than that. `runs.neurons_spent` is what makes requirement 6 auditable after
the fact.

### Source allowlist

RSS and Atom only: no API key, no search-provider spend, which is what makes the
free-inference constraint hold end to end. All 13 were checked live and returned 200
when this spec was written.

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
| Dan Luu | `https://danluu.com/atom.xml` | Long-form engineering analysis |

Anthropic's blog was wanted and is **not** included: neither `anthropic.com/news` nor
`/engineering` exposes a discoverable RSS or Atom feed. Revisit if one appears.

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

Estimated cost per run at 31,818 neurons/M input and 68,182/M output:

| Stage | Tokens | Neurons |
|---|---|---|
| 15 article summaries | 90k in, 9k out | ~3,500 |
| 1 synthesis | 12k in, 6k out | ~800 |
| **Total** | | **~4,300 of 10,000/day** |

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
| 10 ms CPU per step | One feed or one article per step; no aggregate parsing |
| 50 subrequests per step | A single fetch per step |
| Cron 15 min wall-clock | Cron only creates the instance; steps have no wall-clock cap |
| 10,000 neurons/day | ~4,300 per run, hard-stopped at `NEURON_BUDGET_PER_RUN` |
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
   allowance resets daily and one run costs ~4,300 of 10,000.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Draft quality is below what is worth reviewing | Framed as brief + draft for a human rewrite, not a finished post. If it stays unusable, swap the model behind AI Gateway rather than lowering the merge bar. |
| A feed dies or changes format | One step per feed, so one failure does not fail the run; a dead feed is a review finding against the allowlist. |
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
