import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dot, EmbeddingMismatchError, normalize, VectorStore } from '../src/vectorStore.js';

const stores: VectorStore[] = [];
function memoryStore(): VectorStore {
  const store = new VectorStore(':memory:');
  stores.push(store);
  return store;
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

const doc = (source: string, sha = 'abc') => ({ source, type: 'markdown', sha256: sha });

describe('normalize / dot', () => {
  it('gives cosine similarity of 1 for parallel vectors and 0 for orthogonal ones', () => {
    expect(dot(normalize([2, 0]), normalize([5, 0]))).toBeCloseTo(1);
    expect(dot(normalize([1, 0]), normalize([0, 3]))).toBeCloseTo(0);
  });

  it('leaves a zero vector at zero instead of producing NaN', () => {
    expect([...normalize([0, 0, 0])]).toEqual([0, 0, 0]);
  });
});

describe('VectorStore', () => {
  it('stores documents and ranks chunks by cosine similarity', () => {
    const store = memoryStore();
    store.upsertDocument(
      doc('a.md'),
      [
        { text: 'east', embedding: [1, 0, 0] },
        { text: 'north-east', embedding: [1, 1, 0] },
        { text: 'up', embedding: [0, 0, 1] },
      ],
      'test-model',
    );
    const results = store.search([1, 0.1, 0], 3);
    expect(results.map((r) => r.text)).toEqual(['east', 'north-east', 'up']);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    expect(results[0]).toMatchObject({ source: 'a.md', chunkIndex: 0 });
  });

  it('respects k and returns nothing for an empty store', () => {
    const store = memoryStore();
    expect(store.search([1, 0], 3)).toEqual([]);
    store.upsertDocument(doc('a.md'), [{ text: 'x', embedding: [1, 0] }, { text: 'y', embedding: [0, 1] }], 'm');
    expect(store.search([1, 0], 1)).toHaveLength(1);
  });

  it('keeps heading and page metadata', () => {
    const store = memoryStore();
    store.upsertDocument(doc('h.pdf'), [{ text: 'x', embedding: [1, 0], heading: 'H', page: 3 }], 'm');
    expect(store.search([1, 0], 1)[0]).toMatchObject({ heading: 'H', page: 3 });
  });

  it('replaces an earlier version of the same source', () => {
    const store = memoryStore();
    store.upsertDocument(doc('a.md', 'v1'), [{ text: 'old', embedding: [1, 0] }], 'm');
    store.upsertDocument(doc('a.md', 'v2'), [{ text: 'new', embedding: [1, 0] }, { text: 'new2', embedding: [0, 1] }], 'm');
    expect(store.listDocuments()).toHaveLength(1);
    expect(store.findBySource('a.md')).toMatchObject({ sha256: 'v2', chunkCount: 2 });
    expect(store.countChunks()).toBe(2);
  });

  it('deletes a document and its chunks', () => {
    const store = memoryStore();
    const record = store.upsertDocument(doc('a.md'), [{ text: 'x', embedding: [1, 0] }], 'm');
    expect(store.deleteDocument(record.id)).toBe(true);
    expect(store.countChunks()).toBe(0);
    expect(store.deleteDocument(record.id)).toBe(false);
  });

  it('refuses vectors from a different model or dimension', () => {
    const store = memoryStore();
    store.upsertDocument(doc('a.md'), [{ text: 'x', embedding: [1, 0] }], 'model-a');
    expect(() => store.upsertDocument(doc('b.md'), [{ text: 'y', embedding: [1, 0] }], 'model-b')).toThrow(
      EmbeddingMismatchError,
    );
    expect(() => store.upsertDocument(doc('b.md'), [{ text: 'y', embedding: [1, 0, 0] }], 'model-a')).toThrow(
      EmbeddingMismatchError,
    );
    expect(() => store.search([1, 0, 0], 1)).toThrow(EmbeddingMismatchError);
    // A failed insert must not leave the store half-written.
    expect(store.listDocuments().map((d) => d.source)).toEqual(['a.md']);
  });

  it('rejects empty chunk lists and ragged embeddings', () => {
    const store = memoryStore();
    expect(() => store.upsertDocument(doc('a.md'), [], 'm')).toThrow(/zero chunks/);
    expect(() =>
      store.upsertDocument(doc('a.md'), [{ text: 'x', embedding: [1, 0] }, { text: 'y', embedding: [1] }], 'm'),
    ).toThrow(EmbeddingMismatchError);
  });

  it('persists to a file and reopens', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-store-'));
    const file = path.join(dir, 'nested', 'rag.db');
    const first = new VectorStore(file);
    first.upsertDocument(doc('a.md'), [{ text: 'kept', embedding: [0.3, 0.4] }], 'm');
    first.close();
    const second = new VectorStore(file);
    expect(second.embeddingInfo()).toEqual({ model: 'm', dimension: 2 });
    expect(second.search([0.3, 0.4], 1)[0]!.score).toBeCloseTo(1, 5);
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
