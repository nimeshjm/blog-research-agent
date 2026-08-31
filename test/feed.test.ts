import { describe, expect, it } from 'vitest';
import { applyGatherWindow, parseFeed } from '../src/lib/feed';
import type { ParseBound } from '../src/lib/feed';
import type { ParsedItem } from '../src/lib/types';
import { GATHER_UNDATED_MAX_PER_FEED, GATHER_WINDOW_DAYS } from '../src/gather-workflow';

/**
 * `applyGatherWindow` reads `publishedMs`; it no longer parses `publishedAt`
 * itself (spec.md, "What bounding must not cost"). Fixtures below build
 * `publishedMs` the same way `parseFeed` does, once, here - not inside
 * `applyGatherWindow` - so these tests exercise the same contract a real
 * caller (`gatherCandidates`) relies on.
 */
function parsed(item: { url: string; title: string; publishedAt: string | null }): ParsedItem {
  const ms = item.publishedAt === null ? Number.NaN : Date.parse(item.publishedAt);
  return { ...item, publishedMs: Number.isNaN(ms) ? null : ms };
}

/**
 * RSS fixtures below reproduce the two HTML-tokenizer traps documented in
 * src/lib/feed.ts, verified empirically against the real feeds before this
 * file was written:
 *  - `<link>` is an HTML void element - its text must still come through.
 *  - `<guid isPermaLink="false">` (arXiv, Stack Overflow) is NOT the URL and
 *    must never be used as a fallback.
 *  - `<description>`'s CDATA body (which can itself contain an
 *    "http://..." string) must never leak into the extracted url/title.
 */
function rssItem(opts: { title: string; url: string; guid?: string; pubDate?: string }): string {
  const guid = opts.guid ?? 'not-a-url-guid-' + Math.random().toString(36).slice(2);
  return `<item>
<title>${opts.title}</title>
<link>${opts.url}</link>
<guid isPermaLink="false">${guid}</guid>
${opts.pubDate ? `<pubDate>${opts.pubDate}</pubDate>` : ''}
<description><![CDATA[commentary text with a decoy url http://decoy.example/should-not-leak inside]]></description>
</item>`;
}

function rssFeed(items: string): string {
  return `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Fixture Feed</title>
${items}
</channel></rss>`;
}

function atomEntry(opts: { title: string; url: string; published?: string; updated?: string }): string {
  return `<entry>
<title>${opts.title}</title>
<link rel="self" href="https://example.com/self-link-not-the-article"/>
<link rel="alternate" href="${opts.url}"/>
<id>urn:uuid:${Math.random().toString(36).slice(2)}</id>
${opts.published ? `<published>${opts.published}</published>` : ''}
${opts.updated ? `<updated>${opts.updated}</updated>` : ''}
</entry>`;
}

function atomFeed(entries: string): string {
  return `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Fixture Feed</title>
${entries}
</feed>`;
}

describe('parseFeed() - RSS', () => {
  it('extracts the <link> text, not the non-URL <guid>', async () => {
    const xml = rssFeed(
      rssItem({
        title: 'A paper',
        url: 'https://example.com/a-paper',
        guid: 'oai:arXiv.org:2608.00001v1',
        pubDate: 'Wed, 26 Aug 2026 00:00:00 GMT',
      }),
    );
    const items = await parseFeed(new Response(xml));
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('https://example.com/a-paper');
    expect(items[0]?.title).toBe('A paper');
    expect(items[0]?.publishedAt).toBe('Wed, 26 Aug 2026 00:00:00 GMT');
  });

  it('never leaks the CDATA-wrapped <description> text into url or title', async () => {
    const xml = rssFeed(rssItem({ title: 'Real title', url: 'https://example.com/real' }));
    const items = await parseFeed(new Response(xml));
    expect(items[0]?.url).toBe('https://example.com/real');
    expect(items[0]?.title).toBe('Real title');
    expect(items[0]?.url).not.toContain('decoy');
    expect(items[0]?.title).not.toContain('decoy');
  });

  it('returns publishedAt: null when pubDate is absent', async () => {
    const xml = rssFeed(rssItem({ title: 'No date', url: 'https://example.com/no-date' }));
    const items = await parseFeed(new Response(xml));
    expect(items[0]?.publishedAt).toBeNull();
  });

  it('parses multiple items in document order', async () => {
    const xml = rssFeed(
      [
        rssItem({ title: 'First', url: 'https://example.com/1', pubDate: 'Wed, 26 Aug 2026 00:00:00 GMT' }),
        rssItem({ title: 'Second', url: 'https://example.com/2', pubDate: 'Tue, 25 Aug 2026 00:00:00 GMT' }),
      ].join('\n'),
    );
    const items = await parseFeed(new Response(xml));
    expect(items.map((i) => i.title)).toEqual(['First', 'Second']);
    expect(items.map((i) => i.url)).toEqual(['https://example.com/1', 'https://example.com/2']);
  });

  it('drops an item whose <link> is empty, instead of mistaking the next element (guid) for the URL', async () => {
    // The `item` text handler that recovers <link>'s void-element text also
    // sees every other direct child's text (title, guid, pubDate). An empty
    // <link></link> must not let the *next* chunk it sees - here <guid>, a
    // non-URL string, exactly the shape this workaround exists to avoid -
    // be mistaken for the URL.
    const xml = rssFeed(
      `<item>
<title>Empty link</title>
<link></link>
<guid isPermaLink="false">oai:arXiv.org:2608.99999v1</guid>
<pubDate>Wed, 26 Aug 2026 00:00:00 GMT</pubDate>
</item>`,
    );
    const items = await parseFeed(new Response(xml));
    expect(items).toHaveLength(0);
  });

  it('drops an item with no <link> element at all', async () => {
    const xml = rssFeed(
      `<item>
<title>No link at all</title>
<guid isPermaLink="false">some-uuid</guid>
<pubDate>Wed, 26 Aug 2026 00:00:00 GMT</pubDate>
</item>`,
    );
    const items = await parseFeed(new Response(xml));
    expect(items).toHaveLength(0);
  });
});

describe('parseFeed() - Atom', () => {
  it('extracts href from the rel="alternate" <link>, not rel="self"', async () => {
    const xml = atomFeed(
      atomEntry({
        title: 'An Atom entry',
        url: 'https://example.com/atom-article',
        published: '2026-08-20T12:00:00Z',
      }),
    );
    const items = await parseFeed(new Response(xml));
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('https://example.com/atom-article');
    expect(items[0]?.title).toBe('An Atom entry');
    expect(items[0]?.publishedAt).toBe('2026-08-20T12:00:00Z');
  });

  it('falls back to <updated> when <published> is absent', async () => {
    const xml = atomFeed(
      atomEntry({ title: 'Updated only', url: 'https://example.com/updated-only', updated: '2026-08-19T00:00:00Z' }),
    );
    const items = await parseFeed(new Response(xml));
    expect(items[0]?.publishedAt).toBe('2026-08-19T00:00:00Z');
  });

  it('parses multiple entries in document order', async () => {
    const xml = atomFeed(
      [
        atomEntry({ title: 'E1', url: 'https://example.com/e1', published: '2026-08-20T00:00:00Z' }),
        atomEntry({ title: 'E2', url: 'https://example.com/e2', published: '2026-08-19T00:00:00Z' }),
      ].join('\n'),
    );
    const items = await parseFeed(new Response(xml));
    expect(items.map((i) => i.title)).toEqual(['E1', 'E2']);
  });

  it('drops an entry that carries only a rel="self" <link>, never a real article URL', async () => {
    const xml = atomFeed(
      `<entry>
<title>Self-link only</title>
<link rel="self" href="https://example.com/self-link-not-the-article"/>
<id>urn:uuid:abc</id>
<published>2026-08-20T00:00:00Z</published>
</entry>`,
    );
    const items = await parseFeed(new Response(xml));
    expect(items).toHaveLength(0);
  });
});

describe('applyGatherWindow()', () => {
  const now = new Date('2026-08-27T00:00:00Z');

  it('emits only items inside the window, dropping items outside it', () => {
    const items = [
      { url: 'https://example.com/inside', title: 'Inside', publishedAt: '2026-08-10T00:00:00Z' }, // 17 days
      { url: 'https://example.com/outside', title: 'Outside', publishedAt: '2026-06-01T00:00:00Z' }, // ~87 days
      { url: 'https://example.com/edge', title: 'Edge', publishedAt: '2026-07-28T00:00:00Z' }, // exactly 30 days
    ].map(parsed);
    const result = applyGatherWindow(items, { windowDays: GATHER_WINDOW_DAYS, undatedMax: GATHER_UNDATED_MAX_PER_FEED, now });
    const urls = result.map((i) => i.url);
    expect(urls).toContain('https://example.com/inside');
    expect(urls).toContain('https://example.com/edge');
    expect(urls).not.toContain('https://example.com/outside');
    expect(result).toHaveLength(2);
  });

  it('does not truncate a full day of all-dated items (arXiv cs.AI shape: 352 items, all inside the window)', () => {
    const items = Array.from({ length: 352 }, (_, i) => ({
      url: `https://arxiv.org/abs/2608.${String(i).padStart(5, '0')}`,
      title: `Paper ${i}`,
      publishedAt: '2026-08-27T00:00:00Z',
    })).map(parsed);
    const result = applyGatherWindow(items, { windowDays: GATHER_WINDOW_DAYS, undatedMax: GATHER_UNDATED_MAX_PER_FEED, now });
    expect(result).toHaveLength(352);
    expect(result.every((i) => i.publishedAt !== null)).toBe(true);
  });

  it(`caps undated items at ${GATHER_UNDATED_MAX_PER_FEED} per feed, keeping feed order`, () => {
    const undatedCount = GATHER_UNDATED_MAX_PER_FEED + 15;
    const items = Array.from({ length: undatedCount }, (_, i) => ({
      url: `https://example.com/undated-${i}`,
      title: `Undated ${i}`,
      publishedAt: null,
    })).map(parsed);
    const result = applyGatherWindow(items, { windowDays: GATHER_WINDOW_DAYS, undatedMax: GATHER_UNDATED_MAX_PER_FEED, now });
    expect(result).toHaveLength(GATHER_UNDATED_MAX_PER_FEED);
    // Feed order (i.e. newest-first, by the allowlist's own convention) is kept.
    expect(result.map((i) => i.url)).toEqual(
      Array.from({ length: GATHER_UNDATED_MAX_PER_FEED }, (_, i) => `https://example.com/undated-${i}`),
    );
  });

  it('an unparseable date string is treated as undated, not silently dropped', () => {
    const items = [{ url: 'https://example.com/x', title: 'x', publishedAt: 'not a date' }].map(parsed);
    const result = applyGatherWindow(items, { windowDays: GATHER_WINDOW_DAYS, undatedMax: GATHER_UNDATED_MAX_PER_FEED, now });
    expect(result).toHaveLength(1);
  });

  it('carries the parsed epoch-ms for a dated item, so callers never re-parse it', () => {
    const items = [{ url: 'https://example.com/dated', title: 'Dated', publishedAt: '2026-08-20T12:00:00Z' }].map(parsed);
    const result = applyGatherWindow(items, { windowDays: GATHER_WINDOW_DAYS, undatedMax: GATHER_UNDATED_MAX_PER_FEED, now });
    expect(result[0]?.publishedMs).toBe(Date.parse('2026-08-20T12:00:00Z'));
  });

  it('sets publishedMs to null for an undated item', () => {
    const items = [{ url: 'https://example.com/undated', title: 'Undated', publishedAt: null }].map(parsed);
    const result = applyGatherWindow(items, { windowDays: GATHER_WINDOW_DAYS, undatedMax: GATHER_UNDATED_MAX_PER_FEED, now });
    expect(result[0]?.publishedMs).toBeNull();
  });

  it('mixes dated (unbounded) and undated (capped) items in one feed', () => {
    const dated = Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/dated-${i}`,
      title: `Dated ${i}`,
      publishedAt: '2026-08-27T00:00:00Z',
    }));
    const undated = Array.from({ length: GATHER_UNDATED_MAX_PER_FEED + 5 }, (_, i) => ({
      url: `https://example.com/undated-${i}`,
      title: `Undated ${i}`,
      publishedAt: null,
    }));
    const result = applyGatherWindow([...dated, ...undated].map(parsed), {
      windowDays: GATHER_WINDOW_DAYS,
      undatedMax: GATHER_UNDATED_MAX_PER_FEED,
      now,
    });
    expect(result).toHaveLength(5 + GATHER_UNDATED_MAX_PER_FEED);
  });
});

describe('parseFeed() - bounded (ParseBound)', () => {
  const now = new Date('2026-08-27T00:00:00Z');
  const freshDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toUTCString(); // well inside a 30-day window
  const staleDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toUTCString(); // well outside it
  const cutoffMs = now.getTime() - GATHER_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  function bound(overrides: Partial<Pick<ParseBound, 'staleRun' | 'rawMax'>> = {}): ParseBound {
    return { abort: new AbortController(), cutoffMs, staleRun: 3, rawMax: 1000, ...overrides };
  }

  it('acceptance criterion 4 (loses nothing): a single out-of-order stale item does not stop the parse', async () => {
    const xml = rssFeed(
      [
        rssItem({ title: 'One stale', url: 'https://example.com/stale', pubDate: staleDate }),
        rssItem({ title: 'Fresh 1', url: 'https://example.com/fresh-1', pubDate: freshDate }),
        rssItem({ title: 'Fresh 2', url: 'https://example.com/fresh-2', pubDate: freshDate }),
      ].join('\n'),
    );
    const items = await parseFeed(new Response(xml), bound());
    expect(items.map((i) => i.url)).toEqual([
      'https://example.com/stale',
      'https://example.com/fresh-1',
      'https://example.com/fresh-2',
    ]);
  });

  // The test above passes whether or not the counter resets, because one stale
  // item never reaches `staleRun` either way - deleting `staleRun = 0` left it
  // green. This is the case that separates "consecutive" from "cumulative":
  // `staleRun` scattered stale items, each followed by a fresh one. A counter
  // that never resets reaches the threshold on the last stale item and
  // truncates the tail; a counter that resets never exceeds 1.
  it('acceptance criterion 4 (consecutive, not cumulative): staleRun stale items scattered among fresh ones stop nothing', async () => {
    const staleRun = 3;
    const xml = rssFeed(
      Array.from({ length: staleRun }, (_, i) => [
        rssItem({ title: `Scattered stale ${i}`, url: `https://example.com/scattered-stale-${i}`, pubDate: staleDate }),
        rssItem({ title: `Interleaved fresh ${i}`, url: `https://example.com/interleaved-fresh-${i}`, pubDate: freshDate }),
      ])
        .flat()
        .concat(rssItem({ title: 'Tail', url: 'https://example.com/tail', pubDate: freshDate }))
        .join('\n'),
    );
    const items = await parseFeed(new Response(xml), bound({ staleRun }));
    expect(items).toHaveLength(staleRun * 2 + 1);
    expect(items.map((i) => i.url)).toContain('https://example.com/tail');
  });

  it('acceptance criterion 4 (does stop): staleRun consecutive stale dated items stop the parse', async () => {
    const staleRun = 3;
    const xml = rssFeed(
      [
        ...Array.from({ length: staleRun }, (_, i) =>
          rssItem({ title: `Stale ${i}`, url: `https://example.com/stale-${i}`, pubDate: staleDate }),
        ),
        // Fresh, but the parse never reaches it - proving the stop is real, not bookkeeping.
        rssItem({ title: 'Never read', url: 'https://example.com/never-read', pubDate: freshDate }),
      ].join('\n'),
    );
    const b = bound({ staleRun });
    const items = await parseFeed(new Response(xml), b);
    expect(items).toHaveLength(staleRun);
    expect(items.map((i) => i.url)).not.toContain('https://example.com/never-read');
    // The stop has to cancel the *source*, not just stop collecting: that is
    // the whole mechanism (spec.md, "the drain stays native"). Nothing here
    // has a live fetch to cancel, so this asserts the signal was raised -
    // deleting `bound.abort.abort()` otherwise leaves the suite green while
    // removing the entire CPU saving. The live 46-feed differential is what
    // proves an aborted real response still yields the same candidates.
    expect(b.abort.signal.aborted).toBe(true);
  });

  it('an undated item interleaved among stale dated items neither increments nor resets the stale counter', async () => {
    const staleRun = 3;
    const xml = rssFeed(
      [
        rssItem({ title: 'Stale 1', url: 'https://example.com/s1', pubDate: staleDate }),
        rssItem({ title: 'Undated A', url: 'https://example.com/u-a' }),
        rssItem({ title: 'Stale 2', url: 'https://example.com/s2', pubDate: staleDate }),
        rssItem({ title: 'Undated B', url: 'https://example.com/u-b' }),
        rssItem({ title: 'Stale 3', url: 'https://example.com/s3', pubDate: staleDate }),
        // The third *dated* stale item is what trips staleRun=3; if the two
        // undated items in between counted toward it (or reset it), this
        // item would be read too.
        rssItem({ title: 'Never read', url: 'https://example.com/never-read', pubDate: freshDate }),
      ].join('\n'),
    );
    const items = await parseFeed(new Response(xml), bound({ staleRun }));
    expect(items.map((i) => i.url)).toEqual([
      'https://example.com/s1',
      'https://example.com/u-a',
      'https://example.com/s2',
      'https://example.com/u-b',
      'https://example.com/s3',
    ]);
  });

  it('acceptance criterion 3: a wholly undated feed parses at most rawMax raw items', async () => {
    // rawMax is small on purpose: GATHER_RAW_ITEM_MAX (2,000, workflow.ts) is
    // a policy value sized against the allowlist; this proves the mechanism
    // that enforces whatever value it is given, without a 2,000-item fixture.
    const rawMax = 5;
    const items = Array.from({ length: rawMax + 10 }, (_, i) =>
      rssItem({ title: `Undated ${i}`, url: `https://example.com/undated-${i}` }),
    );
    const xml = rssFeed(items.join('\n'));
    const result = await parseFeed(new Response(xml), bound({ rawMax }));
    expect(result).toHaveLength(rawMax);
  });

  it('requirement 2 (fixture level): a bound that fires yields the same applyGatherWindow output as an unbounded parse', async () => {
    const fresh = Array.from({ length: 5 }, (_, i) =>
      rssItem({ title: `Fresh ${i}`, url: `https://example.com/fresh-${i}`, pubDate: freshDate }),
    );
    const stale = Array.from({ length: 8 }, (_, i) =>
      rssItem({ title: `Stale ${i}`, url: `https://example.com/stale-${i}`, pubDate: staleDate }),
    );
    const xml = rssFeed([...fresh, ...stale].join('\n'));

    const boundedItems = await parseFeed(new Response(xml), bound({ staleRun: 3 }));
    const unboundedItems = await parseFeed(new Response(xml));

    // The bound actually fired - the raw parse read strictly fewer items
    // than the unbounded parse, not merely the same items relabelled.
    expect(boundedItems.length).toBeLessThan(unboundedItems.length);

    const opts = { windowDays: GATHER_WINDOW_DAYS, undatedMax: GATHER_UNDATED_MAX_PER_FEED, now };
    const boundedResult = applyGatherWindow(boundedItems, opts);
    const unboundedResult = applyGatherWindow(unboundedItems, opts);

    expect(boundedResult.map((i) => i.url)).toEqual(unboundedResult.map((i) => i.url));
    expect(boundedResult).toHaveLength(5);
  });
});
