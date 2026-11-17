import { loadConfig, loadDotEnv } from './config.js';
import { createLogger, errorMessage } from './logger.js';
import { createProviders } from './providers/index.js';
import { createApp } from './server.js';
import { VectorStore } from './vectorStore.js';

loadDotEnv();

try {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const store = new VectorStore(config.dbPath);
  const { chat, embedder } = createProviders(config, { logger });
  const app = createApp({ config, store, chat, embedder, logger });

  const server = app.listen(config.port, config.host, () => {
    logger.info('server.listening', {
      url: `http://localhost:${config.port}`,
      provider: chat.name,
      chatModel: chat.defaultModel,
      embeddingModel: embedder.model,
      db: config.dbPath,
    });
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeAllConnections();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  process.stderr.write(`Startup failed: ${errorMessage(err)}\n`);
  process.exit(1);
}
