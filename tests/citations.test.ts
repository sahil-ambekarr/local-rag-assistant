import { describe, expect, it } from 'vitest';
import { buildCitations, extractCitedNumbers, formatCitationLabel, formatSourcesList } from '../src/citations.js';
import type { ScoredChunk } from '../src/vectorStore.js';

const chunk = (over: Partial<ScoredChunk>): ScoredChunk => ({
  id: 1,
  documentId: 1,
  source: 'doc.md',
  chunkIndex: 0,
  text: 'text',
  score: 0.5,
  ...over,
});

describe('formatCitationLabel', () => {
  it('shows the heading path and a 1-based chunk number for Markdown', () => {
    expect(formatCitationLabel(chunk({ source: 'expense-policy.md', heading: 'Travel > Flights', chunkIndex: 2 }))).toBe(
      'expense-policy.md > Travel > Flights (chunk 3)',
    );
  });

  it('shows the page for PDFs', () => {
    expect(formatCitationLabel(chunk({ source: 'handbook.pdf', page: 2, chunkIndex: 3 }))).toBe('handbook.pdf, p. 2 (chunk 4)');
  });

  it('shows only the file and chunk for plain text', () => {
    expect(formatCitationLabel(chunk({ source: 'notes.txt' }))).toBe('notes.txt (chunk 1)');
  });
});

describe('buildCitations', () => {
  it('numbers citations from 1 in retrieval order and rounds the score', () => {
    const citations = buildCitations([chunk({ id: 7, score: 0.123456 }), chunk({ id: 3, page: 1, score: 0.1 })]);
    expect(citations.map((c) => [c.n, c.chunkId])).toEqual([
      [1, 7],
      [2, 3],
    ]);
    expect(citations[0]!.score).toBe(0.1235);
    expect(citations[1]!.page).toBe(1);
    expect(citations[0]).not.toHaveProperty('page');
  });
});

describe('extractCitedNumbers', () => {
  it('collects [n], [n, m] and [n][m] in order of first use without duplicates', () => {
    expect(extractCitedNumbers('A [2]. B [1, 3]. C [2][4].', 4)).toEqual([2, 1, 3, 4]);
  });

  it('drops numbers outside 1..max', () => {
    expect(extractCitedNumbers('A [0] B [5] C [1]', 4)).toEqual([1]);
  });

  it('ignores non-numeric brackets', () => {
    expect(extractCitedNumbers('see [note] and [a, 1]', 3)).toEqual([]);
  });
});

describe('formatSourcesList', () => {
  it('renders one line per source', () => {
    const list = formatSourcesList(buildCitations([chunk({ source: 'a.md', score: 0.8771 })]));
    expect(list).toBe('[1] a.md (chunk 1)  (score 0.877)');
  });
});
