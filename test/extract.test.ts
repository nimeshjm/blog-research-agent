import { describe, expect, it } from 'vitest';
import { extractArticleText } from '../src/lib/extract';

function html(body: string): Response {
  return new Response(`<html><head><title>t</title></head><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html' },
  });
}

describe('extractArticleText()', () => {
  it('extracts paragraph text from the body', async () => {
    const result = await extractArticleText(html('<p>Hello world.</p><p>Second paragraph.</p>'));
    expect(result).toContain('Hello world.');
    expect(result).toContain('Second paragraph.');
  });

  it('drops script, style, nav, header, and footer content entirely', async () => {
    const result = await extractArticleText(
      html(
        '<header>Site header</header><nav>Home About</nav>' +
          '<script>var secret = "leak";</script><style>.x{color:red}</style>' +
          '<p>Real article content.</p>' +
          '<footer>Copyright 2026</footer>',
      ),
    );
    expect(result).toBe('Real article content.');
    expect(result).not.toContain('Site header');
    expect(result).not.toContain('Home About');
    expect(result).not.toContain('secret');
    expect(result).not.toContain('color:red');
    expect(result).not.toContain('Copyright');
  });

  it('inserts a separating space between adjacent elements so words do not jam together', async () => {
    const result = await extractArticleText(html('<p>First sentence.</p><p>Second sentence.</p>'));
    expect(result).not.toContain('sentence.Second');
    expect(result).toContain('sentence. Second');
  });

  it('returns an empty string for a body with no matching content', async () => {
    const result = await extractArticleText(html('<script>only script content</script>'));
    expect(result).toBe('');
  });

  it('returns an empty string when there is no body at all', async () => {
    const result = await extractArticleText(new Response('<html><head><title>t</title></head></html>'));
    expect(result).toBe('');
  });

  it('truncates at the given cap, streaming - never grows past it', async () => {
    const paragraphs = Array.from({ length: 50 }, () => `<p>${'word '.repeat(20).trim()}</p>`).join('');
    const result = await extractArticleText(html(paragraphs), 50);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('nested elements inside an excluded tag do not leak text (e.g. a <div> inside <nav>)', async () => {
    const result = await extractArticleText(html('<nav><div><span>buried nav text</span></div></nav><p>Article text.</p>'));
    expect(result).toBe('Article text.');
  });
});
