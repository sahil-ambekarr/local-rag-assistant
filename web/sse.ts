export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Incremental parser for text/event-stream. EventSource only supports GET, and
 * /api/ask is a POST, so the browser reads the fetch() body and feeds it here.
 */
export class SseParser {
  private buffer = '';

  /** Adds a chunk of text and returns every message completed by it. */
  push(text: string): SseMessage[] {
    this.buffer += text.replace(/\r\n/g, '\n');
    const messages: SseMessage[] = [];
    let end: number;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length > 0) messages.push({ event, data: data.join('\n') });
    }
    return messages;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/**
 * Escapes the answer, then turns [1] and [1, 2] into buttons that jump to the
 * matching source. Numbers with no matching source stay as plain text.
 */
export function linkCitations(answer: string, sourceCount: number): string {
  return escapeHtml(answer).replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (whole, list: string) => {
    const numbers = list.split(',').map((n) => Number(n.trim()));
    if (numbers.some((n) => n < 1 || n > sourceCount)) return whole;
    return numbers.map((n) => `<button type="button" class="cite" data-n="${n}" title="Show source ${n}">${n}</button>`).join('');
  });
}
