import type { Source } from './types';
import rawFeeds from '../../config/feeds.json';

/**
 * Typed loader over the version-controlled RSS/Atom allowlist
 * (`config/feeds.json`). Carries no URL literal of its own - the JSON file
 * is invisible to `rules/no-hardcoded-urls.yml` (`language: TypeScript`),
 * whereas 46 URLs inlined here would fire it 46 times. See plan.md, "Data
 * and repo seams".
 *
 * `resolveJsonModule` (tsconfig.json) is what makes the import below
 * typecheck; without it `tsc --noEmit` fails TS2732.
 */
export function loadFeeds(): Source[] {
  return rawFeeds.map((entry, i) => validateSource(entry, i));
}

/**
 * Curation priority (#99), and the only thing in this repo that expresses
 * one source as more wanted than another. Lower is earlier, `nice`-style. Two
 * orderings read it, and neither is a filter - a tier reorders, so a
 * deferred source is last rather than gone:
 *
 *  1. `chunkSourcesByVolume` (src/workflow.ts) emits each child's chunk in
 *     tier order, so a priority feed is parsed before a deferred one *inside
 *     a child*. The five children still run concurrently, so this buys order
 *     within a chunk, not a global read order - what it actually protects
 *     against is a child that dies on the 10 ms CPU limit partway through
 *     its chunk (run `bd33248b`), which loses whatever it had not parsed
 *     yet. Deferring the arXiv feeds puts the 783-item one last, where it
 *     can only cost itself.
 *  2. `relevanceScore` (src/workflow.ts) scores a priority source up and a
 *     deferred one down, so the 15 candidates that reach a
 *     `SummarizeWorkflow` child - the only ones that cost neurons - skew to
 *     priority sources without being confined to them. It is an offset and
 *     not a sort key on purpose: see `TIER_SCORE_WEIGHT` there.
 *
 * `SOURCE_TIER_DEFAULT` is what an entry with no `tier` key gets, which is
 * most of the allowlist: the key marks the exceptions rather than being
 * restated 46 times.
 */
export const SOURCE_TIER_PRIORITY = 0;
export const SOURCE_TIER_DEFAULT = 1;
export const SOURCE_TIER_DEFERRED = 2;

export function tierOf(source: Source): number {
  return source.tier ?? SOURCE_TIER_DEFAULT;
}

/**
 * Tier by source *name*, for the shortlist half: a `Candidate` carries
 * `sourceName` (written by gather, read back by `readRunCandidates`) and not
 * the `Source` it came from, so name is the only join there is. A candidate
 * whose source has since left the allowlist scores as
 * `SOURCE_TIER_DEFAULT` - `run_candidates` rows outlive an edit to
 * `config/feeds.json`.
 */
export function sourceTiers(): Map<string, number> {
  return new Map(loadFeeds().map((source) => [source.name, tierOf(source)]));
}

/**
 * Guards against a malformed or hand-edited `config/feeds.json` reaching the
 * pipeline silently - a missing `feedUrl` would otherwise surface many steps
 * later, inside a per-feed `gather:<source>` step, as an opaque fetch
 * failure instead of here.
 */
function validateSource(entry: unknown, index: number): Source {
  const obj = entry as Partial<Source> | null;
  if (
    obj === null ||
    typeof obj !== 'object' ||
    typeof obj.name !== 'string' ||
    obj.name === '' ||
    typeof obj.feedUrl !== 'string' ||
    !/^https?:\/\//.test(obj.feedUrl)
  ) {
    throw new Error(`config/feeds.json: entry ${index} is not a valid { name, feedUrl } Source`);
  }
  // A tier out of range would not throw anywhere downstream - it would just
  // sort somewhere unintended and quietly change which sources reach the
  // shortlist, which is the failure mode this loader exists to prevent.
  if (obj.tier !== undefined && !(Number.isInteger(obj.tier) && obj.tier >= SOURCE_TIER_PRIORITY && obj.tier <= SOURCE_TIER_DEFERRED)) {
    throw new Error(`config/feeds.json: entry ${index} has tier ${String(obj.tier)}, not an integer in ${SOURCE_TIER_PRIORITY}..${SOURCE_TIER_DEFERRED}`);
  }
  return obj.tier === undefined
    ? { name: obj.name, feedUrl: obj.feedUrl }
    : { name: obj.name, feedUrl: obj.feedUrl, tier: obj.tier };
}
