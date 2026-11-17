import { buildCitations, extractCitedNumbers, type Citation } from './citations.js';
import type { ChatMessage, ChatProvider, EmbeddingProvider } from './providers/types.js';
import type { ScoredChunk, VectorStore } from './vectorStore.js';

export const NO_CONTEXT_MESSAGE =
  'I could not find anything relevant in the ingested documents. Ingest a document that covers this topic and ask again.';

export const SYSTEM_PROMPT = [
  'You answer questions using only the numbered context passages supplied by the user.',
  'Rules:',
  '- Cite every claim with the passage number in square brackets, for example [1] or [2].',
  '- Use only passage numbers that appear in the context.',
  '- If the passages do not contain the answer, say you could not find it in the documents. Do not guess.',
  '- Keep the answer short: at most five sentences.',
].join('\n');

export interface RetrieveOptions {
  store: VectorStore;
  embedder: EmbeddingProvider;
  topK: number;
  /** Chunks scoring below this cosine similarity are dropped. */
  minScore?: number;
}

/** Embeds the question and returns the best-matching chunks, best first. */
export async function retrieve(question: string, opts: RetrieveOptions): Promise<ScoredChunk[]> {
  if (opts.store.countChunks() === 0) return [];
  const [embedding] = await opts.embedder.embed([question], 'query');
  if (!embedding) return [];
  const minScore = opts.minScore ?? -1;
  return opts.store.search(embedding, opts.topK).filter((chunk) => chunk.score >= minScore);
}

export function buildMessages(question: string, citations: Citation[]): ChatMessage[] {
  const context = citations.map((c) => `[${c.n}] (${c.label})\n${c.text}`).join('\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
  ];
}

export type RagEvent =
  | { type: 'sources'; citations: Citation[] }
  | { type: 'token'; text: string }
  | {
      type: 'done';
      answer: string;
      model: string;
      /** Citation numbers the answer referenced. */
      cited: number[];
      retrievalMs: number;
      generationMs: number;
    };

export interface AnswerOptions extends RetrieveOptions {
  chat: ChatProvider;
  model?: string;
  signal?: AbortSignal;
}

/**
 * The whole RAG turn as a stream of events: sources first (so the UI can show
 * them while the model is still thinking), then tokens, then a summary.
 */
export async function* answerQuestion(question: string, opts: AnswerOptions): AsyncGenerator<RagEvent> {
  const model = opts.model ?? opts.chat.defaultModel;
  const retrievalStart = performance.now();
  const citations = buildCitations(await retrieve(question, opts));
  const retrievalMs = Math.round(performance.now() - retrievalStart);
  yield { type: 'sources', citations };

  // Guardrail: with nothing retrieved the model would answer from its own memory.
  if (citations.length === 0) {
    yield { type: 'token', text: NO_CONTEXT_MESSAGE };
    yield { type: 'done', answer: NO_CONTEXT_MESSAGE, model, cited: [], retrievalMs, generationMs: 0 };
    return;
  }

  const generationStart = performance.now();
  let answer = '';
  for await (const text of opts.chat.streamChat({ model, messages: buildMessages(question, citations), signal: opts.signal })) {
    answer += text;
    yield { type: 'token', text };
  }
  yield {
    type: 'done',
    answer,
    model,
    cited: extractCitedNumbers(answer, citations.length),
    retrievalMs,
    generationMs: Math.round(performance.now() - generationStart),
  };
}
