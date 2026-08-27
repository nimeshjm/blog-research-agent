import type { FeedItem, ParsedItem } from './types';

/**
 * RSS 2.0 and Atom parsing over `HTMLRewriter`, the platform's native
 * streaming parser - this is what keeps arXiv cs.AI (743 KiB, the largest
 * feed in the allowlist) cheap against the 10 ms CPU budget, which is
 * charged per invocation and may already be shared with other steps.
 * `HTMLRewriter` tokenizes natively and only invokes a JS callback per
 * matched element/text chunk; it never materializes the document as one
 * string or a DOM the way `response.text()` followed by a parser (or regex
 * over the body) would. `REVIEW.md` pass 1 names regex-over-article-body as
 * a reject; a whole-feed `.text()` then parse is the same mistake at feed
 * scale. `parseFeed` below drains the transformed body with
 * `pipeTo(new WritableStream())` rather than `.text()`, so no feed - not
 * even the 743 KiB one - is ever held as one JS string.
 *
 * A feed is RSS *or* Atom, never both, and a `Response` body can only be
 * read once - so `parseFeed` registers handlers for both shapes (`item` and
 * `entry`) on one `HTMLRewriter` pass. Only the set matching the feed's
 * actual format ever fires; the other's handlers simply see no matching
 * elements.
 *
 * `HTMLRewriter` is an HTML tokenizer, not an XML parser, and two of its
 * HTML rules bite RSS specifically (verified empirically against arXiv,
 * Stack Overflow, the Olshansk-scraped feeds, and the blog's own feed
 * before writing the rest of this file):
 *
 *  - Tag names are lowercased, so RSS's `pubDate` has to be selected as
 *    `pubdate`.
 *  - `link` is an HTML *void* element (like `<br>` or `<img>`), so
 *    `<link>https://example.com/x</link>`'s text never reaches a `link`
 *    text handler - the tokenizer closes `link` immediately on the start
 *    tag and the URL text streams as if it were `item`'s own direct child
 *    text instead, with the stray `</link>` end tag dropped. Falling back
 *    to `<guid>` is not a fix: arXiv's guid is `oai:arXiv.org:...` and
 *    Stack Overflow's is a bare UUID, both with `isPermaLink="false"` -
 *    neither is the article URL. The `item` handler below instead captures
 *    the first non-blank text chunk it sees immediately after a `link`
 *    start tag, which *is* the URL wherever `link` is a direct child of
 *    `item` (true of every allowlisted RSS feed) - but that same `item`
 *    text handler also fires for every *other* direct-child element's text
 *    (title, guid, pubDate all do), so an empty `<link></link>` would
 *    otherwise let the very next chunk - typically `<guid>`, exactly the
 *    non-URL string this workaround exists to avoid - be mistaken for the
 *    URL. The chunk is only accepted when it looks like a URL; an item
 *    that never produces one is dropped rather than emitted with a
 *    wrong or empty `url`.
 *
 * Atom has neither problem: `entry`, `title`, `published`/`updated` and
 * `id` are ordinary elements, and Atom's `<link href="..."/>` carries the
 * URL as an attribute, not text.
 *
 * ## Bounding the parse (`ParseBound`, optional)
 *
 * `parseFeed` always returns *every* item it read, unfiltered - it is never
 * the authority on what is kept, only (optionally) on when to stop reading.
 * `applyGatherWindow` below stays the sole filter, so the two can be tested
 * independently: requirement 2 (spec.md) is a differential comparison of
 * `applyGatherWindow`'s output, bounded parse vs. unbounded, never an
 * inspection of `parseFeed` itself.
 *
 * A caller that wants the parse bounded passes a `ParseBound`. Two
 * conditions stop it, either of which cancels the response body rather than
 * draining it:
 *
 *  - `staleRun` consecutive *dated* items at or before `cutoffMs` - the
 *    saving, for an archive feed like OpenAI's (1,154 raw items to keep 62).
 *    It keys on *consecutive* stale items, not the first one, because every
 *    allowlisted feed is newest-first (asserted in feature 001's spec.md),
 *    but that assertion is now load-bearing in a way it was not before this
 *    bound existed: a single out-of-order stale item - one paragraph
 *    misdated, one feed with a minor sort hiccup - must not truncate the
 *    rest of an otherwise newest-first feed. Undated items neither increment
 *    nor reset this counter; they are governed by `GATHER_UNDATED_MAX_PER_FEED`,
 *    which `applyGatherWindow` already applies.
 *  - `rawMax` raw items, dated or not - requirement 3's backstop for a feed
 *    with no parseable dates at all, which the stale-run condition above can
 *    never trip.
 *
 * The mechanism avoids the two costs this feature measured and ruled out
 * (spec.md, "What bounding must not cost"):
 *
 *  - **No second `Date.parse` per item.** The date is parsed once, at the
 *    point an item is emitted, and carried out as `publishedMs` - not
 *    recomputed by the stop condition and not recomputed again by
 *    `applyGatherWindow`.
 *  - **The drain stays native.** Stopping early cancels the *source* - an
 *    `AbortController` passed to the `fetch` that produced `response` - so
 *    `pipeTo(new WritableStream())` keeps draining with no per-chunk JS. A
 *    `getReader()` loop deciding per chunk was measured to cost more than
 *    the tokenizing an early stop is meant to skip.
 */

/** RSS's `<link>` void-element workaround and Atom's `<link href>` both validate against this before being trusted as a URL. */
const URL_RE = /^https?:\/\//;

function isTruthyText(text: string): boolean {
  return text.trim() !== '';
}

/** Drains a transformed `Response`'s body without ever building a JS string from it. */
async function drain(response: Response): Promise<void> {
  if (response.body === null) return;
  await response.body.pipeTo(new WritableStream());
}

/**
 * A stopping condition for `parseFeed`, threaded down from
 * `GATHER_STALE_RUN` / `GATHER_RAW_ITEM_MAX` (src/workflow.ts). It never
 * decides what is kept, only when to stop reading - see the module doc
 * comment above.
 */
export interface ParseBound {
  /** Aborted when either bound trips, so the remaining bytes are never tokenized. */
  abort: AbortController;
  /** Items at or after this are in-window. Only used to decide when to stop, never what to keep. */
  cutoffMs: number;
  staleRun: number;
  rawMax: number;
}

/**
 * Parses one feed response - RSS 2.0, Atom, or both handlers finding
 * nothing (an unrecognised format) - into `ParsedItem`s: every item read,
 * unfiltered, each carrying the epoch-ms of `publishedAt` parsed once at the
 * point it is emitted. No recency window, no ranking, no D1 - `gatherCandidates`
 * in `src/workflow.ts` applies `applyGatherWindow` and attaches the source
 * name to turn these into `Candidate`s.
 *
 * With no `bound`, every item in the feed is read. With one, reading stops
 * (and the response body is cancelled, not drained) once `bound.staleRun`
 * consecutive dated items fall at or before `bound.cutoffMs`, or once
 * `bound.rawMax` raw items have been read - see the module doc comment.
 */
export async function parseFeed(response: Response, bound?: ParseBound): Promise<ParsedItem[]> {
  const items: ParsedItem[] = [];
  let raw = 0;
  let staleRun = 0;
  let stopped = false;

  const consider = (item: FeedItem): void => {
    // Buffered chunks already in flight can still fire after `bound.abort.abort()`
    // is called, before the underlying stream actually tears down - `stopped`
    // is what makes those a no-op rather than a race.
    if (stopped) return;

    const parsedMs = item.publishedAt === null ? Number.NaN : Date.parse(item.publishedAt);
    const publishedMs = Number.isNaN(parsedMs) ? null : parsedMs;
    items.push({ ...item, publishedMs });

    if (bound === undefined) return;
    raw++;
    if (publishedMs === null) {
      // Undated: governed by GATHER_UNDATED_MAX_PER_FEED downstream, not by this bound.
    } else if (publishedMs < bound.cutoffMs) {
      staleRun++;
    } else {
      staleRun = 0;
    }
    if (staleRun >= bound.staleRun || raw >= bound.rawMax) {
      stopped = true;
      bound.abort.abort();
    }
  };

  // --- RSS 2.0 `<item>` state -----------------------------------------
  let rssTitle = '';
  let rssPublishedAt = '';
  let rssUrl = '';
  let expectingRssLinkText = false;

  // --- Atom `<entry>` state --------------------------------------------
  let atomTitle = '';
  let atomPublished = '';
  let atomUpdated = '';
  let atomUrl = '';

  const rewritten = new HTMLRewriter()
    .on('item', {
      element(el) {
        // Reset per-item accumulators on the start tag; flush on the
        // matching end tag via `onEndTag`, which is nesting-aware for this
        // specific element instance (items never nest, but this is the
        // correct primitive regardless).
        rssTitle = '';
        rssPublishedAt = '';
        rssUrl = '';
        expectingRssLinkText = false;
        el.onEndTag(() => {
          // An item whose <link> never yielded a real URL (empty <link></link>,
          // no <link> at all) is dropped rather than emitted with a wrong or
          // empty url - see the `text()` handler below for why this can't be
          // caught earlier.
          if (!URL_RE.test(rssUrl)) return;
          consider({
            url: rssUrl,
            title: rssTitle.trim(),
            publishedAt: rssPublishedAt.trim() === '' ? null : rssPublishedAt.trim(),
          });
        });
      },
      text(chunk) {
        // Only relevant while waiting for `link`'s void-element text (see
        // module doc comment). Everything else `item`'s own text handler
        // would otherwise see (description, content:encoded, ...) is
        // ignored here in O(1) per chunk - no scan, no regex - and read
        // instead through the narrower `item > title` / `item > pubdate`
        // selectors below, which never fire for CDATA content (the HTML
        // tokenizer treats `<![CDATA[...]]>` as a bogus comment, not text).
        if (!expectingRssLinkText) return;
        if (!isTruthyText(chunk.text)) return;
        // First non-blank chunk after <link> decides it either way, so a
        // later, unrelated chunk (guid, pubDate, ...) is never mistaken for
        // the URL - only accept it when it actually looks like one.
        const candidate = chunk.text.trim();
        if (URL_RE.test(candidate)) rssUrl = candidate;
        expectingRssLinkText = false;
      },
    })
    .on('item > title', {
      text(chunk) {
        rssTitle += chunk.text;
      },
    })
    .on('item > link', {
      element() {
        expectingRssLinkText = true;
      },
    })
    .on('item > pubdate', {
      text(chunk) {
        rssPublishedAt += chunk.text;
      },
    })
    .on('entry', {
      element(el) {
        atomTitle = '';
        atomPublished = '';
        atomUpdated = '';
        atomUrl = '';
        el.onEndTag(() => {
          // An entry with no rel="alternate" (or unmarked) <link> - e.g. only
          // rel="self" - never gets a URL and is dropped, same as the RSS side.
          if (!URL_RE.test(atomUrl)) return;
          const publishedAt = atomPublished.trim() !== '' ? atomPublished.trim() : atomUpdated.trim();
          consider({
            url: atomUrl,
            title: atomTitle.trim(),
            publishedAt: publishedAt === '' ? null : publishedAt,
          });
        });
      },
    })
    .on('entry > title', {
      text(chunk) {
        atomTitle += chunk.text;
      },
    })
    .on('entry > link', {
      element(el) {
        // Atom entries commonly carry several <link> elements (self,
        // alternate, ...). Keep the first one that is either unmarked or
        // explicitly `rel="alternate"` and actually looks like a URL, and
        // never overwrite once set.
        const rel = el.getAttribute('rel');
        if (atomUrl !== '' || (rel !== null && rel !== 'alternate')) return;
        const href = el.getAttribute('href') ?? '';
        if (URL_RE.test(href)) atomUrl = href;
      },
    })
    .on('entry > published', {
      text(chunk) {
        atomPublished += chunk.text;
      },
    })
    .on('entry > updated', {
      text(chunk) {
        atomUpdated += chunk.text;
      },
    })
    .transform(response);

  try {
    await drain(rewritten);
  } catch {
    // Expected exactly when `bound.abort.abort()` fired above: the aborted
    // source errors and the native `pipeTo` drain rejects in turn. Catching
    // it here - rather than switching to a `getReader()` loop that could
    // avoid the throw - is what keeps the drain native; see the module doc
    // comment for why that split is the point of this shape.
  }

  return items;
}

/**
 * Applies the recency window (spec.md, "The recency window in `gather`") -
 * the authoritative filter. `parseFeed`'s optional bound only ever decides
 * when to stop *reading*; this function alone decides what is *kept*, which
 * is what makes requirement 2 testable by differential comparison rather
 * than by inspecting the parser. Dated items are filtered by `windowDays`,
 * never truncated by rank, so a full arXiv announcement day survives intact;
 * items with no parseable date are kept in the feed's own order (every
 * allowlisted feed lists newest first) up to `undatedMax`. `windowDays` and
 * `undatedMax` are passed in rather than defined here - they are
 * `GATHER_WINDOW_DAYS` and `GATHER_UNDATED_MAX_PER_FEED` in
 * `src/workflow.ts`, and this module does not redefine them.
 *
 * Reads `item.publishedMs`, already parsed once by `parseFeed` - this
 * function calls `Date.parse` zero times. A caller that needs the value
 * again (`gatherCandidates`'s D1 write, `shortlist`'s SQL ordering) reads
 * `publishedMs` off the result rather than re-parsing: a second `Date.parse`
 * per item is a cost this feature measured and ruled out (spec.md, "What
 * bounding must not cost").
 */
export function applyGatherWindow(
  items: ParsedItem[],
  opts: { windowDays: number; undatedMax: number; now?: Date },
): ParsedItem[] {
  const now = opts.now ?? new Date();
  const cutoffMs = now.getTime() - opts.windowDays * 24 * 60 * 60 * 1000;

  const dated: ParsedItem[] = [];
  const undated: ParsedItem[] = [];
  for (const item of items) {
    if (item.publishedMs === null) {
      undated.push(item);
    } else if (item.publishedMs >= cutoffMs) {
      dated.push(item);
    }
    // Dated but older than the cutoff: dropped, not counted against either cap.
  }

  return [...dated, ...undated.slice(0, opts.undatedMax)];
}
