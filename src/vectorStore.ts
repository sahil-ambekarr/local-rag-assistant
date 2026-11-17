import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface NewChunk {
  text: string;
  heading?: string;
  page?: number;
  embedding: number[];
}

export interface DocumentRecord {
  id: number;
  source: string;
  type: string;
  sha256: string;
  chunkCount: number;
  ingestedAt: string;
}

export interface StoredChunk {
  id: number;
  documentId: number;
  source: string;
  chunkIndex: number;
  text: string;
  heading?: string;
  page?: number;
}

export interface ScoredChunk extends StoredChunk {
  score: number;
}

export class EmbeddingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingMismatchError';
  }
}

interface ChunkRow {
  id: number;
  document_id: number;
  source: string;
  chunk_index: number;
  text: string;
  heading: string | null;
  page: number | null;
}

/** Scales a vector to unit length so cosine similarity becomes a plain dot product. */
export function normalize(vector: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vector.length);
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return out;
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function fromBlob(blob: Buffer): Float32Array {
  // Copy: a Buffer's byteOffset is not guaranteed to be 4-byte aligned.
  return new Float32Array(new Uint8Array(blob).buffer);
}

function toChunk(row: ChunkRow): StoredChunk {
  const chunk: StoredChunk = {
    id: row.id,
    documentId: row.document_id,
    source: row.source,
    chunkIndex: row.chunk_index,
    text: row.text,
  };
  if (row.heading) chunk.heading = row.heading;
  if (row.page !== null) chunk.page = row.page;
  return chunk;
}

/**
 * SQLite-backed vector store. Embeddings are stored as unit-length Float32 BLOBs
 * and searched by brute force: every vector is scored against the query.
 */
export class VectorStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        ingested_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        heading TEXT,
        page INTEGER,
        embedding BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  private getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** The embedding model and dimension the stored vectors were made with, if any. */
  embeddingInfo(): { model: string; dimension: number } | undefined {
    const model = this.getMeta('embedding_model');
    const dimension = this.getMeta('embedding_dim');
    return model && dimension ? { model, dimension: Number(dimension) } : undefined;
  }

  countChunks(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  }

  findBySource(source: string): DocumentRecord | undefined {
    return this.listDocuments().find((doc) => doc.source === source);
  }

  listDocuments(): DocumentRecord[] {
    const rows = this.db
      .prepare('SELECT id, source, type, sha256, chunk_count, ingested_at FROM documents ORDER BY source')
      .all() as { id: number; source: string; type: string; sha256: string; chunk_count: number; ingested_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      type: r.type,
      sha256: r.sha256,
      chunkCount: r.chunk_count,
      ingestedAt: r.ingested_at,
    }));
  }

  /**
   * Inserts a document and its chunks in one transaction, replacing any earlier
   * version with the same source name. Vectors from a different embedding model
   * are refused: mixing them would make similarity scores meaningless.
   */
  upsertDocument(
    doc: { source: string; type: string; sha256: string },
    chunks: NewChunk[],
    embeddingModel: string,
  ): DocumentRecord {
    if (chunks.length === 0) throw new Error(`Refusing to store "${doc.source}" with zero chunks`);
    const dimension = chunks[0]!.embedding.length;
    if (dimension === 0 || chunks.some((c) => c.embedding.length !== dimension)) {
      throw new EmbeddingMismatchError('All chunk embeddings must share one non-zero dimension');
    }

    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM documents WHERE source = ?').run(doc.source);
      const existing = this.embeddingInfo();
      if (existing && this.countChunks() > 0 && (existing.model !== embeddingModel || existing.dimension !== dimension)) {
        throw new EmbeddingMismatchError(
          `Store holds ${existing.model} vectors (${existing.dimension} dims) but got ${embeddingModel} (${dimension} dims). ` +
            'Delete the database file or point DB_PATH at a new one, then re-ingest.',
        );
      }
      this.setMeta('embedding_model', embeddingModel);
      this.setMeta('embedding_dim', String(dimension));

      const ingestedAt = new Date().toISOString();
      const info = this.db
        .prepare('INSERT INTO documents (source, type, sha256, chunk_count, ingested_at) VALUES (?, ?, ?, ?, ?)')
        .run(doc.source, doc.type, doc.sha256, chunks.length, ingestedAt);
      const documentId = Number(info.lastInsertRowid);
      const insert = this.db.prepare(
        'INSERT INTO chunks (document_id, chunk_index, text, heading, page, embedding) VALUES (?, ?, ?, ?, ?, ?)',
      );
      chunks.forEach((chunk, i) => {
        insert.run(documentId, i, chunk.text, chunk.heading ?? null, chunk.page ?? null, toBlob(normalize(chunk.embedding)));
      });
      return { id: documentId, ...doc, chunkCount: chunks.length, ingestedAt };
    });
    return run();
  }

  deleteDocument(id: number): boolean {
    return this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0;
  }

  getChunk(id: number): StoredChunk | undefined {
    const row = this.db
      .prepare(
        `SELECT c.id, c.document_id, d.source, c.chunk_index, c.text, c.heading, c.page
         FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?`,
      )
      .get(id) as ChunkRow | undefined;
    return row ? toChunk(row) : undefined;
  }

  /** Top-k chunks by cosine similarity, best first. Ties break on chunk id for stable output. */
  search(queryEmbedding: ArrayLike<number>, k: number): ScoredChunk[] {
    const info = this.embeddingInfo();
    if (!info || this.countChunks() === 0) return [];
    if (queryEmbedding.length !== info.dimension) {
      throw new EmbeddingMismatchError(
        `Query embedding has ${queryEmbedding.length} dims but the store holds ${info.dimension}-dim ${info.model} vectors`,
      );
    }
    const query = normalize(queryEmbedding);
    const scored: { id: number; score: number }[] = [];
    const rows = this.db.prepare('SELECT id, embedding FROM chunks').iterate() as IterableIterator<{
      id: number;
      embedding: Buffer;
    }>;
    for (const row of rows) scored.push({ id: row.id, score: dot(query, fromBlob(row.embedding)) });
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    return scored.slice(0, Math.max(0, k)).map(({ id, score }) => ({ ...this.getChunk(id)!, score }));
  }

  close(): void {
    this.db.close();
  }
}
