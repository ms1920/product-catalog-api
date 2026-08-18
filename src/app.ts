import express, { type Express } from 'express';
import { loadConfig, type Config } from './config.js';
import type { Db } from './db/client.js';
import { PostgresProductRepository } from './repositories/product.repository.js';
import { ProductService } from './services/product.service.js';
import { productRoutes } from './http/product.routes.js';
import {
  errorHandler,
  notFoundHandler,
  rateLimit,
  requestId,
  requestLogger,
} from './http/middleware.js';

export interface AppOptions {
  db: Db;
  config?: Config;
}

/**
 * Builds the Express app without binding a port.
 *
 * This is the composition root — the only place that decides which concrete
 * repository is in play. Tests pass their own database handle, which is why they
 * can run in parallel without sharing state or opening sockets.
 */
export function createApp({ db, config = loadConfig() }: AppOptions): Express {
  const repository = new PostgresProductRepository(db);
  const service = new ProductService(repository);

  const app = express();

  app.disable('x-powered-by');
  // Needed for `req.ip` to reflect the real client behind nginx, which the rate
  // limiter keys on.
  app.set('trust proxy', true);
  // Without a body cap, one large POST can exhaust memory.
  app.use(express.json({ limit: '512kb' }));
  app.use(requestId);
  app.use(requestLogger(config));

  /**
   * Liveness vs readiness.
   *
   * `/health` answers "is the process alive" without touching the database, so a
   * database blip does not get the container killed and restarted — which would
   * not fix anything and would drop in-flight requests.
   *
   * `/ready` actually queries, because that is the question a load balancer is
   * asking: can this instance serve traffic right now. Neither is rate limited;
   * throttling a health check is how a busy service removes itself from rotation.
   */
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  app.get('/ready', asyncReady(db, service));

  app.use('/api', rateLimit(config));

  // Versioned from day one, so a breaking change can ship as /v2 rather than
  // breaking every existing client.
  app.use('/api/v1/products', productRoutes(service, config));

  app.use(notFoundHandler);
  app.use(errorHandler(config));

  return app;
}

function asyncReady(db: Db, service: ProductService): express.RequestHandler {
  return (_req, res) => {
    db.query('SELECT 1')
      .then(() => service.count())
      .then((products) => res.json({ status: 'ready', products }))
      .catch((error: unknown) => {
        // 503, not 500: the process is fine, its dependency is not, and a load
        // balancer should route away rather than treat this as a crash.
        res.status(503).json({
          status: 'unavailable',
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  };
}
