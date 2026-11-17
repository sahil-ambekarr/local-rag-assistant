import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MockChat, MockEmbeddings } from '../src/providers/mock.js';
import type { ChatProvider } from '../src/providers/types.js';
import { createApp, parseAskBody, sanitizeFilename, sseFrame, ValidationError } from '../src/server.js';
import { VectorStore } from '../src/vectorStore.js';

// The server listens on a named pipe / Unix socket rather than a TCP port, so
// tests never compete for ports with anything else running on the machine.
function socketPath(name: string): string {
  const id = `${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(sock: string, method: string, url: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method, path: url, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function parseSse(text: string): { event: string; data: Record<string, unknown> }[] {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)![1]!;
      const data = JSON.parse(/^data: (.+)$/m.exec(frame)![1]!) as Record<string, unknown>;
      return { event, data };
    });
}

async function startServer(chat: ChatProvider) {
  const store = new VectorStore(':memory:');
  const config = loadConfig({ LLM_PROVIDER: 'mock', CHUNK_SIZE: '300', CHUNK_OVERLAP: '0', MAX_UPLOAD_MB: '1' });
  const app = createApp({ config, store, chat, embedder: new MockEmbeddings() });
  const sock = socketPath('rag');
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(sock, () => resolve(s));
  });
  return {
    sock,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}

describe('HTTP API', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer(new MockChat());
  });
  afterAll(async () => srv.close());

  it('reports health and the active provider', async () => {
    const res = await request(srv.sock, 'GET', '/api/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'ok', provider: 'mock', embeddingModel: 'mock-hash-256' });
  });

  it('lists models for the switcher', async () => {
    const body = JSON.parse((await request(srv.sock, 'GET', '/api/models')).body);
    expect(body).toEqual({ provider: 'mock', defaultModel: 'mock-small', models: ['mock-small', 'mock-large'] });
  });

  it('ingests an upload, skips an identical re-upload and lists it', async () => {
    const md = '# Travel\n## Hotels\nHotel stays are capped at a fixed nightly rate.\n## Meals\nMeals are covered with receipts.';
    const first = await request(srv.sock, 'POST', '/api/documents?filename=travel.md', md);
    expect(first.status).toBe(201);
    expect(JSON.parse(first.body).document).toMatchObject({ source: 'travel.md', chunkCount: 2 });
    const again = await request(srv.sock, 'POST', '/api/documents?filename=travel.md', md);
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body).skipped).toBe(true);
    const list = JSON.parse((await request(srv.sock, 'GET', '/api/documents')).body);
    expect(list.documents.map((d: { source: string }) => d.source)).toEqual(['travel.md']);
  });

  it('rejects unsupported types, empty bodies and oversized uploads', async () => {
    expect((await request(srv.sock, 'POST', '/api/documents?filename=evil.exe', 'x')).status).toBe(400);
    expect((await request(srv.sock, 'POST', '/api/documents?filename=a.txt', '')).status).toBe(400);
    expect((await request(srv.sock, 'POST', '/api/documents', 'x')).status).toBe(400);
    const big = await request(srv.sock, 'POST', '/api/documents?filename=big.txt', Buffer.alloc(1024 * 1024 + 10, 97));
    expect(big.status).toBe(413);
    expect(JSON.parse(big.body).error).toMatch(/MAX_UPLOAD_MB/);
  });

  it('streams an answer over SSE: sources, tokens, done', async () => {
    const res = await request(srv.sock, 'POST', '/api/ask', JSON.stringify({ question: 'hotel nightly rate', model: 'mock-large' }), {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const events = parseSse(res.body);
    expect(events[0]!.event).toBe('sources');
    const citations = events[0]!.data.citations as { n: number; label: string }[];
    expect(citations[0]).toMatchObject({ n: 1, label: 'travel.md > Travel > Hotels (chunk 1)' });
    expect(events.filter((e) => e.event === 'token').length).toBeGreaterThan(3);
    const done = events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data).toMatchObject({ model: 'mock-large', cited: [1] });
    expect(done.data.answer).toContain('Hotel stays are capped');
  });

  it('validates the ask body with a 400 JSON error', async () => {
    const res = await request(srv.sock, 'POST', '/api/ask', JSON.stringify({ question: '  ' }), { 'content-type': 'application/json' });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/non-empty/);
    const bad = await request(srv.sock, 'POST', '/api/ask', '{not json', { 'content-type': 'application/json' });
    expect(bad.status).toBe(400);
  });

  it('deletes a document and returns 404 for unknown ids and routes', async () => {
    const id = JSON.parse((await request(srv.sock, 'GET', '/api/documents')).body).documents[0].id as number;
    expect((await request(srv.sock, 'DELETE', `/api/documents/${id}`)).status).toBe(204);
    expect((await request(srv.sock, 'DELETE', `/api/documents/${id}`)).status).toBe(404);
    expect((await request(srv.sock, 'DELETE', '/api/documents/abc')).status).toBe(400);
    expect((await request(srv.sock, 'GET', '/api/nope')).status).toBe(404);
  });
});

describe('SSE error path', () => {
  it('sends an error event when the provider fails mid-stream', async () => {
    const failing: ChatProvider = {
      name: 'failing',
      defaultModel: 'f',
      listModels: async () => {
        throw new Error('provider offline');
      },
      streamChat: async function* () {
        yield 'partial ';
        throw new Error('connection reset');
      },
    };
    const srv = await startServer(failing);
    try {
      await request(srv.sock, 'POST', '/api/documents?filename=a.txt', 'Some content about badges and doors.');
      const res = await request(srv.sock, 'POST', '/api/ask', JSON.stringify({ question: 'badges' }), {
        'content-type': 'application/json',
      });
      const events = parseSse(res.body);
      expect(events.map((e) => e.event)).toEqual(['sources', 'token', 'error']);
      expect(events[2]!.data.message).toBe('connection reset');

      // Model listing failure degrades to the default model plus a warning.
      const models = JSON.parse((await request(srv.sock, 'GET', '/api/models')).body);
      expect(models).toMatchObject({ models: ['f'], warning: 'provider offline' });
    } finally {
      await srv.close();
    }
  });
});

describe('request helpers', () => {
  it('parseAskBody applies defaults and limits', () => {
    expect(parseAskBody({ question: ' hi ' }, 4)).toEqual({ question: 'hi', model: undefined, topK: 4 });
    expect(() => parseAskBody(null, 4)).toThrow(ValidationError);
    expect(() => parseAskBody({ question: 'x'.repeat(2001) }, 4)).toThrow(/2000/);
    expect(() => parseAskBody({ question: 'q', topK: 21 }, 4)).toThrow(/topK/);
    expect(() => parseAskBody({ question: 'q', model: 5 }, 4)).toThrow(/model/);
  });

  it('sanitizeFilename strips directories', () => {
    expect(sanitizeFilename('../../etc/notes.md')).toBe('notes.md');
    expect(sanitizeFilename('C:\\docs\\policy.pdf')).toBe('policy.pdf');
    expect(() => sanitizeFilename('..')).toThrow();
    expect(() => sanitizeFilename('script.js')).toThrow(/Unsupported/);
  });

  it('sseFrame writes event and data lines', () => {
    expect(sseFrame({ type: 'token', text: 'hi' })).toBe('event: token\ndata: {"text":"hi"}\n\n');
  });
});

