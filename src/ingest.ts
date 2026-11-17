import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkSections, type Chunk, type ChunkOptions } from './chunker.js';
import { loadDocument, SUPPORTED_EXTENSIONS } from './loaders.js';
import { silentLogger, type Logger } from './logger.js';
import type { EmbeddingProvider } from './providers/types.js';
import type { DocumentRecord, VectorStore } from './vectorStore.js';

export interface IngestDeps {
  store: VectorStore;
  embedder: EmbeddingProvider;
  chunking: ChunkOptions;
  logger?: Logger;
}

export interface IngestResult {
  document: DocumentRecord;
  /** True when the same bytes were already stored and embedding was skipped. */
  skipped: boolean;
  ms: number;
}

/**
 * Text sent to the embedding model. The file name and heading path are prepended
 * so a short chunk such as a single table row still carries its topic.
 */
export function embeddingInput(source: string, chunk: Pick<Chunk, 'text' | 'heading'>): string {
  const title = path.basename(source, path.extname(source)).replace(/[-_]+/g, ' ');
  const context = chunk.heading ? `${title} - ${chunk.heading}` : title;
  return `${context}\n${chunk.text}`;
}

/** Load -> chunk -> embed -> store for one file held in memory. */
export async function ingestBuffer(source: string, data: Buffer, deps: IngestDeps): Promise<IngestResult> {
  const logger = deps.logger ?? silentLogger;
  const started = performance.now();
  const sha256 = createHash('sha256').update(data).digest('hex');

  const existing = deps.store.findBySource(source);
  if (existing && existing.sha256 === sha256 && deps.store.embeddingInfo()?.model === deps.embedder.model) {
    logger.info('ingest.skipped', { source, reason: 'unchanged' });
    return { document: existing, skipped: true, ms: Math.round(performance.now() - started) };
  }

  const loaded = await loadDocument(source, data);
  const chunks = chunkSections(loaded.sections, deps.chunking);
  const embeddings = await deps.embedder.embed(
    chunks.map((chunk) => embeddingInput(source, chunk)),
    'document',
  );
  const document = deps.store.upsertDocument(
    { source, type: loaded.type, sha256 },
    chunks.map((chunk, i) => ({ text: chunk.text, heading: chunk.heading, page: chunk.page, embedding: embeddings[i]! })),
    deps.embedder.model,
  );
  const ms = Math.round(performance.now() - started);
  logger.info('ingest.done', { source, chunks: chunks.length, ms });
  return { document, skipped: false, ms };
}

/** Supported files under a path (a single file, or a directory walked recursively), sorted. */
export async function findDocuments(target: string): Promise<string[]> {
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];
  const entries = await fs.readdir(target, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && (SUPPORTED_EXTENSIONS as readonly string[]).includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

/** Ingests files one at a time; the document name stored is the file's base name. */
export async function ingestPath(target: string, deps: IngestDeps): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const file of await findDocuments(target)) {
    results.push(await ingestBuffer(path.basename(file), await fs.readFile(file), deps));
  }
  return results;
}
