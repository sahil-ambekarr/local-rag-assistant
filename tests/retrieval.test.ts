import { afterEach, describe, expect, it } from 'vitest';
import { embeddingInput, ingestBuffer } from '../src/ingest.js';
import { MockChat, MockEmbeddings } from '../src/providers/mock.js';
import type { ChatProvider, ChatRequest, EmbeddingProvider } from '../src/providers/types.js';
import { answerQuestion, buildMessages, NO_CONTEXT_MESSAGE, retrieve, type RagEvent } from '../src/rag.js';
import { VectorStore } from '../src/vectorStore.js';
import { buildCitations } from '../src/citations.js';

const chunking = { chunkSize: 400, chunkOverlap: 0 };
let store: VectorStore;
afterEach(() => store?.close());

async function seeded(): Promise<{ store: VectorStore; embedder: EmbeddingProvider }> {
  store = new VectorStore(':memory:');
  const embedder = new MockEmbeddings();
  const deps = { store, embedder, chunking };
  await ingestBuffer(
    'leave.md',
    Buffer.from('# Leave\n## Sick leave\nEmployees get ten sick days per calendar year.\n## Parental leave\nParents get sixteen weeks of paid parental leave.'),
    deps,
  );
  await ingestBuffer('expenses.txt', Buffer.from('Hotel bookings are reimbursed up to a nightly cap. Receipts are required for every expense claim.'), deps);
  return { store, embedder };
}

async function collect(events: AsyncIterable<RagEvent>): Promise<RagEvent[]> {
  const out: RagEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('retrieve', () => {
  it('ranks the chunk sharing the most terms first', async () => {
    const deps = await seeded();
    const results = await retrieve('how many weeks of parental leave do parents get', { ...deps, topK: 3 });
    expect(results[0]).toMatchObject({ source: 'leave.md', heading: 'Leave > Parental leave' });
    expect(results.map((r) => r.score)).toEqual([...results.map((r) => r.score)].sort((a, b) => b - a));

    const expense = await retrieve('are receipts required for an expense claim', { ...deps, topK: 1 });
    expect(expense[0]!.source).toBe('expenses.txt');
  });

  it('drops chunks below minScore and returns [] for an empty store', async () => {
    const deps = await seeded();
    expect(await retrieve('parental leave weeks', { ...deps, topK: 5, minScore: 0.99 })).toEqual([]);
    const empty = new VectorStore(':memory:');
    expect(await retrieve('anything', { store: empty, embedder: deps.embedder, topK: 3 })).toEqual([]);
    empty.close();
  });

  it('skips re-embedding an unchanged file', async () => {
    const deps = await seeded();
    let calls = 0;
    const counting: EmbeddingProvider = {
      name: 'mock',
      model: deps.embedder.model,
      embed: async (texts, kind) => {
        calls++;
        return deps.embedder.embed(texts, kind);
      },
    };
    const again = await ingestBuffer('expenses.txt', Buffer.from('Hotel bookings are reimbursed up to a nightly cap. Receipts are required for every expense claim.'), { store: deps.store, embedder: counting, chunking });
    expect(again.skipped).toBe(true);
    expect(calls).toBe(0);
  });
});

describe('embeddingInput', () => {
  it('prefixes the file title and heading path', () => {
    expect(embeddingInput('it-onboarding_guide.md', { text: 'Body', heading: 'Laptop > Setup' })).toBe(
      'it onboarding guide - Laptop > Setup\nBody',
    );
    expect(embeddingInput('notes.txt', { text: 'Body' })).toBe('notes\nBody');
  });
});

describe('answerQuestion', () => {
  it('emits sources, then tokens, then done with the cited numbers', async () => {
    const deps = await seeded();
    const events = await collect(answerQuestion('parental leave weeks', { ...deps, chat: new MockChat(), topK: 2 }));
    expect(events[0]!.type).toBe('sources');
    expect(events.at(-1)!.type).toBe('done');
    const tokens = events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
    const done = events.at(-1) as Extract<RagEvent, { type: 'done' }>;
    expect(done.answer).toBe(tokens);
    expect(done.answer).toContain('sixteen weeks');
    expect(done.cited).toEqual([1]);
    expect(done.model).toBe('mock-small');
  });

  it('does not call the model when nothing was retrieved', async () => {
    store = new VectorStore(':memory:');
    const chat: ChatProvider = {
      name: 'spy',
      defaultModel: 'spy',
      listModels: async () => [],
      // eslint-disable-next-line require-yield
      streamChat: async function* () {
        throw new Error('model must not be called');
      },
    };
    const events = await collect(answerQuestion('anything', { store, embedder: new MockEmbeddings(), chat, topK: 3 }));
    expect(events.map((e) => e.type)).toEqual(['sources', 'token', 'done']);
    expect((events[2] as Extract<RagEvent, { type: 'done' }>).answer).toBe(NO_CONTEXT_MESSAGE);
  });

  it('passes the chosen model and the numbered context to the provider', async () => {
    const deps = await seeded();
    let seen: ChatRequest | undefined;
    const chat: ChatProvider = {
      name: 'spy',
      defaultModel: 'default-model',
      listModels: async () => [],
      streamChat: async function* (req) {
        seen = req;
        yield 'ok [2] [9]';
      },
    };
    const events = await collect(answerQuestion('sick days', { ...deps, chat, topK: 2, model: 'picked-model' }));
    expect(seen!.model).toBe('picked-model');
    expect(seen!.messages[1]!.content).toMatch(/^Context:\n\[1\] \(/);
    expect(seen!.messages[1]!.content).toContain('[2] (');
    // [9] is not a real passage and must be dropped.
    expect((events.at(-1) as Extract<RagEvent, { type: 'done' }>).cited).toEqual([2]);
  });
});

describe('buildMessages', () => {
  it('puts the rules in the system prompt and the labelled passages in the user turn', () => {
    const citations = buildCitations([
      { id: 1, documentId: 1, source: 'a.md', chunkIndex: 0, text: 'Alpha.', heading: 'H', score: 0.9 },
    ]);
    const [system, user] = buildMessages('Q?', citations);
    expect(system!.role).toBe('system');
    expect(system!.content).toContain('square brackets');
    expect(user!.content).toBe('Context:\n[1] (a.md > H (chunk 1))\nAlpha.\n\nQuestion: Q?');
  });
});
