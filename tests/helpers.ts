import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createPgliteDb, type Db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';

export const testConfig: Config = {
  port: 0,
  nodeEnv: 'test',
  defaultPageSize: 20,
  maxPageSize: 100,
  cacheMaxAgeSeconds: 0,
  rateLimit: 100_000,
  apiKey: undefined,
};

/**
 * Builds an app on a fresh in-memory PostgreSQL instance.
 *
 * PGlite with no `dataDir` is ephemeral, so every test gets a genuinely isolated
 * database — real SQL, real indexes, real constraints — with no cleanup between
 * tests and no shared state to serialise on. Mocking the database instead would
 * only verify that the mock behaves like the mock, and query behaviour is the
 * substance of this service.
 */
export async function makeApp(overrides: Partial<Config> = {}): Promise<{ app: Express; db: Db }> {
  const db = await createPgliteDb();
  await migrate(db);
  return { app: createApp({ db, config: { ...testConfig, ...overrides } }), db };
}

export const sampleProduct = {
  sku: 'NIKE-AM90-001',
  name: 'Nike Air Max 90',
  description: 'Classic Waffle outsole and visible Air cushioning.',
  brand: 'Nike',
  category: 'Lifestyle',
  price: { amount: 1_329_500, currency: 'INR' },
  stock: 12,
  status: 'active' as const,
  attributes: { colourway: 'White/Grey' },
};

/** Creates a product and returns it with its ETag, which updates require. */
export async function createProduct(
  app: Express,
  overrides: Partial<typeof sampleProduct> = {},
): Promise<{ id: string; etag: string; body: Record<string, never> }> {
  const res = await request(app)
    .post('/api/v1/products')
    .send({ ...sampleProduct, ...overrides })
    .expect(201);

  return { id: res.body.data.id, etag: res.headers.etag ?? '', body: res.body.data };
}

/** Bulk insert straight through the repository — far faster than N HTTP calls. */
export async function insertMany(
  db: Db,
  products: Array<{
    sku: string;
    category: string;
    price: number;
    brand?: string;
    stock?: number;
    status?: string;
    name?: string;
  }>,
): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  for (const p of products) {
    await db.query(
      `INSERT INTO products (id, sku, name, description, brand, category, price_minor, currency, stock, status, attributes)
       VALUES ($1,$2,$3,'',$4,$5,$6,'INR',$7,$8,'{}')`,
      [
        randomUUID(),
        p.sku,
        p.name ?? p.sku,
        p.brand ?? 'Nike',
        p.category,
        p.price,
        p.stock ?? 10,
        p.status ?? 'active',
      ],
    );
  }
}
