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
| Steps per Workflow instance | **1,024.** Wall-clock per step is unlimited, and `step.sleep` / `sleepUntil` do not count toward the 1,024 | Workflows limits docs, read 2026-08-28 (#75) |
| Concurrent Workflow instances | **100.** An instance waiting - `step.sleep`, a retry, `waitForEvent` - does not count. Past the limit an instance is queued, not failed | Workflows limits docs, read 2026-08-28 (#75). The page contradicts itself: its prose says 10,000 where its table says 100. This repo uses the table |
| Workflow instance lifetime | **No ceiling.** An instance "can run forever" as long as each step stays inside the CPU limit and the step count is not reached. The 3-day Free figure is retention of completed state, not a lifetime cap | Workflows limits docs, read 2026-08-28 (#75) |
| Workflow executions | 100,000/day, shared with the Workers daily request limit. Creation is capped at 100/sec | Workflows limits docs, read 2026-08-28 (#75) |
| Max non-stream step result | 1 MiB | Workflows limits docs, read 2026-08-28 (#75) |
| Cron trigger wall-clock | 15 min per run | Workers limits docs |
| Cron triggers | 5 per account | Workers limits docs |
| Subrequests | **50 per invocation** — shared across every step the runtime packs into one | Workers limits docs; measured 2026-08-31 (#75), run `0199648c` |
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

**The term is items parsed per invocation, not feeds** — measured 2026-09-01 (#75), run
`bd33248b`. That "one passes, two pass, three fail" reads as a feed budget and is not one:
a gather child chunked by *feed count* parsed 917 items across three feeds and then died
on its fourth, a 20-item feed, while four sibling children with light chunks completed.
Cost drains cumulatively across whatever the invocation parses, and volume per feed is
wildly uneven — arXiv cs.AI alone was 783 of the allowlist's 1,117 items that day. So when
splitting work across invocations, balance measured item volume; a count of feeds says
nothing about the cost being spent.

**Orchestration belongs in the Workflow, never in `scheduled()`.** The cron handler gets
10 ms of CPU and 15 minutes of wall-clock for the entire run, both fixed at the handler's
outer boundary with no per-unit reprieve. A Workflow gives every step a wall-clock
exemption and the *chance* of a fresh CPU budget described above. Moving logic back into
the handler is the single most likely way to break this agent.

**One fetch per step, and count the whole run anyway.** The 50 is per *invocation*, and
consecutive steps share one. Run `0199648c` (2026-08-31) spent it on 46 gather steps
and then failed all 15 article fetches with `Too many subrequests by single Worker
invocation.` D1, KV and AI binding calls count too, as does every redirect. One fetch
per step is necessary and not sufficient: if a run needs more than ~50 subrequests
end to end, it needs more than one invocation, which today means a child instance.

**Prefer streaming parsers.** Use `HTMLRewriter` for HTML rather than regex over a full
body — it streams and keeps large documents out of the CPU budget. Cap extracted text
length before it reaches the model.

**Neurons are the scarcest resource.** 10,000/day covers roughly two full runs. On
`@cf/openai/gpt-oss-120b`: 31,818 neurons per million input tokens, 68,182 per million
output. Budget every call, accumulate with `neuronsFor()` from `src/lib/llm.ts`, and stop
the run at `NEURON_BUDGET_PER_RUN` rather than overspending. Prefer many small calls with
bounded inputs over one large call — easier to cap, and one that fails costs its own
spend rather than the run's.

**Steps are not retried.** `tracedStep` (`src/lib/trace.ts`) passes
`{ retries: { limit: 0, delay: 0 } }` at the single permitted `step.do` call site, so a
step that throws fails its instance immediately. Measured 2026-08-28 (#75): a retry ran
inside the same `run()` execution as the attempt that failed — same isolate, same
module-scope counter — so a CPU failure retries into the budget that had already been
exhausted, and 35 seconds of backoff bought nothing. Write every `step.do` body
idempotent anyway: `run()` itself re-executes on replay even when a completed step's body
does not, and `rules/no-step-retry-config.yml` is what keeps the policy at one site.

**Workflows is GA** (since 2025-04-07); only *Python* Workflows is still beta. Local
behaviour under `wrangler dev` can still differ from remote. Before concluding that code
is broken, retry with `wrangler dev --remote`.

## Before adding anything

Ask: how much CPU does this add to a single step, how many subrequests, and how many
neurons? If any answer is "it depends on the input size", cap the input.

## Checking spend

- Workers AI usage: Cloudflare dashboard → AI → Workers AI.
- Per-call token counts and latency: AI Gateway logs (binding `AI_GATEWAY`).
- Per-run spend: the `neurons_spent` column of the `runs` table.
- Per-step and per-call spans: Cloudflare dashboard → Workers & Pages → the Worker →
  Traces. Export to a third party (Honeycomb, Grafana, Axiom) needs Workers Paid.
