import { describe, expect, it } from 'vitest';
import { escapeHtml, linkCitations, SseParser } from '../web/sse.js';

describe('SseParser', () => {
  it('handles frames split across chunks', () => {
    const parser = new SseParser();
    expect(parser.push('event: token\ndata: {"te')).toEqual([]);
    expect(parser.push('xt":"hi"}\n\nevent: done\ndata: {}\n\n')).toEqual([
      { event: 'token', data: '{"text":"hi"}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('accepts CRLF and joins multi-line data', () => {
    expect(new SseParser().push('data: a\r\ndata: b\r\n\r\n')).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
});

describe('linkCitations', () => {
  it('turns valid citation markers into buttons', () => {
    expect(linkCitations('Ten days [1].', 2)).toBe(
      'Ten days <button type="button" class="cite" data-n="1" title="Show source 1">1</button>.',
    );
    expect(linkCitations('Both [1, 2]', 2).match(/class="cite"/g)).toHaveLength(2);
  });

  it('leaves out-of-range numbers as text and escapes HTML', () => {
    expect(linkCitations('<b>x</b> [3]', 2)).toBe('&lt;b&gt;x&lt;/b&gt; [3]');
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });
});
