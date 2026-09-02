import { describe, expect, it } from 'vitest';
import { loadFeeds, SOURCE_TIER_DEFAULT, SOURCE_TIER_DEFERRED, SOURCE_TIER_PRIORITY, sourceTiers, tierOf } from '../src/lib/feeds';

describe('loadFeeds()', () => {
  it('loads all 46 allowlisted feeds', () => {
    expect(loadFeeds()).toHaveLength(46);
  });

  it('every entry is a { name, feedUrl } Source with an http(s) URL', () => {
    for (const source of loadFeeds()) {
      expect(source.name).not.toBe('');
      expect(source.feedUrl).toMatch(/^https?:\/\//);
    }
  });

  it('has no duplicate names', () => {
    const names = loadFeeds().map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('source tiers', () => {
  it('every Anthropic and OpenAI feed is a priority source', () => {
    const priority = loadFeeds()
      .filter((s) => tierOf(s) === SOURCE_TIER_PRIORITY)
      .map((s) => s.name);
    expect(priority.sort()).toEqual([
      'Anthropic Engineering', 'Anthropic Frontier Red Team', 'Anthropic News', 'Anthropic Research',
      'Claude', 'OpenAI', 'OpenAI Developer', 'OpenAI Engineering', 'OpenAI Research',
    ]);
  });

  it('both arXiv feeds are deferred, and nothing else is', () => {
    const deferred = loadFeeds()
      .filter((s) => tierOf(s) === SOURCE_TIER_DEFERRED)
      .map((s) => s.name);
    expect(deferred.sort()).toEqual(['arXiv cs.AI', 'arXiv cs.SE']);
  });

  it('an entry with no tier key defaults to SOURCE_TIER_DEFAULT rather than to priority', () => {
    expect(tierOf({ name: 'x', feedUrl: 'https://x.test/feed' })).toBe(SOURCE_TIER_DEFAULT);
    // The default is the middle tier, so an unmarked feed neither jumps the
    // curated sources nor sinks below the deliberately deferred ones.
    expect(SOURCE_TIER_PRIORITY).toBeLessThan(SOURCE_TIER_DEFAULT);
    expect(SOURCE_TIER_DEFAULT).toBeLessThan(SOURCE_TIER_DEFERRED);
  });

  it('sourceTiers() keys the tier by source name, which is all a Candidate carries', () => {
    const tiers = sourceTiers();
    expect(tiers.size).toBe(loadFeeds().length);
    expect(tiers.get('Anthropic Research')).toBe(SOURCE_TIER_PRIORITY);
    expect(tiers.get('arXiv cs.AI')).toBe(SOURCE_TIER_DEFERRED);
    expect(tiers.get('Martin Fowler')).toBe(SOURCE_TIER_DEFAULT);
    expect(tiers.get('Delisted Blog')).toBeUndefined();
  });
});
