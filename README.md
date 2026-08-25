# blog-research-agent

A scheduled research-and-draft agent for [nimeshjm.com/blog](https://nimeshjm.com/blog),
running on the Cloudflare Workers free tier.

Every two days it picks a topic, reads a curated set of RSS/Atom sources, summarizes what it
finds, and opens a pull request against the blog repo carrying a research brief and a
draft post. It never publishes: a human approves at the merge gate.

## How this repo is organised

It follows [the AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook).
Each stage commits a versioned artifact that the next stage reads:

| Stage | Artifact | Where |
|---|---|---|
| 1. Plan | `intent.md` | `features/NNN-slug/intent.md` |
| 2. Design | `spec.md` | `features/NNN-slug/spec.md` |
| 3. Build | `plan.md` | `features/NNN-slug/plan.md` |
| 3. Build | institutional knowledge | `CLAUDE.md`, `.claude/skills/` |
| 5. Deploy | review passes | `REVIEW.md` |

See [`features/README.md`](features/README.md) for the per-feature convention.

Stage 4 (a continuous eval suite) and stage 6 (`bands.yaml` control-band monitoring) are
not set up yet — they arrive once the pipeline produces real drafts and real traffic.

## Status

Feature 001 is at the **stage 3 gate**: `intent.md` and `spec.md` are written,
`plan.md` is not. The Worker skeleton deploys and the pipeline is wired end to end, but
every step body throws `NotImplemented`.

## Getting started

```bash
npm install
npm run typecheck                 # offline
npx wrangler deploy --dry-run     # offline
```

Running it (`npm run dev`) needs `npx wrangler login` first — the `AI` binding has no
local simulation, so wrangler always opens a remote session.

It opens pull requests against `nimeshjm/nimeshjm.com` (private, Astro). Two things are
still needed before a run can complete:

1. A fine-grained GitHub PAT scoped to that repo (`contents: write`,
   `pull_requests: write`), set with `npx wrangler secret put GITHUB_TOKEN`.
2. A D1 database: `npx wrangler d1 create blog_research`, then paste the id into
   `wrangler.toml`.
