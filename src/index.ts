import { config } from './config.js';
import { createHttpServer } from './http.js';
import { FileStore } from './store.js';

const store = new FileStore(config.dataFile, config.encryptionKey);
await store.init();

const server = createHttpServer(store);
server.listen(config.port, '0.0.0.0', () => {
  console.log(`Custom Email MCP listening on ${config.publicUrl}`);
  if (config.usingDerivedEncryptionKey) console.warn('Encryption key is derived from a development value. Set MASTER_ENCRYPTION_KEY before deployment.');
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
