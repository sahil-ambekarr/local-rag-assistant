import { fetchWithTimeout, withRetry, type FetchLike } from '../http.js';
import { errorMessage, silentLogger, type Logger } from '../logger.js';
import {
  ProviderError,
  type ChatProvider,
  type ChatRequest,
  type EmbedKind,
  type EmbeddingProvider,
} from './types.js';

export interface OllamaOptions {
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  chatTimeoutMs: number;
  embedTimeoutMs: number;
  maxRetries: number;
  fetchImpl?: FetchLike;
  logger?: Logger;
  retryBaseDelayMs?: number;
}

interface OllamaTag {
  name: string;
  capabilities?: string[];
  /** Set for Ollama cloud models, which run on a remote host rather than this machine. */
  remote_host?: string;
}

const EMBED_BATCH_SIZE = 16;

// nomic-embed-text is trained with task prefixes; using them for documents vs
// queries is what its model card recommends for retrieval.
const NOMIC_PREFIX: Record<EmbedKind, string> = {
  document: 'search_document: ',
  query: 'search_query: ',
};

async function listTags(opts: OllamaOptions): Promise<OllamaTag[]> {
  const res = await withRetry(
    () => fetchWithTimeout(`${opts.baseUrl}/api/tags`, { method: 'GET' }, { timeoutMs: 15_000, fetchImpl: opts.fetchImpl }),
    { retries: opts.maxRetries, baseDelayMs: opts.retryBaseDelayMs },
  );
  const body = (await res.json()) as { models?: OllamaTag[] };
  return body.models ?? [];
}

/** Local, text-generating models only: the point of this app is that documents stay on the machine. */
function isChatModel(tag: OllamaTag): boolean {
  if (tag.remote_host) return false;
  if (tag.capabilities) return tag.capabilities.includes('completion');
  return !/embed/i.test(tag.name); // older Ollama versions do not report capabilities
}

export class OllamaChat implements ChatProvider {
  readonly name = 'ollama';
  readonly defaultModel: string;
  private readonly logger: Logger;

  constructor(private readonly opts: OllamaOptions) {
    this.defaultModel = opts.chatModel;
    this.logger = opts.logger ?? silentLogger;
  }

  async listModels(): Promise<string[]> {
    try {
      const tags = await listTags(this.opts);
      return tags.filter(isChatModel).map((t) => t.name.replace(/:latest$/, '')).sort();
    } catch (err) {
      throw new ProviderError(`Could not list Ollama models at ${this.opts.baseUrl}: ${errorMessage(err)}`, err);
    }
  }

  async *streamChat(request: ChatRequest): AsyncIterable<string> {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: true,
      options: { temperature: 0.1 },
    });
    let res: Response;
    try {
      // Only the connection attempt is retried; once tokens flow, a failure is surfaced.
      res = await withRetry(
        () =>
          fetchWithTimeout(
            `${this.opts.baseUrl}/api/chat`,
            { method: 'POST', headers: { 'content-type': 'application/json' }, body },
            { timeoutMs: this.opts.chatTimeoutMs, signal: request.signal, fetchImpl: this.opts.fetchImpl },
          ),
        {
          retries: this.opts.maxRetries,
          baseDelayMs: this.opts.retryBaseDelayMs,
          onRetry: (attempt, err) => this.logger.warn('ollama.chat.retry', { attempt, error: errorMessage(err) }),
        },
      );
    } catch (err) {
      throw new ProviderError(`Ollama chat request failed: ${errorMessage(err)}`, err);
    }
    if (!res.body) throw new ProviderError('Ollama returned an empty response body');

    // Ollama streams newline-delimited JSON objects.
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for await (const bytes of res.body) {
        buffered += decoder.decode(bytes, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as { message?: { content?: string }; error?: string };
          if (event.error) throw new ProviderError(`Ollama error: ${event.error}`);
          if (event.message?.content) yield event.message.content;
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`Ollama stream interrupted: ${errorMessage(err)}`, err);
    }
  }
}

export class OllamaEmbeddings implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly model: string;
  private resolvedModel: string | undefined;
  private readonly logger: Logger;

  constructor(private readonly opts: OllamaOptions) {
    this.model = opts.embedModel;
    this.logger = opts.logger ?? silentLogger;
  }

  /**
   * Maps the configured name onto an installed tag. `nomic-embed-text` matches
   * `nomic-embed-text:latest` and also a quantisation tag such as
   * `nomic-embed-text:137m-v1.5-fp16` when no `:latest` tag exists.
   */
  private async resolveModel(): Promise<string> {
    if (this.resolvedModel) return this.resolvedModel;
    const wanted = this.opts.embedModel;
    let resolved = wanted;
    try {
      const names = (await listTags(this.opts)).map((t) => t.name);
      if (!names.includes(wanted) && !names.includes(`${wanted}:latest`) && !wanted.includes(':')) {
        resolved = names.find((n) => n.startsWith(`${wanted}:`)) ?? wanted;
      }
    } catch (err) {
      this.logger.warn('ollama.embed.resolve_failed', { error: errorMessage(err) });
    }
    this.resolvedModel = resolved;
    return resolved;
  }

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    if (texts.length === 0) return [];
    const model = await this.resolveModel();
    const prefix = /nomic-embed/i.test(model) ? NOMIC_PREFIX[kind] : '';
    const vectors: number[][] = [];

    // Batches go out one after another: the Ollama instance is CPU-only and shared.
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const input = texts.slice(start, start + EMBED_BATCH_SIZE).map((t) => prefix + t);
      try {
        const res = await withRetry(
          () =>
            fetchWithTimeout(
              `${this.opts.baseUrl}/api/embed`,
              { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input }) },
              { timeoutMs: this.opts.embedTimeoutMs, fetchImpl: this.opts.fetchImpl },
            ),
          {
            retries: this.opts.maxRetries,
            baseDelayMs: this.opts.retryBaseDelayMs,
            onRetry: (attempt, err) => this.logger.warn('ollama.embed.retry', { attempt, error: errorMessage(err) }),
          },
        );
        const body = (await res.json()) as { embeddings?: number[][] };
        if (!body.embeddings || body.embeddings.length !== input.length) {
          throw new ProviderError(`Ollama returned ${body.embeddings?.length ?? 0} embeddings for ${input.length} inputs`);
        }
        vectors.push(...body.embeddings);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(`Ollama embedding request failed (model ${model}): ${errorMessage(err)}`, err);
      }
    }
    return vectors;
  }
}
