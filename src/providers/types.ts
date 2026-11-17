export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Aborts generation, e.g. when the browser closes the stream. */
  signal?: AbortSignal;
}

export interface ChatProvider {
  readonly name: string;
  readonly defaultModel: string;
  /** Chat-capable model names the user can switch between. */
  listModels(): Promise<string[]>;
  /** Yields the answer as text fragments in generation order. */
  streamChat(request: ChatRequest): AsyncIterable<string>;
}

/** Whether a text is being stored (document) or used to search (query). */
export type EmbedKind = 'document' | 'query';

export interface EmbeddingProvider {
  readonly name: string;
  /** Identifier stored next to the vectors so different models are never mixed. */
  readonly model: string;
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
