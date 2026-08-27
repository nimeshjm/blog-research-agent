# Plan: Scheduled research drafts

> Stage 3. Produced by Claude in plan mode from the approved
> [`spec.md`](spec.md), then iterated until it is implementable without further
> conversation. Committed alongside the code.

## Context

[`intent.md`](intent.md) asks for a research-and-draft agent that runs unattended and
leaves a reviewable pull request behind; [`spec.md`](spec.md) fixes the pipeline, the D1
schema, the 46-feed allowlist, the grounding gate and the nine acceptance criteria. The
orchestration is already built and traced — `src/workflow.ts` wires eleven steps, the
budget gate, the grounding gate and the four `record-*` exits — but all eight step bodies
throw `NotImplemented`, there is no `migrations/` directory, and no `Llm` call has ever
been made at production prompt size. This plan is the work breakdown that closes that
gap: [#6](https://github.com/nimeshjm/blog-research-agent/issues/6) (schema),
[#18](https://github.com/nimeshjm/blog-research-agent/issues/18) (reasoning tokens), and
[#3](https://github.com/nimeshjm/blog-research-agent/issues/3) (the step bodies), in that
order, across five pull requests.

Two things drive the shape of the work more than the feature does. **The mechanical checks
in `REVIEW.md` constrain where code may live**, not just what it may do — three of them
decide file boundaries below rather than being satisfied after the fact. And **the neuron
arithmetic in `spec.md` is unverified**: `@cf/openai/gpt-oss-120b` is a reasoning model
whose thinking is billed as `completion_tokens`, so the ~4,300/run estimate is known to be
low by an unmeasured margin. Measuring it is step 2, before any inference-bearing body is
written.

## Files

### New

| File | What it holds |
|---|---|
| `migrations/0001_init.sql` | The four tables from `spec.md` → Data model, verbatim: `topics`, `seen_urls`, `runs`, `drafts`. Transcription, not design. |
| `config/feeds.json` | The 46-feed allowlist as data: `[{ name, feedUrl }]`. **Deliberately not under `src/`** — `rules/no-hardcoded-urls.yml` matches `https?://` string literals and is `language: TypeScript`, so 46 URLs in a `.ts` file would fire it 46 times while a JSON file is invisible to it. This is also the "version-controlled file" `spec.md` → Source allowlist asks for, reviewable like any other change. Needs `resolveJsonModule` in `tsconfig.json` — see below. |
| `src/lib/feeds.ts` | Typed loader over that JSON → `Source[]`. Carries no URL literal of its own. |
| `src/lib/d1.ts` | Every query against the four tables. Owns the chunked `seen_urls` lookup (100 bound params per query, ≤ 50 queries per invocation) and the `topics` status transitions. |
| `src/lib/feed.ts` | RSS **and** Atom parsing over `HTMLRewriter`, streaming, plus `GATHER_WINDOW_DAYS` / `GATHER_UNDATED_MAX_PER_FEED`. Streaming rather than string work is what keeps arXiv cs.AI (743 KiB, the largest feed) inside 10 ms of CPU. |
| `src/lib/extract.ts` | Article body → plain text over `HTMLRewriter`, truncated before it reaches a prompt. `REVIEW.md` pass 1 names regex-over-article-body as a reject. |
| `src/lib/github.ts` | GitHub REST client: read the base ref, create `research/*`, PUT the file, open the PR. **Takes `baseBranch` as a plain string parameter and never names the identifier `BLOG_BASE_BRANCH`** — `base-branch-not-a-write-target` flags any `src/` file that mentions that identifier *and* contains `refs/heads` or PUTs to `/contents/`, which the branch-creation call unavoidably does. Splitting the file is what keeps the check honest instead of suppressed. |
| `src/lib/mdx.ts` | Frontmatter emission and validation against the blog's `src/content.config.ts`. Never emits an `image` key; always `draft: true`; kebab-case slug with no space. |
| `src/lib/prompts.ts` | The two prompt shapes — map (one article) and reduce (brief + draft) — with the `blog-voice` rules as prompt text and the `<!-- OPENING INCIDENT: needs a real example -->` marker instruction. |
| `vitest.config.ts` | `@cloudflare/vitest-pool-workers`, pointed at `wrangler.toml` so tests get real bindings. |
| `test/*.test.ts` | Per-module suites; see Verification. |

### Modified

| File | Change |
|---|---|
| `src/workflow.ts` | The eight bodies replaced; `notImplemented()` deleted. Orchestration, step names, gates and constants are **not** touched — they are the part that already passes review. |
| `src/lib/llm.ts` | #18: `normalise()` falls back to `reasoning` / `reasoning_content`, reads `finish_reason`, and distinguishes "produced nothing" from "truncated mid-thought" in the thrown message. A `maxTokens` floor that leaves room to think. |
| `src/lib/types.ts` | Add whatever `feed.ts` and `github.ts` need (`FeedItem`, PR request/response shapes). The eight existing interfaces already match the spec and stay as they are. |
| `wrangler.toml` | Add `GITHUB_API_BASE` to `[vars]` so `github.ts` holds no URL literal (`no-hardcoded-urls`, and pass 5's "URLs read from `wrangler.toml` vars"). `NEURON_BUDGET_PER_RUN` revisited **only** if step 2's measurement says 6,000 no longer holds. |
| `tsconfig.json` | Two changes the JSON allowlist and the test suite both need: `resolveJsonModule: true`, without which `import feeds from '../../config/feeds.json'` fails `tsc --noEmit` with TS2732 — and `npm run typecheck` is CI's first row; and `include` widened past `src/**/*.ts` to cover `test/` and `vitest.config.ts`, which would otherwise never be typechecked at all. |
| `package.json` | `"test": "vitest run"`; `vitest` + `@cloudflare/vitest-pool-workers` devDependencies. |
| `.github/workflows/ci.yml`, `.githooks/pre-push` | `npm test` added alongside the existing gates. A test suite not in both is a test suite that stops running. |
| `features/001-scheduled-research-drafts/spec.md` | Step 0 un-stales the header block. Step 2 revises the "Estimated cost per run" table with the measured figure. `REVIEW.md` pass 4 requires the spec move in the same PR as the code that diverges from it. |
| `.claude/skills/blog-voice/SKILL.md` | Step 5 replaces the `TODO — sharpen the style rules` section with rules derived from all ten 2026 posts, and fixes the source-count line (below). |
| `features/README.md` | The 001 index row, which currently reads "At the stage 3 gate". |

## Work order

Each step is one branch and one pull request, and each leaves `main` green: unwritten
bodies keep throwing `NotImplemented`, which typechecks and passes every mechanical check.

### 0. This PR — the stage 3 gate (`#2`)

Documentation only, no code. Commit `plan.md`; un-stale `spec.md`'s header block, which
still says "**Awaiting approval** — nothing in here is implemented, and `plan.md` is
deliberately still the template" after
[#1](https://github.com/nimeshjm/blog-research-agent/issues/1) was closed as approved;
update the `features/README.md` index row. Drop the `blocked` label from
[#3](https://github.com/nimeshjm/blog-research-agent/issues/3) and
[#6](https://github.com/nimeshjm/blog-research-agent/issues/6).

**Leaves the repo:** unchanged in behaviour; the gate is now passed and code may be
written.

### 1. Schema (`#6`)

`migrations/0001_init.sql`, transcribed from `spec.md`. Apply local, then remote.

**Leaves the repo:** `npm run migrate:local` works for the first time — `CLAUDE.md`
currently records that it fails.

### 2. Reasoning tokens, and the first real inference call (`#18`)

The one step that is measurement before it is code, and the reason it comes before
anything inference-bearing. In order:

1. Stand up `vitest` + `@cloudflare/vitest-pool-workers`, `npm test`, and the CI/hook
   rows. `normalise()` is the first genuinely unit-testable function in the repo and is
   the natural first suite: the reasoning-only envelope from #18's issue body becomes a
   fixture.
2. Fix `normalise()` per #18 — `reasoning` / `reasoning_content` fallback,
   `finish_reason`, an error message that names truncation rather than pointing at the
   provider.
3. **Measure.** One `complete()` call at production prompt size — a real article of
   ~6,000 input tokens with the step 5 map prompt — and record `usage.completion_tokens`
   and `usage.neurons`. One call, not an extrapolation from #18's 32-token probe:
   reasoning length tracks task difficulty, not answer length.
4. Revise `spec.md`'s cost table with the measured per-summary figure × 15 + synthesis.
   If the total exceeds `NEURON_BUDGET_PER_RUN`, the lever is `SUMMARY_NEURON_ESTIMATE`
   and the shortlist cap of 15, not the budget — the 10,000/day allowance is the actual
   ceiling and `spec.md` acceptance criterion 8 depends on one run fitting inside a day.

**Leaves the repo:** a test suite, an `Llm` that survives a reasoning model, and a
neuron estimate that is measured rather than assumed.

### 3. Data and repo seams (`#3`, part 1 of 3)

`config/feeds.json`, `src/lib/feeds.ts`, `src/lib/d1.ts`, `src/lib/github.ts`,
`src/lib/mdx.ts`, plus the three step bodies that need no inference and no feed parsing:

- `selectTopic` — oldest `queued` row first; the `queued` → `in_progress` transition is
  conditional on current status rather than a blind `UPDATE`, so it is safe to replay. **The
  propose-when-empty half of this body (spec.md req. 3) moved to step 4**: it needs to read
  both `BLOG_FEED_URL` and the blog repo's `draft: true` posts, and neither read seam existed
  yet in this step — `feeds.ts` here is the allowlist *loader* only, and `github.ts` here is
  scoped to the branch/commit/PR write path, not a repo-content reader.
- `loadSources` — reads the allowlist through `feeds.ts`.
- `recordOutcome` — `INSERT … ON CONFLICT(instance_id) DO UPDATE`, keyed on the instance
  id. `spec.md` req. 9 wants exactly one row per run whatever the outcome, and steps
  retry.

`github.ts` and `mdx.ts` land here rather than in step 5 so the pull-request path is
reviewed on its own, away from the inference diff — it is the only part of the pipeline
that writes to another repository.

**Leaves the repo:** a run reaches `gather` and fails there.

### 4. Discovery (`#3`, part 2 of 3)

`src/lib/feed.ts`, two bodies, and `selectTopic`'s propose-when-empty path reassigned from
step 3: it needs `feed.ts` (new here) to read `BLOG_FEED_URL` and a new `listBlogPostSlugs`
read added to `github.ts` (which now exists, from step 3) to read the blog repo's `draft:
true` posts — both seams `selectTopic`'s propose path needs are only available starting
this step. Candidate generation itself is non-inference, per spec.md's "inference happens
in exactly two places": the newest still-uncovered item from the first allowlisted feed.

- `gatherCandidates` — one fetch, streamed parse, RSS and Atom. The 30-day window is
  applied **here**, per feed, never in `shortlist`. Dated items are filtered by date and
  never truncated by rank — a full arXiv announcement day (cs.AI 352 items) must survive
  intact, because that is where the papers the grounding gate needs come from.
  `GATHER_UNDATED_MAX_PER_FEED` applies only to items with no parseable date. No D1.
- `shortlistCandidates` — newest-first cap at `SHORTLIST_MAX_CANDIDATES` **before**
  touching D1, then `seen_urls` in chunks of 100 bound parameters, then heuristic ranking
  against the topic favouring attributable practice or finding over commentary, then a cap
  of 15. Ranking is heuristic and takes no `Ai` binding: `spec.md` is explicit that
  inference happens in exactly two places, which is what makes the feed count invariant to
  the neuron bill.

**Leaves the repo:** a run reaches `summarize` and fails there. `spec.md` acceptance
criterion 9 is testable at this point.

### 5. Inference and the pull request (`#3`, part 3 of 3)

Ordered inside the step, because the prompt depends on the style pass:

1. **The `blog-voice` style pass.** Read all ten 2026-era posts from `content:encoded` at
   `BLOG_FEED_URL` and replace the skill's `TODO — sharpen the style rules` section with
   rules derived from the set. The skill's own warning applies: do not bake in a hard rule
   on the strength of one sample. Filter `pubDate >= 2026` — the twenty 2012-2016 notes
   are 450-1,300 characters and would set a length target an order of magnitude wrong.
2. `src/lib/extract.ts`, `src/lib/prompts.ts`.
3. `summarizeArticle` — one fetch, streamed extraction, one `Llm` call, returns
   `{ summary, neurons }` with the cost from `neuronsFor()`. Returns `summary: null`
   rather than throwing on an article that cannot be extracted: one bad article must not
   fail a run.
4. `synthesizeDraft` — one `Llm` call producing brief and draft, with the incident marker
   instruction. Never invents a war story; that rule is the single most important one in
   the skill.
5. `openPullRequest` — validate frontmatter against the blog's `src/content.config.ts`
   (read it, do not trust the copy in `spec.md`), create `research/<yyyy-mm-dd>-<slug>`,
   commit `src/content/blog/<slug>/index.mdx`, open the PR with the brief as the body.
   Idempotent on retry: an existing branch or an already-open PR for the same slug is
   reused, not duplicated. Never pushes to the base branch.

**Also in this PR:** the `blog-voice` source-count line. The skill says "Fewer than 3
relevant sources means no draft at all"; `spec.md` req. 5 and `MIN_SOURCES = 2` in
`src/workflow.ts` say two, one of which must carry an attributable practice.
`features/README.md` makes the artifact authoritative for gates, so the spec is right and
the skill's line is what changes.

**Leaves the repo:** the feature complete, `notImplemented()` deleted, and `spec.md`'s
nine acceptance criteria checkable end to end.

## Reuse

Nothing in this plan introduces a second way to do something the repo already does.

- **Tracing** — `traced`, `tracedStep`, `tracerFor` (`src/lib/trace.ts`) and the exported
  `ATTR_*` constants. No new file imports `tracing`; no new `step.do` bypasses
  `tracerFor`. `span-attributes-allowlisted` reads its allowlist out of `trace.ts`, so a
  new attribute means a new exported constant there, not a string literal at a call site.
- **Inference** — `createLlm()` and the `Llm` interface, and `neuronsFor()` for cost.
  `env.AI.run` stays a single call site in `src/lib/llm.ts`.
- **Types** — the eight interfaces in `src/lib/types.ts` (`Topic`, `Source`, `Candidate`,
  `ArticleSummary`, `Draft`, `RunOutcome`, `ResearchParams`, `Env`) are already written
  against this spec, including `ArticleSummary.attributablePractice`, which is the field
  the grounding gate reads.
- **Orchestration** — `isGrounded()`, `MIN_SOURCES`, `MIN_PRACTICES`,
  `SUMMARY_NEURON_ESTIMATE`, `SYNTHESIS_NEURON_RESERVE`, `GATHER_WINDOW_DAYS`,
  `GATHER_UNDATED_MAX_PER_FEED`, `SHORTLIST_MAX_CANDIDATES`, and the four `record-*`
  exits all exist and are correct. The bodies fill in around them.
- **Config** — `BLOG_REPO`, `BLOG_BASE_BRANCH`, `BLOG_FEED_URL`, `LLM_MODEL`,
  `AI_GATEWAY`, `NEURON_BUDGET_PER_RUN` are `wrangler.toml` vars already; `GITHUB_TOKEN`
  is already a secret. Only `GITHUB_API_BASE` is new.
- **`HTMLRewriter`** — the platform's streaming parser, for both feed and article parsing.
  It is what `spec.md`'s risk table names as the mitigation for the 10 ms budget.

## Verification

### Per step

| Step | Command | What proves it |
|---|---|---|
| 0 | `npm run review:checks -- --pr <N>` | `checks-and-docs-in-sync` and `branch-carries-issue` pass; `plan.md` is no longer the template. |
| 1 | `npm run migrate:local` then `npm run migrate:remote` | Applies cleanly to both. `CLAUDE.md`'s note that it fails is deleted. |
| 2 | `npm test` | The reasoning-only envelope from #18 normalises to text instead of `''`; a truncated response throws an error naming truncation. The measured `completion_tokens` is recorded in `spec.md`. |
| 3 | `npm test`, `npx wrangler deploy --dry-run` | `seen_urls` chunking issues ⌈n/100⌉ queries against real D1 in the workers pool; `recordOutcome` called twice leaves one row; frontmatter emission carries `draft: true` and no `image` key. |
| 4 | `npm test` | A fixture feed with items inside and outside 30 days emits only the former; a 352-item all-dated feed is not truncated; an undated feed is capped at 20; 4,742 fixture candidates cap at 4,000 and issue ≤ 50 queries. Both RSS and Atom fixtures parse. |
| 5 | `npm test`, then the end-to-end run below | A stub `Llm` drives `summarizeArticle` and `synthesizeDraft`; `openPullRequest` run twice against a fixture produces one PR. |

### End to end (`spec.md` acceptance criteria)

Every step also runs the full existing gate set, which is what the pre-push hook and CI
already do: `npm run typecheck`, `lint:ast`, `test:ast`, `lint:ts`, `review:checks`,
`test:checks`, `test:plan-metrics`, `npx wrangler deploy --dry-run`.

```bash
# 1. Bindings resolve (criterion 1) - offline, no credentials.
npx wrangler deploy --dry-run

# 2. Queue a topic, then trigger a real run (criteria 2, 3, 7).
npx wrangler d1 execute blog_research --remote \
  --command "INSERT INTO topics (title, angle, status, origin) VALUES ('<title>', '<angle>', 'queued', 'human')"
npx wrangler dev --remote     # then invoke the scheduled handler
```

The run is proven by four things, in this order:

1. A pull request exists on `nimeshjm/nimeshjm.com`, on a `research/*` branch, with the
   brief as its body and every source linked (criteria 2, 7 of `spec.md` req. 7).
   `BLOG_BASE_BRANCH` is unchanged — check the base branch's SHA before and after.
2. Its file is `src/content/blog/<slug>/index.mdx`, has `draft: true`, has **no** `image`
   key, and **the blog's own build succeeds on that branch** (criterion 3). This is the
   only check that catches a frontmatter break, and it runs in the blog repo, not here.
3. `SELECT * FROM runs` has exactly one row for the instance id, with `neurons_spent`
   populated and no more than `NEURON_BUDGET_PER_RUN + SUMMARY_NEURON_ESTIMATE`
   (criteria 7, 9 of req. 6).
4. A second run the same day re-reads nothing: the `summarize:*` step count is zero, or
   every candidate was already in `seen_urls` (criterion 4).

Then the two negative cases, which matter more than the happy path because `spec.md` says
most cycles should produce nothing:

- **Empty queue** (criterion 5) — a proposed topic duplicates neither the feed nor a
  `draft: true` post in the repo.
- **Ungrounded run** (criterion 6) — sources carrying no attributable practice open no PR
  and write a `runs` row with status `insufficient_sources`, even after articles were
  summarized.

Traces are the fifth check and cost nothing extra: one run should appear in the Workers
dashboard as ~67 spans sharing one `agent.workflow.instance_id`, with `agent.neurons`
on each `chat` span summing to `runs.neurons_spent`. A step missing from that trace is a
`step.do` that bypassed `tracerFor`, which `no-bare-step-do` should have caught.
