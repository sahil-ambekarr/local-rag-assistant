import { loadConfig, loadDotEnv } from '../config.js';
import { ingestPath } from '../ingest.js';
import { createLogger, errorMessage } from '../logger.js';
import { createProviders } from '../providers/index.js';
import { VectorStore } from '../vectorStore.js';

// Usage: npm run ingest -- <file-or-directory> [more paths...]
loadDotEnv();

const targets = process.argv.slice(2);
if (targets.length === 0) {
  process.stderr.write('Usage: npm run ingest -- <file-or-directory> [more paths...]\n');
  process.exit(2);
}

let store: VectorStore | undefined;
try {
  const config = loadConfig();
  const logger = createLogger(config.logLevel === 'info' ? 'warn' : config.logLevel);
  store = new VectorStore(config.dbPath);
  const { embedder } = createProviders(config, { logger });
  const deps = { store, embedder, chunking: { chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap }, logger };

  let files = 0;
  let chunks = 0;
  for (const target of targets) {
    for (const result of await ingestPath(target, deps)) {
      files++;
      chunks += result.document.chunkCount;
      const note = result.skipped ? 'unchanged, skipped' : `${result.ms} ms`;
      process.stdout.write(`${result.document.source}: ${result.document.chunkCount} chunks (${note})\n`);
    }
  }
  process.stdout.write(`Done: ${files} file(s), ${chunks} chunk(s) in ${config.dbPath} using ${embedder.model}\n`);
} catch (err) {
  process.stderr.write(`Ingest failed: ${errorMessage(err)}\n`);
  process.exitCode = 1;
} finally {
  store?.close();
}
