import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from './config.js';
import { ingestBuffer } from './ingest.js';
import { documentTypeFor, UnsupportedDocumentError } from './loaders.js';
import { errorMessage, silentLogger, type Logger } from './logger.js';
import type { ChatProvider, EmbeddingProvider } from './providers/types.js';
import { ProviderError } from './providers/types.js';
import { answerQuestion, type RagEvent } from './rag.js';
import { EmbeddingMismatchError, type VectorStore } from './vectorStore.js';

export interface AppDeps {
  config: AppConfig;
  store: VectorStore;
  chat: ChatProvider;
  embedder: EmbeddingProvider;
  logger?: Logger;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MAX_QUESTION_LENGTH = 2000;

export interface AskInput {
  question: string;
  model: string | undefined;
  topK: number;
}

/** Validates the /api/ask body. Exported for unit tests. */
export function parseAskBody(body: unknown, defaultTopK: number): AskInput {
  if (typeof body !== 'object' || body === null) throw new ValidationError('Request body must be a JSON object');
  const { question, model, topK } = body as Record<string, unknown>;

  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new ValidationError('"question" must be a non-empty string');
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new ValidationError(`"question" must be at most ${MAX_QUESTION_LENGTH} characters`);
  }
  if (model !== undefined && (typeof model !== 'string' || model.length === 0 || model.length > 120)) {
    throw new ValidationError('"model" must be a string of 1-120 characters');
  }
  if (topK !== undefined && (typeof topK !== 'number' || !Number.isInteger(topK) || topK < 1 || topK > 20)) {
    throw new ValidationError('"topK" must be an integer between 1 and 20');
  }
  return { question: question.trim(), model: model as string | undefined, topK: (topK as number | undefined) ?? defaultTopK };
}

/** Strips any directory part so an upload can never name a path outside the store. */
export function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ValidationError('Query parameter "filename" is required');
  }
  const name = path.basename(raw.replace(/\\/g, '/')).trim();
  if (!name || name === '.' || name === '..' || name.length > 200) {
    throw new ValidationError('Invalid "filename"');
  }
  documentTypeFor(name); // throws UnsupportedDocumentError for other extensions
  return name;
}

export function sseFrame(event: RagEvent | { type: 'error'; message: string }): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function statusFor(err: unknown): number {
  if (err instanceof ValidationError || err instanceof UnsupportedDocumentError) return 400;
  if (err instanceof EmbeddingMismatchError) return 409;
  if (err instanceof ProviderError) return 502;
  const status = (err as { status?: unknown; statusCode?: unknown })?.status ?? (err as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

export function createApp(deps: AppDeps): express.Express {
  const { config, store, chat, embedder } = deps;
  const logger = deps.logger ?? silentLogger;
  const app = express();
  app.disable('x-powered-by');

  // Ingests run one at a time so a shared CPU-only Ollama is never hit in parallel.
  let ingestQueue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const next = ingestQueue.then(job, job);
    ingestQueue = next.catch(() => undefined);
    return next;
  };

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      provider: chat.name,
      embeddingProvider: embedder.name,
      embeddingModel: embedder.model,
      documents: store.listDocuments().length,
      chunks: store.countChunks(),
    });
  });

  app.get('/api/models', async (_req, res) => {
    let models: string[];
    let warning: string | undefined;
    try {
      models = await chat.listModels();
    } catch (err) {
      // The dropdown still works with the default model when the provider is unreachable.
      models = [];
      warning = errorMessage(err);
      logger.warn('models.list_failed', { error: warning });
    }
    if (!models.includes(chat.defaultModel)) models.unshift(chat.defaultModel);
    res.json({ provider: chat.name, defaultModel: chat.defaultModel, models, ...(warning ? { warning } : {}) });
  });

  app.get('/api/documents', (_req, res) => {
    res.json({ documents: store.listDocuments() });
  });

  app.post(
    '/api/documents',
    express.raw({ type: () => true, limit: config.maxUploadBytes }),
    async (req: Request, res: Response) => {
      const filename = sanitizeFilename(req.query.filename);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new ValidationError('Request body must contain the file bytes');
      }
      const data = req.body;
      const result = await enqueue(() =>
        ingestBuffer(filename, data, {
          store,
          embedder,
          chunking: { chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap },
          logger,
        }),
      );
      res.status(result.skipped ? 200 : 201).json(result);
    },
  );

  app.delete('/api/documents/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError('Document id must be a positive integer');
    if (!store.deleteDocument(id)) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    res.status(204).end();
  });

  app.post('/api/ask', express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    const input = parseAskBody(req.body, config.topK);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // Stop generating as soon as the client goes away.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    try {
      const events = answerQuestion(input.question, {
        store,
        embedder,
        chat,
        model: input.model,
        topK: input.topK,
        minScore: config.minScore,
        signal: abort.signal,
      });
      for await (const event of events) {
        if (abort.signal.aborted) break;
        res.write(sseFrame(event));
        if (event.type === 'done') {
          logger.info('ask.done', {
            model: event.model,
            cited: event.cited,
            retrievalMs: event.retrievalMs,
            generationMs: event.generationMs,
          });
        }
      }
    } catch (err) {
      // Headers are already sent, so the failure travels as an SSE event.
      if (!abort.signal.aborted) {
        logger.error('ask.failed', { error: errorMessage(err) });
        res.write(sseFrame({ type: 'error', message: errorMessage(err) }));
      }
    } finally {
      res.end();
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(express.static(path.resolve(import.meta.dirname, '..', 'public')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = statusFor(err);
    if (status >= 500) logger.error('request.failed', { status, error: errorMessage(err) });
    if (res.headersSent) {
      res.end();
      return;
    }
    const message = status === 413 ? 'Upload is larger than MAX_UPLOAD_MB' : errorMessage(err);
    res.status(status).json({ error: message });
  });

  return app;
}
