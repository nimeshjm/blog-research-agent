import { describe, expect, it } from 'vitest';
import { applyGatherWindow, parseFeed } from '../src/lib/feed';
import { GATHER_UNDATED_MAX_PER_FEED, GATHER_WINDOW_DAYS } from '../src/workflow';

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
    ];
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
    }));
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
    }));
    const result = applyGatherWindow(items, { windowDays: GATHER_WINDOW_DAYS, undatedMax: GATHER_UNDATED_MAX_PER_FEED, now });
    expect(result).toHaveLength(GATHER_UNDATED_MAX_PER_FEED);
    // Feed order (i.e. newest-first, by the allowlist's own convention) is kept.
    expect(result.map((i) => i.url)).toEqual(
      Array.from({ length: GATHER_UNDATED_MAX_PER_FEED }, (_, i) => `https://example.com/undated-${i}`),
    );
  });

  it('an unparseable date string is treated as undated, not silently dropped', () => {
    const items = [{ url: 'https://example.com/x', title: 'x', publishedAt: 'not a date' }];
    const result = applyGatherWindow(items, { windowDays: GATHER_WINDOW_DAYS, undatedMax: GATHER_UNDATED_MAX_PER_FEED, now });
    expect(result).toHaveLength(1);
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
    const result = applyGatherWindow([...dated, ...undated], {
      windowDays: GATHER_WINDOW_DAYS,
      undatedMax: GATHER_UNDATED_MAX_PER_FEED,
      now,
    });
    expect(result).toHaveLength(5 + GATHER_UNDATED_MAX_PER_FEED);
  });
});
