import Anthropic from '@anthropic-ai/sdk';
import type { FetchLike } from '../http.js';
import { errorMessage } from '../logger.js';
import { ProviderError, type ChatProvider, type ChatRequest } from './types.js';

export interface ClaudeOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  /** Test seam: lets unit tests stub the HTTP layer instead of calling the live API. */
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

// Answers are short and grounded in a few passages, so a modest cap is deliberate.
const MAX_ANSWER_TOKENS = 4096;

/**
 * Chat through the official Anthropic SDK. Chat only: the Claude API has no
 * embeddings endpoint, so retrieval keeps using local Ollama embeddings.
 */
export class ClaudeChat implements ChatProvider {
  readonly name = 'claude';
  readonly defaultModel: string;
  private readonly client: Anthropic;

  constructor(opts: ClaudeOptions) {
    this.defaultModel = opts.model;
    // The SDK applies the timeout and retries 408/409/429/5xx and connection errors with backoff.
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
  }

  async listModels(): Promise<string[]> {
    const ids = new Set<string>([this.defaultModel]);
    try {
      for await (const model of this.client.models.list()) ids.add(model.id);
    } catch {
      // Listing is a convenience for the dropdown; the configured model still works.
    }
    return [...ids].sort();
  }

  async *streamChat(request: ChatRequest): AsyncIterable<string> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages: Anthropic.MessageParam[] = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    try {
      const stream = this.client.messages.stream(
        { model: request.model, max_tokens: MAX_ANSWER_TOKENS, ...(system ? { system } : {}), messages },
        { signal: request.signal },
      );
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') yield '\n\n[The model declined to answer this request.]';
      if (final.stop_reason === 'max_tokens') yield '\n\n[Answer cut off at the length limit.]';
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new ProviderError('Claude rejected the API key (check ANTHROPIC_API_KEY)', err);
      }
      if (err instanceof Anthropic.NotFoundError) {
        throw new ProviderError(`Claude model "${request.model}" was not found`, err);
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new ProviderError('Claude rate limit reached; try again shortly', err);
      }
      if (err instanceof Anthropic.APIError) {
        throw new ProviderError(`Claude API error: ${err.message}`, err);
      }
      throw new ProviderError(`Claude request failed: ${errorMessage(err)}`, err);
    }
  }
}
