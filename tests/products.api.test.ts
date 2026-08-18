import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createProduct, insertMany, makeApp, sampleProduct } from './helpers.js';

describe('health and readiness', () => {
  it('reports liveness without touching the database', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('reports readiness with a row count', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/ready').expect(200);
    expect(res.body).toMatchObject({ status: 'ready', products: 0 });
  });
});

describe('POST /api/v1/products', () => {
  it('creates a product and returns 201 with Location and ETag', async () => {
    const { app } = await makeApp();
    const res = await request(app).post('/api/v1/products').send(sampleProduct).expect(201);

    expect(res.body.data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.data.version).toBe(1);
    expect(res.headers.location).toBe(`/api/v1/products/${res.body.data.id}`);
    expect(res.headers.etag).toMatch(/^"[a-f0-9]{20}"$/);
  });

  it('stores price as integer minor units and formats on read', async () => {
    const { app } = await makeApp();
    const res = await request(app).post('/api/v1/products').send(sampleProduct).expect(201);

    expect(res.body.data.price.amount).toBe(1_329_500);
    expect(res.body.data.priceFormatted).toBe('₹13,295.00');
  });

  it('rejects a fractional price', async () => {
    // The guard that keeps 19.999 out of the database rather than discovering it
    // in a total later.
    const { app } = await makeApp();
    const res = await request(app)
      .post('/api/v1/products')
      .send({ ...sampleProduct, price: { amount: 1299.99, currency: 'INR' } })
      .expect(400);

    expect(res.body.error.details[0].path).toBe('price.amount');
  });

  it('rejects a duplicate SKU regardless of case', async () => {
    const { app } = await makeApp();
    await createProduct(app);

    const res = await request(app)
      .post('/api/v1/products')
      .send({ ...sampleProduct, sku: 'nike-am90-001' })
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects unknown fields instead of silently dropping them', async () => {
    // A client sending `pirce` should be told, not handed a product with no price.
    const { app } = await makeApp();
    await request(app)
      .post('/api/v1/products')
      .send({ ...sampleProduct, pirce: 100 })
      .expect(400);
  });

  it('reports every validation failure at once', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post('/api/v1/products')
      .send({ sku: '', name: '', brand: '', category: '', price: { amount: -1, currency: 'X' } })
      .expect(400);

    expect(res.body.error.details.length).toBeGreaterThanOrEqual(4);
  });

  it('returns 400 for malformed JSON', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post('/api/v1/products')
      .set('content-type', 'application/json')
      .send('{"sku":')
      .expect(400);

    expect(res.body.error.message).toMatch(/not valid JSON/);
  });
});

describe('GET /api/v1/products/:id', () => {
  it('fetches by id', async () => {
    const { app } = await makeApp();
    const { id } = await createProduct(app);

    const res = await request(app).get(`/api/v1/products/${id}`).expect(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.inStock).toBe(true);
  });

  it('serves 304 when the ETag still matches', async () => {
    // Free bandwidth on a read-heavy service: an unchanged product costs a header
    // exchange rather than re-serialising the whole row.
    const { app } = await makeApp();
    const { id, etag } = await createProduct(app);

    await request(app).get(`/api/v1/products/${id}`).set('if-none-match', etag).expect(304);
  });

  it('returns a fresh body once the product changes', async () => {
    const { app } = await makeApp();
    const { id, etag } = await createProduct(app);

    await request(app)
      .patch(`/api/v1/products/${id}`)
      .set('if-match', etag)
      .send({ name: 'Renamed' })
      .expect(200);

    const res = await request(app)
      .get(`/api/v1/products/${id}`)
      .set('if-none-match', etag)
      .expect(200);
    expect(res.body.data.name).toBe('Renamed');
  });

  it('404s on an unknown id', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .get('/api/v1/products/11111111-1111-4111-8111-111111111111')
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('fetches by SKU case-insensitively', async () => {
    const { app } = await makeApp();
    await createProduct(app);
    const res = await request(app).get('/api/v1/products/sku/nike-am90-001').expect(200);
    expect(res.body.data.sku).toBe('NIKE-AM90-001');
  });
});

describe('PATCH /api/v1/products/:id — optimistic concurrency', () => {
  it('applies a partial update and bumps the version', async () => {
    const { app } = await makeApp();
    const { id, etag } = await createProduct(app);

    const res = await request(app)
      .patch(`/api/v1/products/${id}`)
      .set('if-match', etag)
      .send({ price: { amount: 999_00, currency: 'INR' } })
      .expect(200);

    expect(res.body.data.price.amount).toBe(999_00);
    expect(res.body.data.name).toBe(sampleProduct.name); // untouched
    expect(res.body.data.version).toBe(2);
    expect(res.headers.etag).not.toBe(etag);
  });

  it('refuses a PATCH with no If-Match', async () => {
    // Required, not optional: optional makes last-write-wins the default for every
    // client that forgets, and they never find out.
    const { app } = await makeApp();
    const { id } = await createProduct(app);

    const res = await request(app)
      .patch(`/api/v1/products/${id}`)
      .send({ name: 'No precondition' })
      .expect(428);

    expect(res.body.error.code).toBe('PRECONDITION_REQUIRED');
  });

  it('refuses a stale If-Match and preserves the first write', async () => {
    // The lost-update problem, prevented.
    const { app } = await makeApp();
    const { id, etag: stale } = await createProduct(app);

    await request(app)
      .patch(`/api/v1/products/${id}`)
      .set('if-match', stale)
      .send({ name: 'First writer' })
      .expect(200);

    const res = await request(app)
      .patch(`/api/v1/products/${id}`)
      .set('if-match', stale)
      .send({ name: 'Second writer clobbers' })
      .expect(412);
    expect(res.body.error.code).toBe('PRECONDITION_FAILED');

    const after = await request(app).get(`/api/v1/products/${id}`).expect(200);
    expect(after.body.data.name).toBe('First writer');
  });

  it('accepts If-Match: * as a deliberate blind overwrite', async () => {
    const { app } = await makeApp();
    const { id } = await createProduct(app);

    await request(app)
      .patch(`/api/v1/products/${id}`)
      .set('if-match', '*')
      .send({ name: 'Deliberate' })
      .expect(200);
  });

  it('tolerates a weak validator and unquoted tags', async () => {
    const { app } = await makeApp();
    const { id, etag } = await createProduct(app);
    const bare = etag.replace(/"/g, '');

    await request(app)
      .patch(`/api/v1/products/${id}`)
      .set('if-match', `W/"${bare}"`)
      .send({ name: 'Weak ok' })
      .expect(200);
  });

  it('rejects an empty patch body', async () => {
    const { app } = await makeApp();
    const { id, etag } = await createProduct(app);

    await request(app).patch(`/api/v1/products/${id}`).set('if-match', etag).send({}).expect(400);
  });

  it('ignores an attempt to change the immutable SKU', async () => {
    const { app } = await makeApp();
    const { id, etag } = await createProduct(app);

    await request(app)
      .patch(`/api/v1/products/${id}`)
      .set('if-match', etag)
      .send({ sku: 'HIJACKED' })
      .expect(400); // strict schema has no `sku` key at all
  });
});

describe('DELETE /api/v1/products/:id', () => {
  it('soft-deletes and removes the product from default listings', async () => {
    const { app } = await makeApp();
    const { id, etag } = await createProduct(app);

    const res = await request(app)
      .delete(`/api/v1/products/${id}`)
      .set('if-match', etag)
      .expect(200);
    expect(res.body.data.status).toBe('archived');

    const list = await request(app).get('/api/v1/products').expect(200);
    expect(list.body.data.some((p: { id: string }) => p.id === id)).toBe(false);

    // Still addressable, so an old order can resolve what was bought.
    await request(app).get(`/api/v1/products/${id}`).expect(200);
  });
});

describe('GET /api/v1/products — filtering', () => {
  async function seeded() {
    const { app, db } = await makeApp();
    await insertMany(db, [
      { sku: 'R-1', category: 'Running', price: 500_00, brand: 'Nike' },
      { sku: 'R-2', category: 'Running', price: 5_000_00, brand: 'Nike' },
      { sku: 'R-3', category: 'Running', price: 20_000_00, brand: 'Asics' },
      { sku: 'B-1', category: 'Basketball', price: 8_000_00, brand: 'Jordan' },
      { sku: 'B-2', category: 'Basketball', price: 25_000_00, brand: 'Nike' },
      { sku: 'L-1', category: 'Lifestyle', price: 3_000_00, brand: 'Converse' },
      { sku: 'OOS', category: 'Running', price: 1_000_00, brand: 'Nike', stock: 0 },
      { sku: 'DRAFT', category: 'Running', price: 1_000_00, status: 'draft' },
    ]);
    return { app, db };
  }

  it('hides non-active products by default', async () => {
    const { app } = await seeded();
    const res = await request(app).get('/api/v1/products').expect(200);

    expect(res.body.page.total).toBe(7);
    expect(res.body.data.every((p: { status: string }) => p.status === 'active')).toBe(true);
  });

  it('filters by category', async () => {
    const { app } = await seeded();
    const res = await request(app).get('/api/v1/products?category=Running').expect(200);
    expect(res.body.page.total).toBe(4);
  });

  it('ORs several values of one filter', async () => {
    const { app } = await seeded();
    const res = await request(app).get('/api/v1/products?category=Running,Basketball').expect(200);
    expect(res.body.page.total).toBe(6);
  });

  it('ANDs across different filters', async () => {
    const { app } = await seeded();
    const res = await request(app).get('/api/v1/products?category=Running&brand=Nike').expect(200);
    expect(res.body.page.total).toBe(3);
  });

  it('filters by an inclusive price range in minor units', async () => {
    const { app } = await seeded();
    const res = await request(app)
      .get('/api/v1/products?minPrice=100000&maxPrice=800000')
      .expect(200);

    const amounts = res.body.data.map((p: { price: { amount: number } }) => p.price.amount);
    expect(amounts.every((a: number) => a >= 100_000 && a <= 800_000)).toBe(true);

    // OOS(1_000_00) and B-1(8_000_00) sit exactly on the bounds and must be
    // included — an exclusive range would silently drop the products priced at
    // precisely the number the customer typed.
    expect(res.body.page.total).toBe(4);
    expect(res.body.data.map((p: { sku: string }) => p.sku).sort()).toEqual([
      'B-1',
      'L-1',
      'OOS',
      'R-2',
    ]);
  });

  it('combines category and price range — the primary read pattern', async () => {
    const { app } = await seeded();
    const res = await request(app)
      .get('/api/v1/products?category=Running&minPrice=400000&maxPrice=2500000&sort=price:asc')
      .expect(200);

    // Running products are R-1, R-2, R-3 and OOS; only R-2 and R-3 fall in the
    // band. DRAFT is excluded because status defaults to 'active'. This is the
    // exact shape the (category, price_minor, id) index is built for.
    expect(res.body.page.total).toBe(2);
    expect(res.body.data.map((p: { sku: string }) => p.sku)).toEqual(['R-2', 'R-3']);
  });

  it('filters out-of-stock products', async () => {
    const { app } = await seeded();
    const res = await request(app).get('/api/v1/products?inStockOnly=true').expect(200);
    expect(res.body.data.every((p: { inStock: boolean }) => p.inStock)).toBe(true);
    expect(res.body.page.total).toBe(6);
  });

  it('rejects an inverted price range', async () => {
    const { app } = await seeded();
    await request(app).get('/api/v1/products?minPrice=900&maxPrice=100').expect(400);
  });

  it('rejects unknown query parameters', async () => {
    // A typo that silently returns everything is worse than an error.
    const { app } = await seeded();
    await request(app).get('/api/v1/products?categoy=Running').expect(400);
  });

  it('rejects an unsupported sort field', async () => {
    const { app } = await seeded();
    const res = await request(app).get('/api/v1/products?sort=discount:asc').expect(400);
    expect(res.body.error.details[0].message).toMatch(/Unsupported sort field/);
  });

  it('searches full text and ranks by relevance', async () => {
    const { app, db } = await makeApp();
    await insertMany(db, [
      { sku: 'P-1', category: 'Running', price: 100_00, name: 'Nike Pegasus 41' },
      { sku: 'P-2', category: 'Running', price: 100_00, name: 'Nike Structure 25' },
    ]);

    const res = await request(app).get('/api/v1/products?q=pegasus').expect(200);
    expect(res.body.page.total).toBe(1);
    expect(res.body.data[0].name).toContain('Pegasus');
  });
});

describe('GET /api/v1/products — sorting and pagination', () => {
  async function manyProducts(count = 50) {
    const { app, db } = await makeApp();
    await insertMany(
      db,
      Array.from({ length: count }, (_, i) => ({
        sku: `P-${String(i).padStart(3, '0')}`,
        category: i % 2 === 0 ? 'Running' : 'Basketball',
        // Deliberate ties every 10 rows, to prove the id tie-break works.
        price: (i % 10) * 1000_00 + 500_00,
      })),
    );
    return { app, db };
  }

  it('sorts by price ascending and descending', async () => {
    const { app } = await manyProducts();

    const asc = await request(app).get('/api/v1/products?sort=price:asc&limit=50').expect(200);
    const ascAmounts = asc.body.data.map((p: { price: { amount: number } }) => p.price.amount);
    expect([...ascAmounts]).toEqual([...ascAmounts].sort((a: number, b: number) => a - b));

    const desc = await request(app).get('/api/v1/products?sort=price:desc&limit=50').expect(200);
    const descAmounts = desc.body.data.map((p: { price: { amount: number } }) => p.price.amount);
    expect([...descAmounts]).toEqual([...descAmounts].sort((a: number, b: number) => b - a));
  });

  it('clamps limit to the configured ceiling', async () => {
    const { app } = await makeApp({ maxPageSize: 5 });
    const res = await request(app).get('/api/v1/products?limit=500').expect(200);
    expect(res.body.page.limit).toBe(5);
  });

  it('pages by offset and reports a total', async () => {
    const { app } = await manyProducts();

    const first = await request(app).get('/api/v1/products?limit=10&offset=0').expect(200);
    expect(first.body.data).toHaveLength(10);
    expect(first.body.page.total).toBe(50);
    expect(first.body.page.hasMore).toBe(true);

    const last = await request(app).get('/api/v1/products?limit=10&offset=40').expect(200);
    expect(last.body.page.hasMore).toBe(false);
  });

  it('produces disjoint offset pages even when prices tie', async () => {
    // Without the id tie-break, tied rows can appear on two pages while others are
    // never returned at all.
    const { app } = await manyProducts();
    const seen = new Set<string>();

    for (let offset = 0; offset < 50; offset += 10) {
      const res = await request(app)
        .get(`/api/v1/products?sort=price:asc&limit=10&offset=${offset}`)
        .expect(200);
      for (const p of res.body.data) seen.add(p.id);
    }

    expect(seen.size).toBe(50);
  });

  it('walks every row with keyset pagination and no duplicates', async () => {
    const { app } = await manyProducts();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = `/api/v1/products?sort=price:asc&limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res: { body: { data: Array<{ id: string }>; page: { nextCursor: string | null } } } =
        await request(app).get(url).expect(200);

      for (const p of res.body.data) seen.add(p.id);
      cursor = res.body.page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);

    expect(seen.size).toBe(50);
    expect(pages).toBe(5);
  });

  it('skips the count for keyset pages unless asked', async () => {
    // COUNT(*) over a filtered set is the most expensive part of a listing, and a
    // cursor client never needs a page count.
    const { app } = await manyProducts();

    const res = await request(app).get('/api/v1/products?limit=10&cursor=').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    const first = await request(app).get('/api/v1/products?limit=10').expect(200);
    const next = await request(app)
      .get(`/api/v1/products?limit=10&cursor=${encodeURIComponent(first.body.page.nextCursor)}`)
      .expect(200);

    expect(next.body.page.total).toBeNull();
  });

  it('reports a total on demand even with a cursor', async () => {
    const { app } = await manyProducts();
    const first = await request(app).get('/api/v1/products?limit=10').expect(200);

    const next = await request(app)
      .get(
        `/api/v1/products?limit=10&withTotal=true&cursor=${encodeURIComponent(first.body.page.nextCursor)}`,
      )
      .expect(200);

    expect(next.body.page.total).toBe(50);
  });

  it('rejects mixing cursor and offset', async () => {
    const { app } = await manyProducts();
    const res = await request(app).get('/api/v1/products?cursor=abc&offset=10').expect(400);
    expect(res.body.error.details[0].message).toMatch(/not both/);
  });

  it('rejects a malformed cursor rather than returning wrong data', async () => {
    const { app } = await manyProducts();
    await request(app).get('/api/v1/products?cursor=not-a-real-cursor').expect(409);
  });

  it('echoes the resolved query so defaults are visible', async () => {
    const { app } = await manyProducts();
    const res = await request(app).get('/api/v1/products').expect(200);

    expect(res.body.query.filters.status).toEqual(['active']);
    expect(res.body.query.pagination).toBe('offset');
  });
});

describe('GET /api/v1/products/facets', () => {
  it('counts products per category', async () => {
    const { app, db } = await makeApp();
    await insertMany(db, [
      { sku: 'A', category: 'Running', price: 100 },
      { sku: 'B', category: 'Running', price: 200 },
      { sku: 'C', category: 'Basketball', price: 300 },
    ]);

    const res = await request(app).get('/api/v1/products/facets').expect(200);
    expect(res.body.data.categories).toEqual([
      { value: 'Running', count: 2 },
      { value: 'Basketball', count: 1 },
    ]);
  });
});

describe('write protection', () => {
  it('requires the API key for writes when one is configured', async () => {
    const { app } = await makeApp({ apiKey: 'secret' });
    await request(app).post('/api/v1/products').send(sampleProduct).expect(401);
  });

  it('accepts a valid key', async () => {
    const { app } = await makeApp({ apiKey: 'secret' });
    await request(app)
      .post('/api/v1/products')
      .set('x-api-key', 'secret')
      .send(sampleProduct)
      .expect(201);
  });

  it('leaves reads open', async () => {
    const { app } = await makeApp({ apiKey: 'secret' });
    await request(app).get('/api/v1/products').expect(200);
  });
});

describe('caching headers', () => {
  it('marks listings publicly cacheable', async () => {
    // The lever that matters most when reads vastly outnumber writes: a shared
    // cache answers identical requests the database never sees.
    const { app } = await makeApp({ cacheMaxAgeSeconds: 60 });
    const res = await request(app).get('/api/v1/products').expect(200);

    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cache-control']).toContain('max-age=60');
    expect(res.headers['cache-control']).toContain('stale-while-revalidate');
  });
});

describe('unmatched routes', () => {
  it('returns a structured 404 with a request id', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/api/v1/nope').expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
  });
});
