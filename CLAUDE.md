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
```

`pnpm` is not installed on this machine; use `npm`.

`npm run dev` requires Cloudflare auth (`npx wrangler login`, interactive): the `AI`
binding has no local simulation and runs in `remote` mode, so wrangler opens a remote
proxy session even under `wrangler dev`. `typecheck` and `deploy --dry-run` work
offline.

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

## Repeated mistakes

When Claude makes the same mistake twice, record it here.

- (none yet)
