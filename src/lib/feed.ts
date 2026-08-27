import type { FeedItem } from './types';

/**
 * RSS 2.0 and Atom parsing over `HTMLRewriter`, the platform's native
 * streaming parser - this is what keeps arXiv cs.AI (743 KiB, the largest
 * feed in the allowlist) inside the 10 ms per-step CPU budget.
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
 * Parses one feed response - RSS 2.0, Atom, or both handlers finding
 * nothing (an unrecognised format) - into raw `FeedItem`s: no recency
 * window, no ranking, no D1. `gatherCandidates` in `src/workflow.ts`
 * applies `applyGatherWindow` and attaches the source name to turn these
 * into `Candidate`s.
 */
export async function parseFeed(response: Response): Promise<FeedItem[]> {
  const items: FeedItem[] = [];

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
          items.push({
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
          items.push({
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

  await drain(rewritten);
  return items;
}

/**
 * Applies the recency window (spec.md, "The recency window in `gather`"):
 * dated items are filtered by `windowDays`, never truncated by rank, so a
 * full arXiv announcement day survives intact; items with no parseable date
 * are kept in the feed's own order (every allowlisted feed lists newest
 * first) up to `undatedMax`. `windowDays` and `undatedMax` are passed in
 * rather than defined here - they are `GATHER_WINDOW_DAYS` and
 * `GATHER_UNDATED_MAX_PER_FEED` in `src/workflow.ts`, and this module does
 * not redefine them.
 */
export function applyGatherWindow(
  items: FeedItem[],
  opts: { windowDays: number; undatedMax: number; now?: Date },
): FeedItem[] {
  const now = opts.now ?? new Date();
  const cutoffMs = now.getTime() - opts.windowDays * 24 * 60 * 60 * 1000;

  const dated: FeedItem[] = [];
  const undated: FeedItem[] = [];
  for (const item of items) {
    const parsedMs = item.publishedAt === null ? Number.NaN : Date.parse(item.publishedAt);
    if (Number.isNaN(parsedMs)) {
      undated.push(item);
    } else if (parsedMs >= cutoffMs) {
      dated.push(item);
    }
    // Dated but older than the cutoff: dropped, not counted against either cap.
  }

  return [...dated, ...undated.slice(0, opts.undatedMax)];
}
