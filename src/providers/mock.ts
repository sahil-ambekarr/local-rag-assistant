import type { ChatProvider, ChatRequest, EmbedKind, EmbeddingProvider } from './types.js';

export const MOCK_DIMENSION = 256;
export const MOCK_MODELS = ['mock-small', 'mock-large'] as const;

const STOP_WORDS = new Set(
  'a an and are as at be by do does for from how i if in is it my of on or that the this to what when where which who with you your'.split(
    ' ',
  ),
);

/** FNV-1a: small, fast and stable across platforms, which is all a test double needs. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Deterministic bag-of-words embedding via feature hashing. Texts that share
 * words get a higher cosine similarity, so ranking tests are meaningful without
 * a model. It has no notion of synonyms: it is a test double, not a real embedder.
 */
export function mockEmbedding(text: string): number[] {
  const vector = new Array<number>(MOCK_DIMENSION).fill(0);
  for (const token of tokenize(text)) {
    const hash = fnv1a(token);
    vector[hash % MOCK_DIMENSION]! += hash & 0x100 ? 1 : -1;
  }
  return vector;
}

export class MockEmbeddings implements EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock-hash-256';

  async embed(texts: string[], _kind: EmbedKind): Promise<number[][]> {
    return texts.map(mockEmbedding);
  }
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const match = /^.*?[.!?](?=\s|$)/.exec(flat);
  return (match ? match[0] : flat).slice(0, 240);
}

/**
 * Canned chat: quotes the first sentence of the first context passage and cites
 * it as [1]. Same input always gives the same output.
 */
export class MockChat implements ChatProvider {
  readonly name = 'mock';
  readonly defaultModel = MOCK_MODELS[0];

  async listModels(): Promise<string[]> {
    return [...MOCK_MODELS];
  }

  async *streamChat(request: ChatRequest): AsyncIterable<string> {
    const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const passage = /\[1\][^\n]*\n([\s\S]*?)(?=\n\n\[2\]|\n\nQuestion:|$)/.exec(user)?.[1];
    const answer = passage
      ? `Mock answer (${request.model}): ${firstSentence(passage)} [1]`
      : `Mock answer (${request.model}): no context was provided.`;
    for (const piece of answer.match(/\S+\s*/g) ?? []) {
      if (request.signal?.aborted) return;
      yield piece;
    }
  }
}
