import { ConfigError, type AppConfig } from '../config.js';
import type { FetchLike } from '../http.js';
import type { Logger } from '../logger.js';
import { ClaudeChat } from './claude.js';
import { MockChat, MockEmbeddings } from './mock.js';
import { OllamaChat, OllamaEmbeddings, type OllamaOptions } from './ollama.js';
import type { ChatProvider, EmbeddingProvider } from './types.js';

export interface Providers {
  chat: ChatProvider;
  embedder: EmbeddingProvider;
}

export interface ProviderDeps {
  fetchImpl?: FetchLike;
  logger?: Logger;
}

function ollamaOptions(config: AppConfig, deps: ProviderDeps): OllamaOptions {
  return {
    baseUrl: config.ollamaBaseUrl,
    chatModel: config.chatModel,
    embedModel: config.embedModel,
    chatTimeoutMs: config.chatTimeoutMs,
    embedTimeoutMs: config.embedTimeoutMs,
    maxRetries: config.maxRetries,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  };
}

/** Picks the chat and embedding implementations from configuration. */
export function createProviders(config: AppConfig, deps: ProviderDeps = {}): Providers {
  const embedder: EmbeddingProvider =
    config.embedProvider === 'mock' ? new MockEmbeddings() : new OllamaEmbeddings(ollamaOptions(config, deps));

  switch (config.provider) {
    case 'mock':
      return { chat: new MockChat(), embedder };
    case 'claude':
      if (!config.anthropicApiKey) throw new ConfigError('LLM_PROVIDER=claude requires ANTHROPIC_API_KEY to be set');
      return {
        chat: new ClaudeChat({
          apiKey: config.anthropicApiKey,
          model: config.claudeModel,
          timeoutMs: config.chatTimeoutMs,
          maxRetries: config.maxRetries,
          fetchImpl: deps.fetchImpl,
        }),
        embedder,
      };
    case 'ollama':
      return { chat: new OllamaChat(ollamaOptions(config, deps)), embedder };
  }
}

export type { ChatProvider, EmbeddingProvider } from './types.js';
