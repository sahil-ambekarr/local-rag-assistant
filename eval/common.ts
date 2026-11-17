import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadDotEnv, type AppConfig } from '../src/config.js';
import { ingestPath } from '../src/ingest.js';
import { createLogger } from '../src/logger.js';
import { createProviders, type Providers } from '../src/providers/index.js';
import { VectorStore } from '../src/vectorStore.js';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const SAMPLE_DOCS = path.join(ROOT, 'sample-docs');
export const RESULTS_DIR = path.join(ROOT, 'docs', 'eval');

export interface EvalContext {
  config: AppConfig;
  providers: Providers;
  store: VectorStore;
  ingestMs: number;
  chunkCount: number;
  documentCount: number;
}

export interface CliFlags {
  /** Use mock embeddings and chat (CI smoke run). */
  mock: boolean;
  /** Write results to docs/eval/. Off for mock runs so CI never overwrites real numbers. */
  write: boolean;
}

export function parseFlags(argv: string[]): CliFlags {
  const mock = argv.includes('--mock');
  return { mock, write: !mock && !argv.includes('--no-write') };
}

/**
 * Indexes sample-docs/ into data/eval.db. With fresh=false an existing index is
 * reused (unchanged files are skipped), which saves re-embedding on a busy Ollama.
 */
export async function buildIndex(flags: CliFlags, fresh = true): Promise<EvalContext> {
  loadDotEnv();
  const env: Record<string, string | undefined> = { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' };
  if (flags.mock) env.LLM_PROVIDER = 'mock';
  const config = loadConfig(env);
  const logger = createLogger(config.logLevel);
  const providers = createProviders(config, { logger });

  const dbPath = path.join(ROOT, 'data', flags.mock ? 'eval-mock.db' : 'eval.db');
  if (fresh) for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  const store = new VectorStore(dbPath);

  const started = performance.now();
  const results = await ingestPath(SAMPLE_DOCS, {
    store,
    embedder: providers.embedder,
    chunking: { chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap },
    logger,
  });
  return {
    config,
    providers,
    store,
    ingestMs: Math.round(performance.now() - started),
    chunkCount: store.countChunks(),
    documentCount: results.length,
  };
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** Whitespace-insensitive containment, so PDF line breaks do not hide a match. */
export function containsEvidence(text: string, evidence: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
  return norm(text).includes(norm(evidence));
}

export function environment() {
  return {
    date: new Date().toISOString().slice(0, 10),
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    note: 'CPU-only laptop, AMD integrated graphics, 16 GB RAM, Windows 11. Ollama was shared with other workloads during the run.',
  };
}

export function writeResult(name: string, data: unknown): string {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
