import { describe, expect, it } from 'vitest';
import { chunkSections, parseMarkdownSections, splitText } from '../src/chunker.js';

const sentence = (i: number) => `Sentence number ${i} talks about something specific.`;

describe('splitText', () => {
  it('returns one chunk when the text fits', () => {
    expect(splitText('Short paragraph.', { chunkSize: 100, chunkOverlap: 10 })).toEqual(['Short paragraph.']);
  });

  it('never exceeds chunkSize', () => {
    const text = Array.from({ length: 60 }, (_, i) => sentence(i)).join(' ');
    const chunks = splitText(text, { chunkSize: 200, chunkOverlap: 40 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
  });

  it('repeats whole trailing sentences as overlap', () => {
    const text = Array.from({ length: 10 }, (_, i) => sentence(i)).join(' ');
    const chunks = splitText(text, { chunkSize: 160, chunkOverlap: 60 });
    for (let i = 1; i < chunks.length; i++) {
      const firstSentence = chunks[i]!.split(/(?<=\.)\s/)[0]!;
      expect(chunks[i - 1]).toContain(firstSentence);
    }
  });

  it('adds no overlap when chunkOverlap is 0', () => {
    const text = Array.from({ length: 10 }, (_, i) => sentence(i)).join(' ');
    const chunks = splitText(text, { chunkSize: 160, chunkOverlap: 0 });
    const all = chunks.join(' ');
    for (let i = 0; i < 10; i++) expect(all.split(sentence(i)).length - 1).toBe(1);
  });

  it('keeps paragraphs together when they fit', () => {
    const chunks = splitText('First para.\n\nSecond para.', { chunkSize: 100, chunkOverlap: 0 });
    expect(chunks).toEqual(['First para.\n\nSecond para.']);
  });

  it('hard-splits a single very long word', () => {
    const chunks = splitText('x'.repeat(250), { chunkSize: 100, chunkOverlap: 0 });
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it('rejects overlap >= size and non-positive size', () => {
    expect(() => splitText('a', { chunkSize: 100, chunkOverlap: 100 })).toThrow(RangeError);
    expect(() => splitText('a', { chunkSize: 0, chunkOverlap: 0 })).toThrow(RangeError);
    expect(() => splitText('a', { chunkSize: 10, chunkOverlap: -1 })).toThrow(RangeError);
  });

  it('returns nothing for blank text', () => {
    expect(splitText('  \n\n ', { chunkSize: 100, chunkOverlap: 0 })).toEqual([]);
  });
});

describe('parseMarkdownSections', () => {
  const md = [
    'Intro text before any heading.',
    '# Leave policy',
    'Overview.',
    '## Sick leave',
    'Ten days a year.',
    '### Evidence',
    'A note after three days.',
    '## Annual leave',
    'Twenty days.',
    '```',
    '# not a heading inside a fence',
    '```',
  ].join('\n');

  it('tracks the heading path', () => {
    const sections = parseMarkdownSections(md);
    expect(sections.map((s) => s.heading)).toEqual([
      undefined,
      'Leave policy',
      'Leave policy > Sick leave',
      'Leave policy > Sick leave > Evidence',
      'Leave policy > Annual leave',
    ]);
  });

  it('ignores headings inside fenced code blocks', () => {
    const last = parseMarkdownSections(md).at(-1)!;
    expect(last.text).toContain('# not a heading inside a fence');
  });

  it('handles CRLF line endings', () => {
    const sections = parseMarkdownSections('# A\r\nOne.\r\n# B\r\nTwo.');
    expect(sections).toEqual([
      { heading: 'A', text: 'One.' },
      { heading: 'B', text: 'Two.' },
    ]);
  });
});

describe('chunkSections', () => {
  it('never lets a chunk span two sections and numbers chunks globally', () => {
    const chunks = chunkSections(
      [
        { text: 'Alpha one. Alpha two.', heading: 'A' },
        { text: 'Page two text.', page: 2 },
      ],
      { chunkSize: 500, chunkOverlap: 0 },
    );
    expect(chunks).toEqual([
      { index: 0, text: 'Alpha one. Alpha two.', heading: 'A' },
      { index: 1, text: 'Page two text.', page: 2 },
    ]);
  });
});
