# Intent: Scheduled research drafts

> Stage 1. Approved to proceed to spec.

## Problem

Writing for nimeshjm.com/blog depends on catching the right material at the right time.
The research that makes a post worth reading — what shipped this month, what other
practitioners found, what the papers actually say — happens ad hoc, in whatever gaps
appear between other work. The result is that posts arrive irregularly, and the gap
between having an idea and having enough grounded material to write from is where most
ideas die.

The bottleneck is not writing. It is the standing cost of noticing and gathering.

## Outcome

Every two days, when there is something worth writing about, a pull request appears
against the blog repo containing:

- a **research brief**: what was found, from where, with the claims worth using and links
  back to every source;
- a **draft post** in the blog's voice and file format, ready to be rewritten rather than
  started from nothing.

Review happens where review already happens — in a pull request, on a branch, merged by
a human. Nothing is published automatically. A cycle with nothing worth writing about
should produce no pull request rather than a filler one — and at a two-day cadence that
will be the common case, not the exception. Silence is the expected output most of the
time; a pull request means something actually turned up.

## Constraints

- **Cloudflare free tier for hosting and for inference.** Workers, Workflows, D1, and
  Workers AI free allocations only. No paid plan, and no per-token spend on a
  third-party model API.
- **10,000 neurons per day** is the entire inference budget. A run must fit well inside
  a single day's allowance, with a hard per-run ceiling that stops the pipeline rather
  than overspending.
- **No paid search API and no API keys for research sources in this iteration.**
  Discovery has to work from things that are free and open — RSS and Atom feeds, and
  direct fetches of the pages those feeds point at. A real search API is the next
  iteration, and relaxing this is the point of it.
- **The agent writes to branches only.** It never pushes to the blog's default branch
  and never publishes. The merge gate is a human.
- The only secret it holds in this iteration is a GitHub token, fine-grained and scoped
  to the blog repo. The next iteration adds a second one, for the search API.

## Topic selection

Queue first, else propose.

- When there are curated topics waiting, the run takes the next one. A human-supplied
  topic always wins.
- When the queue is empty, the agent proposes its own, using the published archive at
  `https://nimeshjm.com/rss.xml` for what has already been covered and the source feeds
  for what is new. A proposed topic is marked as agent-originated so it is obvious in
  review which runs were self-directed.
- Merging a draft closes its topic row. The human merge is the signal that the topic is
  spent, so the queue follows it automatically rather than needing a second manual step.
  The merge gate stays with the human either way; only the bookkeeping is automatic.

## Non-goals

- No automatic publishing or merging.
- No image generation or diagram creation.
- No posting to social platforms.
- No rewriting or editing of existing published posts.
- Not a finished post. A 120B open-weights model will not match the author's voice; the
  target is grounded material and structure that a human then rewrites. If that trade
  stops being acceptable, the fix is to swap the model behind the gateway, not to lower
  the bar for what gets merged.

## Open questions

- ~~The blog repo name is unknown.~~ **Resolved:** `nimeshjm/nimeshjm.com` — private,
  Astro, default branch `main`, posts at `src/content/blog/<slug>/index.mdx`. The
  content-collection schema is in `src/content.config.ts` and is recorded in `spec.md`.
- ~~`GITHUB_TOKEN` is not yet issued.~~ **Resolved:** issued, with `contents: write`
  and `pull_requests: write` scoped to `nimeshjm/nimeshjm.com` alone, and set as a
  wrangler secret — which is where the Worker reads it from, and the only place it may
  live. The pull-request step is unblocked.
- ~~Should merging a draft automatically close the corresponding row in the topic
  queue, or should that stay a manual step?~~ **Resolved:** automatic. Recorded under
  Topic selection above.
- ~~Should discovery use a real search API?~~ **Resolved:** yes, in the next iteration,
  not this one. A search API (for example Brave's free tier, 2,000 queries/month) widens
  discovery well beyond a feed allowlist. Adopting it relaxes two constraints above — it
  is neither Cloudflare nor key-free — which is why it is a new iteration rather than an
  addition to this one.
