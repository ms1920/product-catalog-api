import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDbFromEnv } from './db/client.js';
import { migrate } from './db/migrate.js';

const config = loadConfig();
const { db, driver } = await createDbFromEnv();

// Idempotent, so it is safe to run on every boot. Means a fresh clone or a fresh
// container is serving requests without a separate setup step.
await migrate(db);

const app = createApp({ db, config });

const server = app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'server started',
      port: config.port,
      env: config.nodeEnv,
      driver,
      writesProtected: Boolean(config.apiKey),
    }),
  );

  if (driver === 'pglite') {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'using embedded PGlite — set DATABASE_URL to run against a real PostgreSQL server',
      }),
    );
  }
});

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * then close the pool. Without it, a deploy or scale-down kills live requests and
 * clients see connection resets rather than responses.
 */
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));

  server.close(() => {
    db.close()
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'failed to close database',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      })
      .finally(() => process.exit(0));
  });

  // Backstop, so a stuck connection cannot hold the process open forever.
  setTimeout(() => {
    console.error(JSON.stringify({ level: 'error', msg: 'forced shutdown after timeout' }));
    process.exit(1);
  }, 10_000).unref();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => shutdown(signal));
}
