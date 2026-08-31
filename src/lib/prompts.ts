import type { Message } from './llm';
import type { ArticleSummary, Candidate, Topic } from './types';

/**
 * The two prompt shapes (spec.md -> Inference): map (one article in, a
 * structured summary out) and reduce (topic + all summaries in, brief and
 * draft out). Each `build*` pairs with a `parse*` for its response, so the
 * shape of a call and the shape of reading it back stay next to each other.
 *
 * This file carries a *condensed* version of `.claude/skills/blog-voice/
 * SKILL.md`'s rules, not the whole document - SKILL.md is Claude Code's own
 * reference (read by a human, or by Claude Code itself, when writing or
 * reviewing a draft); the deployed Worker never reads files under
 * `.claude/`. What's below is prompt text, spent as input tokens on every
 * synthesis call, so it states the load-bearing rules only and leans on
 * cross-reference rather than repeating SKILL.md's evidence inline.
 */

// ---------------------------------------------------------------------------
// Map: one article -> one structured summary.
// ---------------------------------------------------------------------------

/**
 * Kept close to the exact wording `plan.md` step 2 measured (223 neurons at
 * 5,987 input tokens; 203 at 4,946 - see spec.md's cost table) so that
 * measurement still describes the call this file builds. The one
 * substantive change from the probe text: relevance is scored against the
 * run's actual `topic`, not a fixed rubric - the probe used a placeholder
 * ("AI-native software delivery practice") because it ran outside a real
 * run and had no topic to score against.
 */
const MAP_SYSTEM_PROMPT =
  'You are summarizing one article for a research brief on a given topic. ' +
  'Given the article, respond with a JSON object with exactly these fields: ' +
  '"summary" (2-4 sentence summary of the article), ' +
  '"relevance" (a number 0-1 for how relevant this is to the research topic given below), ' +
  '"claims" (an array of up to 5 short strings, the concrete claims the article makes), ' +
  '"attributablePractice" (a short string naming the specific R&D practice or research finding this ' +
  'article attributably supports, or null if the article is commentary rather than a sourced practice ' +
  'or finding). Respond with only the JSON object, no other text.';

export function buildMapMessages(topic: Topic, candidate: Candidate, articleText: string): Message[] {
  const topicLine = topic.angle === null ? topic.title : `${topic.title} (${topic.angle})`;
  return [
    { role: 'system', content: MAP_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Research topic: ${topicLine}\n\nTitle: ${candidate.title}\n\nArticle:\n${articleText}`,
    },
  ];
}

/** The map call's response fields, everything `ArticleSummary` needs beyond `url`/`title` (attached by the caller). */
export type MapResult = Pick<ArticleSummary, 'summary' | 'relevance' | 'claims' | 'attributablePractice'>;

/**
 * Every way `tryParseJsonObject` or a field check can reject a response,
 * named so a caller can tell them apart without the parser throwing - see
 * `MapParseResult`'s doc comment.
 */
export type MapParseFailure =
  | 'invalid-json'
  | 'not-an-object'
  | 'summary-invalid'
  | 'relevance-invalid'
  | 'claims-invalid'
  | 'attributablePractice-invalid';

/**
 * A model response that isn't parseable JSON in the expected shape resolves
 * to `{ ok: false }` rather than throwing - `@cf/openai/gpt-oss-120b`'s
 * reasoning fallback (llm.ts's `normalise()`) can hand back prose instead of
 * JSON when the completion was cut short, and one bad article must not fail
 * a run (spec.md risk table). `reason` is diagnostics only: it does not
 * change which inputs are accepted or rejected, only what a caller can say
 * about a rejection. `keys` (present only once the text actually parsed to
 * an object) is a caller's only way to see what shape the model actually
 * sent without re-parsing untrusted text at the call site.
 */
export type MapParseResult = { ok: true; value: MapResult } | { ok: false; reason: MapParseFailure; keys?: readonly string[] };

export function parseMapResponse(text: string): MapParseResult {
  const parsed = tryParseJsonObject(text);
  if (!parsed.ok) return parsed;
  const obj = parsed.value;
  const keys = Object.keys(obj);

  if (typeof obj.summary !== 'string') return { ok: false, reason: 'summary-invalid', keys };
  if (typeof obj.relevance !== 'number' || !Number.isFinite(obj.relevance)) return { ok: false, reason: 'relevance-invalid', keys };
  if (!Array.isArray(obj.claims) || !obj.claims.every((c) => typeof c === 'string')) return { ok: false, reason: 'claims-invalid', keys };
  if (obj.attributablePractice !== null && typeof obj.attributablePractice !== 'string') {
    return { ok: false, reason: 'attributablePractice-invalid', keys };
  }

  return {
    ok: true,
    value: {
      summary: obj.summary,
      relevance: obj.relevance,
      claims: obj.claims as string[],
      attributablePractice: obj.attributablePractice as string | null,
    },
  };
}

// ---------------------------------------------------------------------------
// Reduce: topic + summaries -> brief and draft.
// ---------------------------------------------------------------------------

/**
 * Condensed from `.claude/skills/blog-voice/SKILL.md`'s Audience, Structure,
 * "What a draft must not do" and Sentence-level style sections. Only the
 * fields the model actually produces are asked for here - `slug`, `date`,
 * `authors`, `draft` and the sources list are all computed deterministically
 * in `synthesizeDraft` (never by the model): a model-chosen slug can fail
 * `SLUG_RE` after every article call has already been paid for, and a
 * model-composed source list can hallucinate a URL. Keeping those out of the
 * model's job removes both failure modes rather than validating around them.
 */
const REDUCE_SYSTEM_PROMPT = `You are drafting a blog post for an engineering-leadership audience: people
accountable for what an organisation ships and spends, not for individual pull requests.
Not written for beginners or as a tutorial.

Ground the post in the sourced material given to you below - an R&D practice or research
finding, attributable to a paper, a published practice, a survey, or a vendor engineering
writeup. Never invent a personal incident, opinion, or team anecdote ("I noticed...",
"we shipped..."): that is the human author's to add, not yours. Wherever the post would
naturally open with a concrete incident, write the literal marker
<!-- OPENING INCIDENT: needs a real example --> and open instead on the sourced practice.
This is the single most important rule: a fabricated war story published under the
author's name is the worst outcome you can produce.

Shape: name who this is for and why it matters to them, ground the argument in the
sourced material, generalise from it to the principle, then say what to do about it -
concretely enough to act on. Cite sources inline as markdown links in the form [a short
description](https://example.com/paper), using the URLs given below; every factual claim
needs one. Never wrap a bare URL in brackets like 【https://example.com/paper】 - that is
not a link and will not render as one. If a practice rests on one paper or one company's
report, say so rather than implying it is settled industry consensus.

Style: address the reader as "you"/"your", not "engineering leaders" in the third person.
Short paragraphs, 1-3 sentences. Vary sentence length rather than settling on one rhythm.
No em dashes as prose punctuation. Headings are "##" and "###" only, never an "#" (the
frontmatter title is the h1), phrased as a claim or noun phrase, not a question. No code
unless the post is genuinely hands-on. No fixed length target - match the length to what
the sourced material actually supports.

Respond with a JSON object with exactly these fields: "title" (the post title, can carry
the argument itself), "description" (a one-or-two-sentence hook stating the tension, not
a summary), "tags" (an array of 2-5 short lowercase-kebab-case tags), "body" (the full
MDX post body as markdown, starting directly with prose or a heading - no frontmatter, no
title as an H1). Respond with only the JSON object, no other text.`;

function formatSourceForPrompt(summary: ArticleSummary): string {
  const practice = summary.attributablePractice ?? 'none (commentary, not attributable)';
  const claims = summary.claims.length > 0 ? summary.claims.join('; ') : 'none extracted';
  return [
    `### ${summary.title}`,
    `URL: ${summary.url}`,
    `Attributable practice: ${practice}`,
    `Summary: ${summary.summary}`,
    `Claims: ${claims}`,
  ].join('\n');
}

export function buildReduceMessages(topic: Topic, summaries: ArticleSummary[]): Message[] {
  const topicLine = topic.angle === null ? topic.title : `${topic.title}\nAngle: ${topic.angle}`;
  const sources = summaries.map(formatSourceForPrompt).join('\n\n');
  return [
    { role: 'system', content: REDUCE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Research topic: ${topicLine}\n\nSources:\n\n${sources}`,
    },
  ];
}

export interface ReduceResult {
  title: string;
  description: string;
  tags: string[];
  body: string;
}

/** Every way a reduce response can be rejected - see `ReduceParseResult`'s doc comment. */
export type ReduceParseFailure =
  | 'invalid-json'
  | 'not-an-object'
  | 'title-invalid'
  | 'description-invalid'
  | 'tags-invalid'
  | 'body-invalid';

/** Same non-throwing contract as `parseMapResponse` - see its doc comment. */
export type ReduceParseResult = { ok: true; value: ReduceResult } | { ok: false; reason: ReduceParseFailure; keys?: readonly string[] };

export function parseReduceResponse(text: string): ReduceParseResult {
  const parsed = tryParseJsonObject(text);
  if (!parsed.ok) return parsed;
  const obj = parsed.value;
  const keys = Object.keys(obj);

  if (typeof obj.title !== 'string' || obj.title.trim() === '') return { ok: false, reason: 'title-invalid', keys };
  if (typeof obj.description !== 'string' || obj.description.trim() === '') return { ok: false, reason: 'description-invalid', keys };
  if (!Array.isArray(obj.tags) || !obj.tags.every((t) => typeof t === 'string')) return { ok: false, reason: 'tags-invalid', keys };
  if (typeof obj.body !== 'string' || obj.body.trim() === '') return { ok: false, reason: 'body-invalid', keys };

  return {
    ok: true,
    value: {
      title: obj.title,
      description: obj.description,
      tags: obj.tags as string[],
      body: obj.body,
    },
  };
}

/** A citation the model wrote as a bracket-wrapped bare URL rather than the markdown link REDUCE_SYSTEM_PROMPT asks for. */
const BRACKETED_CITATION_RE = /【([^】]*)】/g;
const BARE_URL_RE = /^https?:\/\/\S+$/;

/**
 * Rewrites `【<url>】` citations into markdown links. A production completion
 * (#75, run `972cea0c`) ignored REDUCE_SYSTEM_PROMPT's citation instruction
 * and emitted every source as CJK lenticular brackets around a bare URL
 * instead - a prompt is a request, not a guarantee, so this makes the shape
 * a guarantee the same way `synthesizeDraft`'s deterministic source list
 * does (see this file's comment above `REDUCE_SYSTEM_PROMPT`): compute it in
 * TypeScript rather than hope the model complies. Link text is never
 * invented - a URL matching a known summary gets that summary's title, and
 * anything else gets the URL itself as its own link text. Only the exact
 * observed shape is touched: a bracket pair whose contents aren't a bare URL
 * is left alone rather than guessed at, and an already-correct markdown link
 * has no `【 】` in it to match.
 */
export function normaliseCitations(body: string, summaries: ArticleSummary[]): string {
  return body.replace(BRACKETED_CITATION_RE, (match, inner: string) => {
    if (!BARE_URL_RE.test(inner)) return match;
    const title = summaries.find((s) => s.url === inner)?.title;
    return `[${title ?? inner}](${inner})`;
  });
}

// ---------------------------------------------------------------------------
// Shared response parsing.
// ---------------------------------------------------------------------------

/**
 * Strips a ```json ... ``` (or bare ```) fence, but only one that wraps the
 * *entire* response - anchored to start and end of the (trimmed) text.
 * `reduce`'s `body` is itself markdown that can legitimately contain a
 * fenced code block (a `git worktree add` example, say), and an unanchored
 * search-anywhere match would grab that inner fence instead of treating the
 * response as a whole - see `tryParseJsonObject`'s comment for how that
 * broke a real run (#75).
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/**
 * Split from a single `| null` return so `parseMapResponse` and
 * `parseReduceResponse` can tell "not JSON at all" apart from "valid JSON,
 * wrong shape" - two of the six ways a response gets rejected, and the two
 * a caller most needs distinguished since only one of them ever has key
 * names to report.
 */
type JsonObjectResult = { ok: true; value: Record<string, unknown> } | { ok: false; reason: 'invalid-json' | 'not-an-object' };

/**
 * Tries the raw text first and only falls back to fence-stripping if that
 * throws (production run `972cea0c`, #75): the model's response was
 * unfenced, valid JSON whose `body` field happened to contain a fenced
 * ```bash block, and unconditionally fence-stripping *before* attempting a
 * raw parse extracted that inner fence instead of the response itself,
 * turning a well-formed completion into `invalid-json`. This ordering keeps
 * every response that already worked - including one genuinely wrapped in
 * its own fence - parseable, while no longer letting an inner fence
 * shadow the outer JSON.
 */
function tryParseJsonObject(text: string): JsonObjectResult {
  for (const candidate of [text, stripCodeFence(text), unwrapFencedBlock(text)]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'not-an-object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  }
  return { ok: false, reason: 'invalid-json' };
}

/**
 * Last resort: a fence that does not wrap the whole response, because the
 * model prefaced it with prose. `stripCodeFence`'s anchoring is what stops an
 * inner fence shadowing the outer JSON, but it also rejects a response the
 * unanchored regex used to accept - and this model demonstrably ignores the
 * prompt's "no other text" instruction elsewhere (it was told to cite as
 * markdown links and did not), so that tolerance is worth keeping.
 *
 * Safe only because it is tried last: a response that is already valid JSON
 * never reaches here, so this can no longer shadow anything. Greedy to the
 * *last* fence rather than the first, so a fenced payload whose own content
 * carries fences comes back whole.
 */
function unwrapFencedBlock(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*)```/.exec(text.trim());
  return fenced?.[1]?.trim() ?? '';
}
