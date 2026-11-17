export type ProviderName = 'ollama' | 'claude' | 'mock';
export type EmbedProviderName = 'ollama' | 'mock';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface AppConfig {
  provider: ProviderName;
  embedProvider: EmbedProviderName;
  ollamaBaseUrl: string;
  chatModel: string;
  embedModel: string;
  claudeModel: string;
  anthropicApiKey: string | undefined;
  port: number;
  dbPath: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  minScore: number;
  chatTimeoutMs: number;
  embedTimeoutMs: number;
  maxRetries: number;
  maxUploadBytes: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(', ')} (got "${raw}")`);
  }
  return raw as T;
}

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function float(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be a number between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function str(env: Env, key: string, fallback: string): string {
  const raw = env[key]?.trim();
  return raw ? raw : fallback;
}

/** Reads and validates configuration. Throws ConfigError on the first bad value. */
export function loadConfig(env: Env = process.env): AppConfig {
  const provider = oneOf(env, 'LLM_PROVIDER', ['ollama', 'claude', 'mock'] as const, 'ollama');
  const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  if (provider === 'claude' && !anthropicApiKey) {
    throw new ConfigError('LLM_PROVIDER=claude requires ANTHROPIC_API_KEY to be set');
  }

  // Claude has no embeddings endpoint, so embeddings stay on Ollama unless mock is requested.
  const embedProvider = oneOf(
    env,
    'EMBED_PROVIDER',
    ['ollama', 'mock'] as const,
    provider === 'mock' ? 'mock' : 'ollama',
  );

  const chunkSize = int(env, 'CHUNK_SIZE', 800, 100, 8000);
  const chunkOverlap = int(env, 'CHUNK_OVERLAP', 120, 0, 4000);
  if (chunkOverlap >= chunkSize) {
    throw new ConfigError('CHUNK_OVERLAP must be smaller than CHUNK_SIZE');
  }

  return {
    provider,
    embedProvider,
    ollamaBaseUrl: str(env, 'OLLAMA_BASE_URL', 'http://localhost:11434').replace(/\/+$/, ''),
    chatModel: str(env, 'CHAT_MODEL', 'llama3.2'),
    embedModel: str(env, 'EMBED_MODEL', 'nomic-embed-text'),
    claudeModel: str(env, 'CLAUDE_MODEL', 'claude-haiku-5-5'),
    anthropicApiKey,
    port: int(env, 'PORT', 4101, 1, 65535),
    dbPath: str(env, 'DB_PATH', './data/rag.db'),
    chunkSize,
    chunkOverlap,
    topK: int(env, 'TOP_K', 4, 1, 20),
    minScore: float(env, 'MIN_SCORE', 0, -1, 1),
    chatTimeoutMs: int(env, 'CHAT_TIMEOUT_MS', 300_000, 1000, 3_600_000),
    embedTimeoutMs: int(env, 'EMBED_TIMEOUT_MS', 120_000, 1000, 3_600_000),
    maxRetries: int(env, 'MAX_RETRIES', 2, 0, 10),
    maxUploadBytes: int(env, 'MAX_UPLOAD_MB', 20, 1, 500) * 1024 * 1024,
    logLevel: oneOf(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error', 'silent'] as const, 'info'),
  };
}

/** Loads a .env file from the working directory if one exists (Node built-in, no dotenv dependency). */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: defaults and real environment variables apply.
  }
}
