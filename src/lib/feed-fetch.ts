import type { ParseBound } from './feed';
import { parseFeed } from './feed';
import type { ParsedItem } from './types';

/**
 * Shared by both Workflow entrypoints: `src/workflow.ts` calls this unbounded
 * for `proposeTopic`/`fetchFeedTitles` (the newest item regardless of
 * window - spec.md req. 12), and `src/gather-workflow.ts` calls it bounded,
 * per feed, inside `gatherCandidates`. Pulled out to its own file rather than
 * duplicated in both - REVIEW.md pass 5 - once gather moved into its own
 * Workflow entrypoint (feature 003) and needed the same fetch-and-parse this
 * function already was.
 *
 * `bound`, when given, is threaded two places: as the `fetch`'s abort signal
 * (so cancelling it actually stops the network read, not only the
 * in-process parse) and into `parseFeed` (so it can decide when to stop
 * reading and call `bound.abort.abort()` itself). `parseFeed` absorbs the
 * rejection that abort causes in its own drain - see its module doc comment
 * - so by the time control reaches this function's `catch`, an aborted
 * bounded parse has already returned normally with whatever it read. This
 * `catch` therefore only ever sees a genuine fetch/parse failure, never the
 * bound firing; if that stopped being true, a bound tripping on every
 * archive feed would look identical to a dead feed here, and every one of
 * them would silently contribute zero candidates.
 */
export async function fetchFeedItems(feedUrl: string, bound?: ParseBound): Promise<ParsedItem[]> {
  try {
    const response = await fetch(feedUrl, bound === undefined ? undefined : { signal: bound.abort.signal });
    if (!response.ok) return [];
    return await parseFeed(response, bound);
  } catch {
    return [];
  }
}
