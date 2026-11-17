import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { HttpError, isRetryable, TimeoutError, withRetry } from '../src/http.js';
import { ClaudeChat } from '../src/providers/claude.js';
import { createProviders } from '../src/providers/index.js';
import { MockChat, MockEmbeddings, mockEmbedding } from '../src/providers/mock.js';
import { OllamaChat, OllamaEmbeddings, type OllamaOptions } from '../src/providers/ollama.js';
import { ProviderError } from '../src/providers/types.js';

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const piece of stream) out += piece;
  return out;
}

describe('loadConfig', () => {
  it('defaults to ollama on port 4101 with llama3.2 and nomic-embed-text', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      provider: 'ollama',
      embedProvider: 'ollama',
      port: 4101,
      chatModel: 'llama3.2',
      embedModel: 'nomic-embed-text',
      claudeModel: 'claude-haiku-5-5',
    });
  });

  it('uses mock embeddings in mock mode and keeps Ollama embeddings for claude', () => {
    expect(loadConfig({ LLM_PROVIDER: 'mock' }).embedProvider).toBe('mock');
    expect(loadConfig({ LLM_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'test-key' }).embedProvider).toBe('ollama');
  });

  it('rejects claude without an API key, unknown providers and bad numbers', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'claude' })).toThrow(ConfigError);
    expect(() => loadConfig({ LLM_PROVIDER: 'openai' })).toThrow(/must be one of/);
    expect(() => loadConfig({ CHUNK_SIZE: 'big' })).toThrow(ConfigError);
    expect(() => loadConfig({ CHUNK_SIZE: '200', CHUNK_OVERLAP: '200' })).toThrow(/smaller than/);
    expect(() => loadConfig({ TOP_K: '0' })).toThrow(ConfigError);
  });
});

describe('createProviders', () => {
  it('selects mock chat and embeddings', () => {
    const p = createProviders(loadConfig({ LLM_PROVIDER: 'mock' }));
    expect(p.chat).toBeInstanceOf(MockChat);
    expect(p.embedder).toBeInstanceOf(MockEmbeddings);
  });

  it('selects ollama for both by default', () => {
    const p = createProviders(loadConfig({}));
    expect(p.chat).toBeInstanceOf(OllamaChat);
    expect(p.embedder).toBeInstanceOf(OllamaEmbeddings);
  });

  it('selects claude for chat but keeps local embeddings', () => {
    const p = createProviders(loadConfig({ LLM_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'test-key' }));
    expect(p.chat).toBeInstanceOf(ClaudeChat);
    expect(p.chat.defaultModel).toBe('claude-haiku-5-5');
    expect(p.embedder).toBeInstanceOf(OllamaEmbeddings);
  });
});

describe('mock provider', () => {
  it('is deterministic', async () => {
    expect(mockEmbedding('Annual leave policy')).toEqual(mockEmbedding('annual LEAVE policy!'));
    const req = { model: 'mock-small', messages: [{ role: 'user' as const, content: 'Context:\n[1] (a.md)\nFirst. Second.\n\nQuestion: q' }] };
    const a = await drain(new MockChat().streamChat(req));
    expect(a).toBe(await drain(new MockChat().streamChat(req)));
    expect(a).toBe('Mock answer (mock-small): First. [1]');
  });

  it('lists its models', async () => {
    expect(await new MockChat().listModels()).toEqual(['mock-small', 'mock-large']);
  });
});

describe('withRetry / isRetryable', () => {
  it('retries 5xx and timeouts with exponential backoff, then succeeds', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw new HttpError(503, 'busy');
        if (attempts === 2) throw new TimeoutError('slow');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) },
    );
    expect(result).toBe('ok');
    expect(delays).toEqual([100, 200]);
  });

  it('does not retry 4xx and gives up after the retry budget', async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new HttpError(404, 'nope');
      }, { retries: 3, sleep: async () => {} }),
    ).rejects.toThrow('nope');
    expect(attempts).toBe(1);

    attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new HttpError(500, 'down');
      }, { retries: 2, sleep: async () => {} }),
    ).rejects.toThrow('down');
    expect(attempts).toBe(3);
    expect(isRetryable(new HttpError(429, 'x'))).toBe(true);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });
});

function ollamaOpts(fetchImpl: typeof fetch, over: Partial<OllamaOptions> = {}): OllamaOptions {
  return {
    baseUrl: 'http://ollama.test',
    chatModel: 'llama3.2',
    embedModel: 'nomic-embed-text',
    chatTimeoutMs: 5000,
    embedTimeoutMs: 5000,
    maxRetries: 1,
    retryBaseDelayMs: 1,
    fetchImpl,
    ...over,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Ollama provider (stubbed HTTP)', () => {
  it('parses the NDJSON chat stream', async () => {
    const ndjson = ['{"message":{"content":"Hello"}}', '{"message":{"content":" world"}}', '{"done":true}'].join('\n') + '\n';
    const fetchImpl = (async () => new Response(ndjson)) as typeof fetch;
    const chat = new OllamaChat(ollamaOpts(fetchImpl));
    expect(await drain(chat.streamChat({ model: 'llama3.2', messages: [] }))).toBe('Hello world');
  });

  it('surfaces an error line inside the stream as a ProviderError', async () => {
    const fetchImpl = (async () => new Response('{"error":"model not found"}\n')) as typeof fetch;
    const chat = new OllamaChat(ollamaOpts(fetchImpl));
    await expect(drain(chat.streamChat({ model: 'x', messages: [] }))).rejects.toThrow(/model not found/);
  });

  it('retries a 503 once before failing', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('busy', { status: 503 });
    }) as typeof fetch;
    const chat = new OllamaChat(ollamaOpts(fetchImpl));
    await expect(drain(chat.streamChat({ model: 'x', messages: [] }))).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(2);
  });

  it('lists only local chat-capable models and strips :latest', async () => {
    const fetchImpl = (async () =>
      json({
        models: [
          { name: 'llama3.2:latest', capabilities: ['completion', 'tools'] },
          { name: 'nomic-embed-text:latest', capabilities: ['embedding'] },
          { name: 'qwen2.5:3b' },
          { name: 'big-model:cloud', capabilities: ['completion'], remote_host: 'https://ollama.example' },
        ],
      })) as typeof fetch;
    expect(await new OllamaChat(ollamaOpts(fetchImpl)).listModels()).toEqual(['llama3.2', 'qwen2.5:3b']);
  });

  it('embeds with nomic task prefixes and in batches', async () => {
    const bodies: { model: string; input: string[] }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return json({ models: [{ name: 'nomic-embed-text:latest' }] });
      const body = JSON.parse(String(init!.body)) as { model: string; input: string[] };
      bodies.push(body);
      return json({ embeddings: body.input.map(() => [1, 2, 3]) });
    }) as typeof fetch;
    const embedder = new OllamaEmbeddings(ollamaOpts(fetchImpl));
    const vectors = await embedder.embed(Array.from({ length: 20 }, (_, i) => `t${i}`), 'document');
    expect(vectors).toHaveLength(20);
    expect(bodies.map((b) => b.input.length)).toEqual([16, 4]);
    expect(bodies[0]!.input[0]).toBe('search_document: t0');
    await embedder.embed(['q'], 'query');
    expect(bodies.at(-1)!.input).toEqual(['search_query: q']);
  });

  it('rejects a response with the wrong number of embeddings', async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith('/api/tags') ? json({ models: [] }) : json({ embeddings: [[1]] })) as typeof fetch;
    await expect(new OllamaEmbeddings(ollamaOpts(fetchImpl)).embed(['a', 'b'], 'document')).rejects.toThrow(
      /1 embeddings for 2 inputs/,
    );
  });

  it('times out a hanging request', async () => {
    const fetchImpl = ((url: string, init?: RequestInit) =>
      url.endsWith('/api/tags')
        ? Promise.resolve(json({ models: [] }))
        : new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const embedder = new OllamaEmbeddings(ollamaOpts(fetchImpl, { embedTimeoutMs: 50, maxRetries: 0 }));
    await expect(embedder.embed(['a'], 'document')).rejects.toThrow(/timed out/);
  });
});

describe('Claude provider (stubbed HTTP, not the live API)', () => {
  const sse = (events: [string, unknown][]) =>
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

  it('streams text deltas and sends system prompt separately', async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init!.body)) as Record<string, unknown>;
      const body = sse([
        ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ten days ' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '[1].' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const chat = new ClaudeChat({ apiKey: 'test-key', model: 'claude-haiku-5-5', timeoutMs: 5000, maxRetries: 0, fetchImpl });
    const text = await drain(
      chat.streamChat({
        model: 'claude-haiku-5-5',
        messages: [
          { role: 'system', content: 'rules' },
          { role: 'user', content: 'question' },
        ],
      }),
    );
    expect(text).toBe('Ten days [1].');
    expect(sent).toMatchObject({ model: 'claude-haiku-5-5', system: 'rules', stream: true, messages: [{ role: 'user', content: 'question' }] });
  });

  it('maps a 401 to a clear ProviderError', async () => {
    const fetchImpl = (async () =>
      json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)) as typeof fetch;
    const chat = new ClaudeChat({ apiKey: 'bad', model: 'claude-haiku-5-5', timeoutMs: 5000, maxRetries: 0, fetchImpl });
    await expect(drain(chat.streamChat({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'q' }] }))).rejects.toThrow(
      /rejected the API key/,
    );
  });

  it('falls back to the configured model when listing fails', async () => {
    const fetchImpl = (async () => json({ error: 'nope' }, 500)) as typeof fetch;
    const chat = new ClaudeChat({ apiKey: 'k', model: 'claude-haiku-5-5', timeoutMs: 5000, maxRetries: 0, fetchImpl });
    expect(await chat.listModels()).toEqual(['claude-haiku-5-5']);
  });
});
