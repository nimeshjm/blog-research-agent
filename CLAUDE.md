# blog-research-agent

A scheduled research-and-draft agent for https://nimeshjm.com/blog. Runs every two days on
Cloudflare Workers, researches a topic from RSS/Atom sources, and opens a pull request
carrying a research brief and a draft post against the blog repo.

## Commands

```bash
npm install
npm run typecheck          # tsc --noEmit
npm run dev                # wrangler dev
npm run deploy             # wrangler deploy
npm run migrate:local      # only after the schema in spec.md is approved; no
                           # migrations/ directory exists yet, so this fails today
npx wrangler deploy --dry-run   # validate bindings without deploying
npm run lint:ast           # ast-grep: the seam rules in rules/*.yml - see REVIEW.md
npm run test:ast           # proves each ast-grep rule fires (a dead rule reports Missing)
npm run lint:ts            # eslint: type-aware rules for pass 3's unhandled-rejection bullet - see REVIEW.md
npm run review:checks      # the checks no off-the-shelf tool can express - see REVIEW.md
npm run test:checks        # mutation table proving each of those fires
npm run plan:metrics       # SDLC stage 1 indicators from git+GitHub - see features/README.md
npm run test:plan-metrics  # mutation table proving each plan_metrics guard fires
npm run hooks:install      # git config core.hooksPath .githooks (all of the above on push)
```

`pnpm` is not installed on this machine; use `npm`.

`plan:metrics` and `test:plan-metrics` need **`python3` 3.14 or newer**. Only `--emit`
needs `pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http`; the default
path and the tests are stdlib-only.

`npm run dev` requires Cloudflare auth (`npx wrangler login`, interactive): the `AI`
binding has no local simulation and runs in `remote` mode, so wrangler opens a remote
proxy session even under `wrangler dev`. `typecheck` and `deploy --dry-run` work
offline.

A merge to `main` also deploys the Worker automatically via GitHub Actions
(`.github/workflows/deploy.yml`). Every pull request runs `.github/workflows/ci.yml`
(`typecheck` + `deploy --dry-run`, secret-free). The Cloudflare API token and account id
the deploy workflow needs live in this repo's GitHub secrets (`CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`), not in `wrangler.toml` or `.dev.vars`.

## Architecture

Cron trigger → creates a `ResearchWorkflow` instance → steps: select topic → one step
per feed → one step per article (fetch, extract, summarize) → synthesize brief + draft →
open pull request → record run.

`src/index.ts` is a thin `scheduled()` handler. All orchestration lives in
`src/workflow.ts`. All inference goes through `src/lib/llm.ts`.

## Platform rules (free tier — these are the ones that bite)

- **10 ms CPU per step.** Never parse many feeds or articles in one step. One feed per
  step, one article per step. I/O wait is free; parsing is not.
- **50 subrequests per step.** A single fetch per step leaves headroom for redirects.
- **Cron wall-clock is 15 min**, Workflow steps have none. This is why orchestration is a
  Workflow, not a cron handler. Do not move logic back into `scheduled()`.
- **10,000 neurons/day** is the whole inference budget. A run should cost ~4,300; the
  ceiling is `NEURON_BUDGET_PER_RUN`. Track spend with `neuronsFor()` and stop early.
- **Workflow steps are retried**, so every `step.do` body must be idempotent.
- **Workflows is in open beta.** Expect wrangler warnings; local behaviour can differ
  from remote (`wrangler dev --remote`).

## Inference rules

- Only `src/lib/llm.ts` may call `env.AI.run`. Everything else uses the `Llm` interface.
- The model ID lives in `wrangler.toml` as `LLM_MODEL` and nowhere else. It is currently
  `@cf/openai/gpt-oss-120b` (128k context, function calling, GA — not beta).
- All calls route through AI Gateway (`AI_GATEWAY`) for logging, caching, and retries.
  Gateway is also the seam for switching to the Anthropic provider later.

## Observability rules

- Only `src/lib/trace.ts` may import `tracing` from `cloudflare:workers`. Everything else
  uses `traced()`, `tracedStep()` or `tracerFor()`. Same rule as `src/lib/llm.ts` and
  `env.AI.run`. This includes `src/index.ts`.
- Every `step.do` goes through `tracedStep` / the `tracerFor` binding. A bare `step.do` in
  `src/workflow.ts` is a step that vanishes from the trace.
- A step span carries `agent.workflow.instance_id`, which is what groups the eleven
  per-step spans into one run. `tracerFor` binds it so no call site can forget.
- `enterSpan` inside the step body, never wrapping `step.do` — replay would emit a span per
  attempt and time nothing.
- No span opened in `run()` outside a step body; `run()` re-executes on replay.
- The step name is the replay key. `tracedStep` passes it through byte-identical.
- Attributes are `agent.*` (ours) or `gen_ai.*` (model calls, matching AI Gateway).
- No prompt, article, completion, URL or error message in an attribute. Constructor name
  only, via `error.type`.
- Roughly eight attributes per span. Attributes are CPU against the 10 ms step budget.
- **The `agent.*` / `gen_ai.*` attribute rule above governs the Worker service only.**
  CI-emitted SDLC telemetry (`scripts/plan_metrics.py`) uses the `sdlc.*` namespace and
  its own `service.name` (`blog-research-agent-sdlc`), a separate dataset.
  `span-attributes-allowlisted` reads its allowlist out of `src/lib/trace.ts` and only
  walks `src/**`, so it does not fire on `sdlc.*` — this is the carve-out, not a gap.
- `scripts/otel_span.py` is vendored verbatim from `nimeshjm/claude-otel-hooks`
  (`.claude/hooks/otel_span.py`) at commit `b5f8ffb105cdd8e03d578fec40f08c958cee55c6` and
  must not be edited. Drift is the cost of vendoring; the pinned SHA is how you notice.

## Conventions

- TypeScript strict. Named exports everywhere except `src/index.ts`, whose default
  export is the Worker entrypoint required by the runtime.
- Secrets go in `wrangler secret put`, never `wrangler.toml` and never `.dev.vars` in git.
- The agent writes to branches only. It must never push to `BLOG_BASE_BRANCH`.

## SDLC artifacts

Each feature lives in `features/NNN-slug/` with `intent.md` → `spec.md` → `plan.md`, per
[the AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook). Do
not start implementing a feature whose `plan.md` is still the unfilled template.
`REVIEW.md` defines the review passes every PR here gets.

## Work tracking

[GitHub issues on this repo](https://github.com/nimeshjm/blog-research-agent/issues)
are the work-item tracker. **Issues are
authoritative for work items; the markdown artifacts in `features/` stay authoritative
for stage gates.** Where the two disagree, the artifact wins and the issue is wrong.

`CONVENTIONS.md` is the rest of it and is not optional reading: issue labels, the rule
that a build is one tracking issue rather than one per step, **branch names, which always
start with their issue number**, `Closes #N` on the pull request, and the Stop hook that
posts each turn's reasoning back to the issue named in the branch.

## Repeated mistakes

When Claude makes the same mistake twice, record it here.

- **Never pass a PR body on stdin.** `rtk` swallows stdin on the `gh pr` path and still
  prints `ok created #N`, so the PR ships with an empty body and nothing looks wrong.
  #16 and #17 both merged blank this way. It is stdin specifically: a file *path* works
  under plain `rtk`, and `gh issue` accepts stdin fine.

  ```bash
  rtk gh pr create --body-file <path>          # fine
  rtk gh pr create --body-file -               # silently empty
  rtk proxy gh api repos/nimeshjm/blog-research-agent/pulls/<N> --jq .body   # verify
  ```

  This matters beyond losing prose: `CONVENTIONS.md` puts `Closes #N` in the body. Both
  issues only closed because the commit messages also carried it.
