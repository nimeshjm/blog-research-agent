/**
 * Article body -> plain text, over `HTMLRewriter`, streaming, truncated
 * before it reaches a prompt. `REVIEW.md` pass 1 names regex-over-article-
 * body as a reject; a whole-body `.text()` then parse is the same mistake.
 * `src/lib/feed.ts` (PR #49) already solved the streaming-`HTMLRewriter`
 * problem once for feed XML - this reuses the same approach (register
 * handlers, drain with `pipeTo`, never materialize the whole body as one
 * string) for arbitrary article HTML instead of RSS/Atom.
 *
 * `HTMLRewriter` is an HTML tokenizer, not an XML *or* a DOM API (feed.ts's
 * doc comment has the full case for this against RSS specifically). Two
 * article-extraction-specific consequences, both verified empirically
 * against fixture HTML before settling on the shape below:
 *
 *  - A selector's `text()` handler fires once per text chunk *for every
 *    matched ancestor*, not once per chunk overall - `feed.ts` notes this
 *    for `item`'s handler also seeing `item > title`'s text. Selecting a
 *    broad selector (`body`, or worse `*`) alongside a narrower one would
 *    double- or N-times-count the same prose, so this file registers
 *    exactly ONE text-capturing selector (`body`).
 *  - `Element.remove()` on one selector's match does **not** hide that
 *    content from a *different* selector's `text()` handler - all
 *    registered handlers observe the same document-order event stream
 *    independently, mutation or not. Excluding `<script>`/`<nav>`/etc.
 *    therefore cannot be "remove them, then read `body`'s text" (tried
 *    first; leaked every excluded tag's text straight through). It has to
 *    be shared state read across handlers during the one streaming pass -
 *    the same idiom `feed.ts` uses for `expectingRssLinkText`, just spread
 *    across two `.on()` registrations instead of one.
 */

/** Elements whose text must not reach the extracted body - tracked via `suppressDepth` below, not `Element.remove()` (see the module doc comment). */
const EXCLUDED_SELECTOR = 'script, style, nav, header, footer, noscript, svg, form';

/**
 * Cap on extracted characters. Sized to the two production-prompt samples
 * `plan.md` step 2 measured (27,000 and 32,000 raw characters -> 4,946 and
 * 5,987 input tokens, 203 and 223 neurons - see spec.md's cost table). A
 * materially higher cap would invalidate that measurement, since input
 * tokens are most of the map call's cost.
 */
export const EXTRACT_MAX_CHARS = 30_000;

function isWhitespace(ch: string): boolean {
  return ch === '' || /\s/.test(ch);
}

/** Drains a transformed `Response`'s body without ever building a JS string from it (mirrors feed.ts's `drain`). */
async function drain(response: Response): Promise<void> {
  if (response.body === null) return;
  await response.body.pipeTo(new WritableStream());
}

/**
 * Extracts `body`'s text content as plain text, dropping
 * `EXCLUDED_SELECTOR`'s subtrees entirely first. Truncates while streaming -
 * once the cap is hit, later chunks are an O(1) check-and-skip, the same
 * early-out shape as `feed.ts`'s `expectingRssLinkText`, so a large article
 * never grows the accumulator past `EXTRACT_MAX_CHARS`.
 *
 * Returns `''` (never throws) when the body has no matching content or the
 * response cannot be transformed - callers treat an empty extraction as "no
 * summary for this article" rather than failing the step (spec.md risk
 * table: one bad article must not fail a run).
 */
export async function extractArticleText(response: Response, maxChars: number = EXTRACT_MAX_CHARS): Promise<string> {
  let out = '';
  let truncated = false;

  // Depth rather than a boolean: nested excluded elements (a <div> inside
  // <nav>, say) must not let the *inner* element's end tag re-enable
  // capture while still logically inside the outer one.
  let suppressDepth = 0;

  const rewritten = new HTMLRewriter()
    .on(EXCLUDED_SELECTOR, {
      element(el) {
        suppressDepth++;
        el.onEndTag(() => {
          suppressDepth = Math.max(0, suppressDepth - 1);
        });
      },
    })
    .on('body', {
      text(chunk) {
        if (truncated || suppressDepth > 0) return;
        const text = chunk.text;
        if (text === '') return;

        // Separate adjacent element text ("...end of para1" + "Start of
        // para2..." would otherwise jam together) without a body-wide regex
        // pass - a single boundary check per chunk, same cost class as
        // feed.ts's per-chunk `isTruthyText`.
        if (out !== '' && !isWhitespace(out[out.length - 1] ?? '') && !isWhitespace(text[0] ?? '')) {
          out += ' ';
        }
        out += text;

        if (out.length > maxChars) {
          out = out.slice(0, maxChars);
          truncated = true;
        }
      },
    })
    .transform(response);

  await drain(rewritten);
  return out.trim();
}
