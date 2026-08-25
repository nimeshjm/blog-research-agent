---
name: blog-voice
description: The voice, audience, structure, and file conventions of nimeshjm.com/blog. Use when writing, editing, or reviewing a draft post, when building the synthesis prompt in the research pipeline, or when judging whether a draft is fit to open a pull request.
---

# nimeshjm.com/blog — voice and conventions

Institutional knowledge about the blog this agent writes for. It is prompt content for
the pipeline's synthesis step and a checklist for anyone reviewing a draft.

## The archive splits in two — only one half is a voice exemplar

The feed at `https://nimeshjm.com/rss.xml` carries 30 posts with full bodies in
`content:encoded`. They are not one corpus:

- **2026-era posts (10, roughly 10,000-22,000 characters).** Long-form essays on AI in
  engineering organisations. **These define the current voice.**
- **2012-2016 posts (20, roughly 450-1,300 characters).** Short technical notes on
  EPiServer, WinDbg, ASP.NET. A legacy archive from a different decade and a different
  kind of writing.

**Never use a pre-2016 post as a style exemplar or a length target.** Filter on
`pubDate >= 2026` before sampling the archive for voice. Getting this wrong produces a
600-character how-to where a 15,000-character essay belongs.

## Audience

Engineering executives and engineering leaders — people accountable for what an
organisation ships and what it spends, not for individual pull requests. They have
adopted AI tooling and are unsure whether it is working. Posts are written to be useful
to someone who has to defend a decision to a board.

Not written for: beginners, or readers wanting a tutorial.

## Structure

The recurring shape across the 2026 posts:

1. **Name who this is for and why it matters to them**, in the opening paragraph.
2. **Ground the argument** in one of two things — see below.
3. **Generalise from the grounding to the principle.** The evidence earns the argument.
4. **What to do about it**, concretely enough to act on.

Titles often carry the argument themselves: "Most companies are getting no value from
AI", "AI won't fix your engineering team. It will amplify everything - good and bad."

### The two ways to ground a post

**A concrete incident** — something that actually happened, with specifics. The
observability post opens with an agent quietly introducing inefficient query patterns
that passed every test and review, caught weeks later by cost anomaly detection. This is
the strongest opening and the author is the only source for it.

**An R&D practice for the SDLC** — a documented, sourced practice or research finding
about how software actually gets built. This is the grounding a research agent *can*
supply, and it is the default when no incident is available. It must be attributable:
a paper, a published practice, a survey, a vendor's engineering writeup. Never "teams
are increasingly…" with nothing behind it.

Both can appear in the same post. The strongest shape is a practice that a real incident
either validates or contradicts.

## R&D practices for the SDLC

The through-line of the modern archive is how the software development lifecycle itself
is being re-engineered. Material worth building a post on, by stage:

- **Plan / design** — spec-driven and intent-driven development, writing requirements as
  artifacts an agent consumes, proto-specs and design review with agents in the loop.
- **Build** — plan-mode-first workflows, parallel agent sessions and worktrees, context
  and prompt engineering treated as an engineering practice rather than a knack,
  institutional knowledge captured as versioned config (`CLAUDE.md`, skills, hooks).
- **Test** — evals as regression suites, incidents promoted into permanent eval cases,
  failing-test-first for agent-authored fixes, gating config changes on eval pass rate.
- **Deploy** — review gates for agent-authored code, severity-ranked automated review
  passes, non-interactive agents in CI with short-lived scoped credentials.
- **Maintain** — control-band monitoring, agent-assisted triage and diagnosis, closing
  the loop from a production signal back into a new intent.
- **Measurement across all of it** — DORA and DX-style research, what actually correlates
  with delivery performance, and why token counts and lines of code do not. The archive
  is explicit on this: "Resist the temptation of reporting tokens consumed as
  productivity."

Where this material comes from in the source allowlist: arXiv cs.SE for research, DX and
Stack Overflow for survey data, GitHub and Cloudflare engineering blogs for vendor
practice, Martin Fowler and The Pragmatic Engineer for practice writeups, Simon Willison
for hands-on technique.

The test for whether a practice is worth a post: **does it change what an engineering
leader should do on Monday?** A practice with no decision attached to it is a link, not
a post.

## Recurring themes

AI adoption and the pilot-to-production gap; observability for agentic systems; team
structure and hiring in an AI-first org; embedding AI in a SaaS product; context
retrieval strategies; and R&D practices reshaping the SDLC (above). New drafts should
connect to this line of argument rather than start a new one.

## File conventions

Repo `nimeshjm/nimeshjm.com` (private, Astro, default branch `main`). Posts live at
`src/content/blog/<slug>/index.mdx`, images co-located in the same directory. URL shape
`/blog/<slug>/`. Bodies may open with component imports
(`import ImageModal from '@/components/ImageModal.astro'`).

Frontmatter schema, from `src/content.config.ts` — that file is the source of truth,
check it rather than trusting this copy:

```yaml
title: "<string, required>"
description: "<string, required>"
date: "<yyyy-mm-dd, required>"
authors: ['nimeshjm']
tags: ["ai", "engineering-leadership", "saas", ...]
draft: true
# image: optional, and MUST be omitted - see below
# order: optional number, unused by posts
```

`description` is a one-or-two-sentence hook that states the tension in the post, not a
summary of it.

### Three hard rules for a generated post

- **`draft: true`, always.** A merged agent draft must not appear on the site. The
  author's own in-progress posts are marked this way.
- **Never emit an `image` key.** The schema uses Astro's `image()` helper, which resolves
  the path to a real file at build time. `image: './header.svg'` without that file
  committed **breaks the site build**. Every existing `draft: true` post omits `image`;
  every published one has it. Adding the header image is a publishing step.
- **Slug is kebab-case with no spaces.** One legacy directory has a space in its name
  (`ai-developing agents`). Do not copy it.

### Dedupe reads the repo, not just the feed

`draft: true` posts are absent from `https://nimeshjm.com/rss.xml`. At the time of
writing the repo holds 33 posts and the feed 30 — the difference is three unpublished
drafts on agentic context engineering, agentic IaC, and developing agents. Checking only
the feed will propose a topic that is already half-written.

## What a draft must not do

- Claim an incident that did not happen. The concrete opening is the author's to supply;
  a draft should mark that slot as `<!-- OPENING INCIDENT: needs a real example -->`
  and ground itself in a sourced R&D practice instead. **This is the single most
  important rule here** — a fabricated war story published under the author's name is
  the worst outcome this pipeline can produce. Having the practice route available is
  what makes the rule easy to follow: there is always a legitimate way to open.
- Present an R&D practice as more settled than it is. If it is one paper or one
  company's blog post, say so. "One team reports" is honest; "the industry has moved to"
  usually is not.
- Assert a claim without a source. Every factual claim in a draft carries a link.
- Pad to length. Fewer than 3 relevant sources means no draft at all.

## TODO — sharpen the style rules

Sentence-level rules here (rhythm, paragraph length, use of second person, how code and
quotations are formatted) are inferred from a single sampled post. Before the synthesis
prompt is finalised, read all 10 of the 2026 posts from `content:encoded` and replace
this section with rules derived from the set. Do not bake in a hard style rule — em
dashes, sentence length, heading depth — on the strength of one example.
