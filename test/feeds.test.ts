import { describe, expect, it } from 'vitest';
import { loadFeeds } from '../src/lib/feeds';

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
