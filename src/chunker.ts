export interface ChunkOptions {
  /** Maximum chunk length in characters. */
  chunkSize: number;
  /** Characters of trailing context repeated at the start of the next chunk. */
  chunkOverlap: number;
}

/** A piece of a document that shares one heading path or one PDF page. */
export interface Section {
  text: string;
  heading?: string;
  page?: number;
}

export interface Chunk {
  index: number;
  text: string;
  heading?: string;
  page?: number;
}

interface Unit {
  text: string;
  /** Separator placed before this unit when it is not first in a chunk. */
  sep: string;
}

function validate(opts: ChunkOptions): void {
  if (!Number.isInteger(opts.chunkSize) || opts.chunkSize < 1) {
    throw new RangeError('chunkSize must be a positive integer');
  }
  if (!Number.isInteger(opts.chunkOverlap) || opts.chunkOverlap < 0 || opts.chunkOverlap >= opts.chunkSize) {
    throw new RangeError('chunkOverlap must be >= 0 and smaller than chunkSize');
  }
}

function hardSplit(text: string, size: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > size) {
      if (current) parts.push(current);
      current = '';
      for (let i = 0; i < word.length; i += size) parts.push(word.slice(i, i + size));
      continue;
    }
    if (current && current.length + 1 + word.length > size) {
      parts.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Breaks text into units no longer than `size`: paragraphs, then sentences, then words. */
function toUnits(text: string, size: number): Unit[] {
  const units: Unit[] = [];
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    if (paragraph.length <= size) {
      units.push({ text: paragraph, sep: '\n\n' });
      continue;
    }
    const sentences = paragraph.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter(Boolean);
    sentences.forEach((sentence, i) => {
      const pieces = sentence.length <= size ? [sentence] : hardSplit(sentence, size);
      pieces.forEach((piece, j) => units.push({ text: piece, sep: i === 0 && j === 0 ? '\n\n' : ' ' }));
    });
  }
  return units;
}

function join(units: Unit[]): string {
  return units.map((u, i) => (i === 0 ? u.text : u.sep + u.text)).join('');
}

/**
 * Greedy packing of paragraph/sentence units into chunks of at most `chunkSize`
 * characters. Overlap is taken in whole units from the end of the previous chunk,
 * so a chunk never starts mid-sentence.
 */
export function splitText(text: string, opts: ChunkOptions): string[] {
  validate(opts);
  const units = toUnits(text, opts.chunkSize);
  const chunks: string[] = [];
  let current: Unit[] = [];
  let fresh = 0; // units in `current` that are not carried-over overlap

  for (const unit of units) {
    if (current.length > 0 && join([...current, unit]).length > opts.chunkSize) {
      if (fresh > 0) chunks.push(join(current));
      const tail: Unit[] = [];
      for (let i = current.length - 1; i >= 0; i--) {
        const candidate = [current[i]!, ...tail];
        if (join(candidate).length > opts.chunkOverlap) break;
        if (join([...candidate, unit]).length > opts.chunkSize) break;
        tail.unshift(current[i]!);
      }
      current = tail;
      fresh = 0;
    }
    current.push(unit);
    fresh++;
  }
  if (fresh > 0) chunks.push(join(current));
  return chunks;
}

/**
 * Splits Markdown into sections at ATX headings (# .. ######). Each section keeps
 * its heading path ("Leave policy > Sick leave") so a chunk can be cited and
 * embedded with that context. Headings inside fenced code blocks are ignored.
 */
export function parseMarkdownSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) return;
    const heading = stack.map((h) => h.title).join(' > ');
    sections.push(heading ? { text, heading } : { text });
  };

  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      buffer.push(line);
      continue;
    }
    flush();
    const level = match[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, title: match[2]!.trim() });
  }
  flush();
  return sections;
}

/** Chunks each section independently so a chunk never spans two headings or two pages. */
export function chunkSections(sections: Section[], opts: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of sections) {
    for (const text of splitText(section.text, opts)) {
      const chunk: Chunk = { index: chunks.length, text };
      if (section.heading) chunk.heading = section.heading;
      if (section.page !== undefined) chunk.page = section.page;
      chunks.push(chunk);
    }
  }
  return chunks;
}
