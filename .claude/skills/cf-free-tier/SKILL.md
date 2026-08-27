---
name: cf-free-tier
description: Cloudflare free-tier limits that constrain this Worker, and the design rules that follow from them. Use when writing or reviewing Workflow steps, adding a fetch or an inference call, changing wrangler.toml, or diagnosing a run that failed on CPU, subrequests, or neuron budget.
---

# Cloudflare free-tier budget

This agent must run entirely inside Cloudflare's free allocations — hosting **and**
inference. These are the limits that actually bite, and what each one forces.

## The numbers

| Limit | Free value | Verified |
|---|---|---|
| Worker CPU time | **10 ms per invocation.** A Workflow step is not its own invocation - Workflows packs consecutive fast steps into one, and only the wall-clock cap is scoped to a single step | Workers + Workflows limits docs, measured 2026-08-27 (#61) |
| Steps per Workflow | 1,024, wall-clock unlimited per step | Workflows limits docs |
| Cron trigger wall-clock | 15 min per run | Workers limits docs |
| Cron triggers | 5 per account | Workers limits docs |
| Subrequests | **50 per request/step** | Workers limits docs |
| Requests | 100,000/day | Workers limits docs |
| Workers AI | **10,000 neurons/day** | Workers AI pricing |
| D1 | 10 DBs, 500 MB each, **50 queries/invocation**, **100 bound params/query** | D1 limits docs |
| AI Gateway | available on all plans | AI Gateway docs |
| Trace/log events | 200,000/day (3-day retention) | Workers observability pricing |

## Rules that follow

**Keep steps small anyway — a step boundary buys a chance, not a guarantee.** 10 ms of
CPU is charged per invocation. Workflows packs consecutive fast steps into one
invocation rather than starting fresh at each `step.do`, so a step boundary only gives
the runtime an *opportunity* to roll to a new invocation, never a promise that it will.
Measured 2026-08-27 (#61), replaying `run()`'s gather loop in one invocation: one feed
parse passes, two pass (393 candidates accumulated), three fail with Workers error
`1102`. Keep parsing to one feed and one article per unit of work regardless — it is
still what makes each unit small enough to survive whichever invocation it lands in, and
it is the only lever that exists. If a step is close to the limit, split it further;
there are 1,024 available.

**Orchestration belongs in the Workflow, never in `scheduled()`.** The cron handler gets
10 ms of CPU and 15 minutes of wall-clock for the entire run, both fixed at the handler's
outer boundary with no per-unit reprieve. A Workflow gives every step a wall-clock
exemption and the *chance* of a fresh CPU budget described above. Moving logic back into
the handler is the single most likely way to break this agent.

**One fetch per step.** 50 subrequests per step sounds generous until a redirect chain
counts against it. Keep it to one primary fetch and its redirects.

**Prefer streaming parsers.** Use `HTMLRewriter` for HTML rather than regex over a full
body — it streams and keeps large documents out of the CPU budget. Cap extracted text
length before it reaches the model.

**Neurons are the scarcest resource.** 10,000/day covers roughly two full runs. On
`@cf/openai/gpt-oss-120b`: 31,818 neurons per million input tokens, 68,182 per million
output. Budget every call, accumulate with `neuronsFor()` from `src/lib/llm.ts`, and stop
the run at `NEURON_BUDGET_PER_RUN` rather than overspending. Prefer many small calls with
bounded inputs over one large call — easier to cap, and each one retries independently.

**Steps are retried.** Every `step.do` body must be idempotent. A step that inserts a
row, posts a comment, or opens a pull request must be safe to run twice.

**Workflows is in open beta.** Local behaviour under `wrangler dev` can differ from
remote. Before concluding that code is broken, retry with `wrangler dev --remote`.

## Before adding anything

Ask: how much CPU does this add to a single step, how many subrequests, and how many
neurons? If any answer is "it depends on the input size", cap the input.

## Checking spend

- Workers AI usage: Cloudflare dashboard → AI → Workers AI.
- Per-call token counts and latency: AI Gateway logs (binding `AI_GATEWAY`).
- Per-run spend: the `neurons_spent` column of the `runs` table.
- Per-step and per-call spans: Cloudflare dashboard → Workers & Pages → the Worker →
  Traces. Export to a third party (Honeycomb, Grafana, Axiom) needs Workers Paid.
