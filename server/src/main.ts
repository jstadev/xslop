/** The web process: config, database pool, app on 127.0.0.1 behind the proxy, clean shutdown. */
import { buildApp } from './app.js';
import { createPgDb } from './db.js';
import { loadAppConfig, loadPort, requireDatabaseUrl } from './env.js';

const config = loadAppConfig();
const port = loadPort();
const db = createPgDb(requireDatabaseUrl());
const app = await buildApp({ db, config });

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.close();
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '127.0.0.1', port });
