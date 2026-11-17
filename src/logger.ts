import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** One JSON object per line on stderr, so stdout stays clean for CLI answers. */
export function createLogger(level: LogLevel, write: (line: string) => void = (l) => process.stderr.write(l + '\n')): Logger {
  const emit = (lvl: Exclude<LogLevel, 'silent'>) => (event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[lvl] < ORDER[level]) return;
    write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, event, ...fields }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger: Logger = createLogger('silent');

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
