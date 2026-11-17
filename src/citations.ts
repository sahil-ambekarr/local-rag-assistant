import type { ScoredChunk } from './vectorStore.js';

export interface Citation {
  /** 1-based number the model uses in the answer, e.g. [2]. */
  n: number;
  chunkId: number;
  source: string;
  chunkIndex: number;
  heading?: string;
  page?: number;
  score: number;
  text: string;
  label: string;
}

/**
 * Human-readable location of a chunk:
 *   "expense-policy.md > Travel > Flights (chunk 3)"
 *   "security-handbook.pdf, p. 2 (chunk 4)"
 * Chunk numbers are shown 1-based.
 */
export function formatCitationLabel(chunk: Pick<ScoredChunk, 'source' | 'chunkIndex' | 'heading' | 'page'>): string {
  let label = chunk.source;
  if (chunk.page !== undefined) label += `, p. ${chunk.page}`;
  if (chunk.heading) label += ` > ${chunk.heading}`;
  return `${label} (chunk ${chunk.chunkIndex + 1})`;
}

export function buildCitations(chunks: ScoredChunk[]): Citation[] {
  return chunks.map((chunk, i) => {
    const citation: Citation = {
      n: i + 1,
      chunkId: chunk.id,
      source: chunk.source,
      chunkIndex: chunk.chunkIndex,
      score: Number(chunk.score.toFixed(4)),
      text: chunk.text,
      label: formatCitationLabel(chunk),
    };
    if (chunk.heading) citation.heading = chunk.heading;
    if (chunk.page !== undefined) citation.page = chunk.page;
    return citation;
  });
}

/**
 * Citation numbers the answer actually uses, in order of first appearance.
 * Accepts [1], [1, 3] and [1][2]; numbers outside 1..max are dropped because
 * small models sometimes invent a source that was never provided.
 */
export function extractCitedNumbers(answer: string, max: number): number[] {
  const seen = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of match[1]!.split(',')) {
      const n = Number(part.trim());
      if (n >= 1 && n <= max) seen.add(n);
    }
  }
  return [...seen];
}

/** Plain-text source list for the CLI. */
export function formatSourcesList(citations: Citation[]): string {
  return citations.map((c) => `[${c.n}] ${c.label}  (score ${c.score.toFixed(3)})`).join('\n');
}
