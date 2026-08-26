# Review passes

Every pull request in this repo gets the same passes, in this order. Findings are ranked
by severity; a human approves the merge regardless of what the review says.

Run with: `/code-review` (add `--comment` to post findings inline on a PR).

## Mechanical checks

A large share of the bullets below are not judgement calls — they are mechanically
decidable from the tree. Two tools enforce that decidable subset, and each bullet is
marked with the check id that covers it, or `(manual)` when a human (or the LLM pass)
still has to judge it.

| marker | tool | run with | proved by |
|---|---|---|---|
| `(ast-grep: <id>)` | [ast-grep](https://ast-grep.github.io) rules in `rules/*.yml` | `npm run lint:ast` | `npm run test:ast` |
| `(mechanical: <id>)` | `scripts/review-checks.mjs` | `npm run review:checks` | `npm run test:checks` |

Both run in the pre-push hook (`npm run hooks:install`) and in CI.

**Why two.** ast-grep expresses "this construct, only in this file" declaratively, and
`ast-grep test` classifies a rule that stops matching as **Missing** — so a rule that
silently matches nothing fails loudly instead of passing green. Everything that survives
in `review-checks.mjs` is there because no off-the-shelf tool can express it: cross-file
aggregation (`step-names-unique`), positive-presence assertions
(`budget-read-from-env`), callee resolution through a `tracerFor(...)` binding
(`step-names-static`), an allowlist read dynamically out of `src/lib/trace.ts` so it
cannot drift (`span-attributes-allowlisted`), git index and history state, and TOML
key-name policy. Those keep the sentinel minimums (>= 11 step names, >= 8 attribute
sites) that make a matcher which stops matching fail rather than pass vacuously.

A marker naming an id does not mean the bullet is *fully* covered. The LLM pass still
runs in full; the mechanical checks only narrow what it has to spend judgement on.

## Pass 1 — Free-tier limit violations (Important)

The failure mode this repo is most exposed to. Reject on:

- CPU-heavy work inside a single step: parsing multiple feeds or articles in one
  `step.do`, large `JSON.parse` of aggregate payloads, regex over full article bodies in
  a loop. The budget is 10 ms of CPU per step. (manual)
- More than a handful of subrequests in one step (cap is 50). (manual)
- Inference that can exceed `NEURON_BUDGET_PER_RUN`, or a loop over articles with no
  cap on iterations. The daily allowance is 10,000 neurons total.
  (mechanical: `inference-loop-has-break`)
- Logic moved from the Workflow back into `scheduled()`, which is capped at 15 min
  wall-clock and 10 ms CPU for the entire run. (ast-grep: `scheduled-stays-thin`)

## Pass 2 — Secret handling (Important)

- No token, key, or PAT in `wrangler.toml`, source, tests, or fixtures.
  (mechanical: `wrangler-vars-are-not-secrets`, for a `[vars]` key *named* like a secret.
  The literal-value half is enforced by **GitHub secret scanning push protection**, which
  is enabled on this repo and blocks the push server-side — strictly stronger than a local
  regex a developer can `--no-verify` past. The hand-rolled `no-credential-literals` check
  was deleted in favour of it.)
- `.dev.vars` must stay gitignored. (mechanical: `dev-vars-untracked`)
- `GITHUB_TOKEN` must remain fine-grained and scoped to the blog repo, with
  `contents: write` and `pull_requests: write` only. (manual — a GitHub account setting,
  not decidable from the repo)
- No secret value in a `console.log` or an error message. (ast-grep:
  `no-secret-in-console` — covers `console.*` arguments; an error message that leaks a
  secret elsewhere stays manual)
- No prompt, article text, completion, URL, or error `message` in a span attribute.
  (mechanical: `span-attributes-allowlisted`)

## Pass 3 — Workflow step correctness (Important)

- Every `step.do` body is idempotent — steps are retried on failure. A step that
  inserts, posts, or opens a PR must be safe to run twice. (manual)
- Step names are stable and unique within a run; a name derived from mutable state
  breaks replay. (mechanical: `step-names-unique`, `step-names-static`)
- No unhandled rejection that would retry an already-successful side effect. (manual —
  needs type-aware lint; follow-up issue, not taken on here)

## Pass 4 — Spec conformance (Important)

- The change matches the acceptance criteria in the feature's `spec.md`. If it does not,
  the spec is updated in the same PR, not silently diverged from. (manual)
- The agent still writes to branches only and never to `BLOG_BASE_BRANCH`. (mechanical:
  `base-branch-not-a-write-target` — forward-looking: today's step bodies are all
  `notImplemented()`, so this guards the build rather than today's tree)

## Pass 5 — Simplification and reuse (Nit)

- Duplicated fetch/parse/retry logic that belongs in `src/lib/`. (manual)
- Inference called anywhere other than through the `Llm` interface. (ast-grep:
  `ai-run-only-in-llm`)
- Model IDs, budgets, or URLs hardcoded instead of read from `wrangler.toml` vars.
  (ast-grep: `no-hardcoded-model-id`, `no-hardcoded-urls`;
  mechanical: `budget-read-from-env`)
- `tracing` imported anywhere other than `src/lib/trace.ts`; a bare `step.do` that should
  go through the seam. (ast-grep: `tracing-import-seam`, `no-bare-step-do`)

## Severity

- **Important** — blocks merge. Anything in passes 1 through 4.
- **Nit** — non-blocking; author's discretion. `review:checks` reports pass-5 findings
  but its exit code never fails on them, so CI cannot block a merge on a Nit. Note the
  ast-grep rules carry `severity: error` and so *do* fail CI, including the pass-5 ones
  (`ai-run-only-in-llm`, `no-hardcoded-model-id`, `no-hardcoded-urls`,
  `tracing-import-seam`, `no-bare-step-do`). Those five are seam violations with no
  legitimate exception, so failing on them is deliberate — but it is a stricter posture
  than the Nit label above implies. Set a rule's `severity: warning` to soften it.

## CONVENTIONS-derived checks (not REVIEW.md bullets)

`review:checks` also runs two checks that widen beyond this file, because
`CLAUDE.md`'s repeated-mistakes section records that issues #16 and #17 actually shipped
with blank PR bodies:

- `branch-carries-issue` — the current branch starts with an issue number and isn't
  `main`. Needs no `gh`; runs by default and in the pre-push hook.
- `pr-body-not-empty` — with `--pr N`, the PR body is non-empty and contains
  `Closes #N`. Skips silently without `--pr` or without `gh`.
