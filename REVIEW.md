# Review passes

Every pull request in this repo gets the same passes, in this order. Findings are ranked
by severity; a human approves the merge regardless of what the review says.

Run with: `/code-review` (add `--comment` to post findings inline on a PR).

## Pass 1 — Free-tier limit violations (Important)

The failure mode this repo is most exposed to. Reject on:

- CPU-heavy work inside a single step: parsing multiple feeds or articles in one
  `step.do`, large `JSON.parse` of aggregate payloads, regex over full article bodies in
  a loop. The budget is 10 ms of CPU per step.
- More than a handful of subrequests in one step (cap is 50).
- Inference that can exceed `NEURON_BUDGET_PER_RUN`, or a loop over articles with no
  cap on iterations. The daily allowance is 10,000 neurons total.
- Logic moved from the Workflow back into `scheduled()`, which is capped at 15 min
  wall-clock and 10 ms CPU for the entire run.

## Pass 2 — Secret handling (Important)

- No token, key, or PAT in `wrangler.toml`, source, tests, or fixtures.
- `.dev.vars` must stay gitignored.
- `GITHUB_TOKEN` must remain fine-grained and scoped to the blog repo, with
  `contents: write` and `pull_requests: write` only.
- No secret value in a `console.log` or an error message.

## Pass 3 — Workflow step correctness (Important)

- Every `step.do` body is idempotent — steps are retried on failure. A step that
  inserts, posts, or opens a PR must be safe to run twice.
- Step names are stable and unique within a run; a name derived from mutable state
  breaks replay.
- No unhandled rejection that would retry an already-successful side effect.

## Pass 4 — Spec conformance (Important)

- The change matches the acceptance criteria in the feature's `spec.md`. If it does not,
  the spec is updated in the same PR, not silently diverged from.
- The agent still writes to branches only and never to `BLOG_BASE_BRANCH`.

## Pass 5 — Simplification and reuse (Nit)

- Duplicated fetch/parse/retry logic that belongs in `src/lib/`.
- Inference called anywhere other than through the `Llm` interface.
- Model IDs, budgets, or URLs hardcoded instead of read from `wrangler.toml` vars.

## Severity

- **Important** — blocks merge. Anything in passes 1 through 4.
- **Nit** — non-blocking; author's discretion.
