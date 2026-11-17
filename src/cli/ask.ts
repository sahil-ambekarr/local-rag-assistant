import { parseArgs } from 'node:util';
import { formatSourcesList, type Citation } from '../citations.js';
import { loadConfig, loadDotEnv } from '../config.js';
import { createLogger, errorMessage } from '../logger.js';
import { createProviders } from '../providers/index.js';
import { answerQuestion } from '../rag.js';
import { VectorStore } from '../vectorStore.js';

// Usage: npm run ask -- "question" [--model llama3.2] [--top-k 4]
loadDotEnv();

let store: VectorStore | undefined;
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { model: { type: 'string', short: 'm' }, 'top-k': { type: 'string', short: 'k' } },
  });
  const question = positionals.join(' ').trim();
  if (!question) {
    process.stderr.write('Usage: npm run ask -- "your question" [--model <name>] [--top-k <n>]\n');
    process.exit(2);
  }

  const config = loadConfig();
  const topK = values['top-k'] ? Number(values['top-k']) : config.topK;
  if (!Number.isInteger(topK) || topK < 1 || topK > 20) throw new Error('--top-k must be an integer between 1 and 20');

  const logger = createLogger(config.logLevel === 'info' ? 'warn' : config.logLevel);
  store = new VectorStore(config.dbPath);
  const { chat, embedder } = createProviders(config, { logger });

  let citations: Citation[] = [];
  for await (const event of answerQuestion(question, {
    store,
    embedder,
    chat,
    model: values.model,
    topK,
    minScore: config.minScore,
  })) {
    if (event.type === 'sources') citations = event.citations;
    if (event.type === 'token') process.stdout.write(event.text);
    if (event.type === 'done') {
      process.stdout.write('\n');
      if (citations.length > 0) process.stdout.write(`\nSources:\n${formatSourcesList(citations)}\n`);
      process.stdout.write(
        `\n(${chat.name}/${event.model}, retrieval ${event.retrievalMs} ms, generation ${event.generationMs} ms)\n`,
      );
    }
  }
} catch (err) {
  process.stderr.write(`Ask failed: ${errorMessage(err)}\n`);
  process.exitCode = 1;
} finally {
  store?.close();
}
