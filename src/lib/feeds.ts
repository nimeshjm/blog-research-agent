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
  return { name: obj.name, feedUrl: obj.feedUrl };
}
