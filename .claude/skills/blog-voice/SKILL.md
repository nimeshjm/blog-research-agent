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

- **2026-era posts (10).** Long-form essays on AI in engineering organisations. **These
  define the current voice.** Nine of the ten run roughly 8,900-20,000 characters
  (1,000-2,800 prose words); the tenth (2026-01-12, "We Tested lambda Managed
  Instances", 4,002 characters) is a hands-on AWS how-to that also misses the Audience
  and Recurring-themes sections below — a known outlier, not a voice exemplar, and not
  silently dropped from the count of ten.
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
  a draft should mark that slot as `{/* OPENING INCIDENT: needs a real example */}`
  and ground itself in a sourced R&D practice instead. That is MDX comment syntax and
  the braces are load-bearing: MDX v3 rejects an HTML comment, so the HTML form of this
  marker breaks the blog's build rather than surviving to a human reader.
  **This is the single most important rule here** — a fabricated war story published
  under the author's name is the worst outcome this pipeline can produce. Having the
  practice route available is what makes the rule easy to follow: there is always a
  legitimate way to open.
- Present an R&D practice as more settled than it is. If it is one paper or one
  company's blog post, say so. "One team reports" is honest; "the industry has moved to"
  usually is not.
- Assert a claim without a source. Every factual claim in a draft carries a link.
- Pad to length. Fewer than 2 relevant sources, at least one carrying an attributable
  practice, means no draft at all (spec.md req. 5 / `MIN_SOURCES` in `src/workflow.ts` —
  this is the authoritative gate; treat any other number stated elsewhere as stale).

## Sentence-level style

Derived from all ten 2026-era posts (the outlier included, since even a non-exemplar's
mechanics are real data) — see `blog-voice-evidence.md` for the measurements behind
each bullet.

- **Sentences run 10-20 words on average, but vary it.** Mix in short ones — down to a
  word or two, right after a longer sentence — for emphasis. Don't normalise to one
  length.
- **Paragraphs are short: 1-3 sentences.** Break up anything running past 4-5.
- **Write to the reader as "you"/"your", consistently, not about "engineering leaders" in
  the third person.** This is the one feature every post shares without exception.
- **No em dashes as prose punctuation.** Most posts use none at all. Where they appear
  it's narrowly for labeling a code snippet's file path, a term/definition pair inside a
  list item, or an attribution right after a link — never mid-sentence. Use a comma,
  parentheses, or a new sentence instead.
- **Headings: `##` top level, `###` for subsections, occasionally `####` for a deep
  how-to subsection. Never an `#`/h1 in the body** — the frontmatter title is the h1.
  Phrase headings as a claim or noun phrase ("The amplifier, not the fixer", "What to do
  on Monday morning"), not a question.
- **Code only when the post is genuinely hands-on/technical — most aren't.** A
  leadership/organisational argument should carry no code at all; don't insert a snippet
  to look technical. When code does appear, keep fenced blocks realistic (a `#`-comment
  naming the file it belongs to is typical) and keep inline code to short identifiers —
  an attribute name, a file path, a command — never a full sentence.
- **Reach for a list only when it's a genuine step-by-step or option breakdown; don't
  force one into a narrative post.** Blockquotes are rare (one instance in ten posts, a
  labeled callout box rather than a rendered quotation) — thin evidence, so treat them as
  an option, not a rule either way.
- **Bold short terms or claims for a skimming reader, never a full sentence. Italics,
  lightly, if at all.**
- **A generated draft has no standing to originate a first-person aside ("I think...",
  "we shipped...") any more than it does to invent the opening incident** — see "What a
  draft must not do" above; the same `{/* OPENING INCIDENT: needs a real example */}`
  marker covers both. The one safe residue: the post's first sentence is always concrete
  and specific, never scene-setting or a dictionary-style definition.
- **No fixed word-count target.** The set runs from roughly 1,000 to 2,800 words; match
  length to what the grounding actually supports rather than padding toward a number.
