# Review passes

Every pull request in this repo gets the same passes, in this order. Findings are ranked
by severity; a human approves the merge regardless of what the review says.

Run with: `/code-review` (add `--comment` to post findings inline on a PR).

## Mechanical checks

A large share of the bullets below are not judgement calls — they are mechanically
decidable from the tree. Three tools enforce that decidable subset, and each bullet is
marked with the check id that covers it, or `(manual)` when a human (or the LLM pass)
still has to judge it.

| marker | tool | run with | proved by |
|---|---|---|---|
| `(ast-grep: <id>)` | [ast-grep](https://ast-grep.github.io) rules in `rules/*.yml` | `npm run lint:ast` | `npm run test:ast` |
| `(mechanical: <id>)` | `scripts/review-checks.mjs` | `npm run review:checks` | `npm run test:checks` |
| `(eslint: <rule>)` | [typescript-eslint](https://typescript-eslint.io) in `eslint.config.mjs` | `npm run lint:ts` | a mutation row in `npm run test:checks` |

All three run in the pre-push hook (`npm run hooks:install`) and in CI.

**Why three.** ast-grep expresses "this construct, only in this file" declaratively,
and `ast-grep test` classifies a rule that stops matching as **Missing** — so a rule that
silently matches nothing fails loudly instead of passing green. typescript-eslint adds
the one thing ast-grep can't do from syntax alone: type-aware analysis — whether an
expression's static type is a `Promise`, which is what `no-floating-promises` and
`no-misused-promises` need to catch a dropped rejection. Everything that survives
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
  a loop. The budget is 10 ms of CPU per invocation, and a Workflow step is not a fresh
  one — Workflows packs consecutive fast steps into one invocation, so this still means
  one feed per step, one article per step. (manual)
- The corrected CPU-per-invocation premise stays asserted everywhere in the tree, not the
  belief this feature retired. (mechanical: `cpu-premise-is-per-invocation`)
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
- A `step.do` call that bypasses `tracedStep`/`tracerFor` breaks replay the same way an
  unstable name does — it is a step correctness problem, not a nit. (ast-grep:
  `no-bare-step-do`)
- No unhandled rejection that would retry an already-successful side effect. (eslint:
  `no-floating-promises`, `no-misused-promises` — catch a promise dropped in statement
  position, and an async callback passed where a void return is expected)

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
- `tracing` imported anywhere other than `src/lib/trace.ts`. (ast-grep:
  `tracing-import-seam`)

## Severity

- **Important** — blocks merge. Anything in passes 1 through 4.
- **Nit** — non-blocking; author's discretion. `review:checks` reports pass-5 findings
  but its exit code never fails on them, so CI cannot block a merge on a Nit. The four
  pass-5 ast-grep rules (`ai-run-only-in-llm`, `no-hardcoded-model-id`,
  `no-hardcoded-urls`, `tracing-import-seam`) carry `severity: warning`, so `lint:ast`
  reports them and exits 0. `no-bare-step-do`, `no-secret-in-console` and
  `scheduled-stays-thin` carry `severity: error` and fail CI, matching their Important
  passes (3, 2, and 1). `review:checks` likewise never fails on a Nit.

One real tension is open rather than papered over: CLAUDE.md states both seams as hard
architectural rules — "Only `src/lib/llm.ts` may call `env.AI.run`" and "Only
`src/lib/trace.ts` may import `tracing` … This includes `src/index.ts`" — yet both issue
#25 and this file file `ai-run-only-in-llm` and `tracing-import-seam` under pass 5 / Nit.
Nothing here is internally inconsistent, so both stay `warning` until
[#28](https://github.com/nimeshjm/blog-research-agent/issues/28) decides whether the pass
filing or the severity is the one that's wrong.

## CONVENTIONS-derived checks (not REVIEW.md bullets)

`review:checks` also runs three checks that widen beyond this file. Two exist because
`CLAUDE.md`'s repeated-mistakes section records that issues #16 and #17 actually shipped
with blank PR bodies. The third exists because this file's own markers are only as
honest as something keeps them: a rule renamed or deleted under `rules/`, a
`rule-tests/` file left behind, or a marker added here that names an id nothing
implements, would each drift silently otherwise.

- `branch-carries-issue` — the current branch starts with an issue number and isn't
  `main`. Needs no `gh`; runs by default and in the pre-push hook.
- `pr-body-not-empty` — with `--pr N`, the PR body is non-empty and contains
  `Closes #N`, or, for an intermediate PR in a stack against the same issue (see
  CONVENTIONS.md's "Stacked pull requests"), the explicit marker `Part N of M of
  #<issue>` with the issue number matching the branch and `1 <= N <= M`. Skips
  silently without `--pr` or without `gh`.
- `checks-and-docs-in-sync` — every `rules/<id>.yml` has a `rule-tests/<id>-test.yml`
  and declares its own filename as its `id:`, every marker in this file resolves to a real
  rule or check id, and every rule and check id is mentioned somewhere in this file.
  Mentioned, not necessarily marked: the two checks above are documented as plain bullets
  rather than markers, and that is a legitimate way to document a check. Guards the drift
  that splitting enforcement across three tools makes possible.
