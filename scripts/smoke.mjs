/**
 * Smoke test against a running server.
 *
 * Unit tests drive the app in-process, which skips real HTTP: header casing,
 * status codes on the wire, JSON serialisation, conditional-request handling. This
 * exercises the actual socket, so CI catches a build that compiles and passes
 * tests but does not serve.
 *
 *   BASE_URL=http://localhost:3000 node scripts/smoke.mjs
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Waits for readiness, not just for the port to accept a connection.
 *
 * A 200 alone is not enough: a proxy misconfigured to serve something else on
 * /ready also returns 200. Requiring JSON with status 'ready' means the check
 * fails loudly instead of passing against the wrong thing.
 */
async function waitForReady(attempts = 60) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(`${BASE}/ready`);
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && type.includes('application/json')) {
        const body = await res.json();
        if (body.status === 'ready') return body;
        throw new Error(`unexpected body: ${JSON.stringify(body)}`);
      }
      throw new Error(`status ${res.status}, content-type '${type}'`);
    } catch (error) {
      if (i === attempts) {
        console.error(`Server never became ready at ${BASE}: ${error.message}`);
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  console.log(`Smoke testing ${BASE}`);
  const ready = await waitForReady();
  check('/ready reports ready with a row count', typeof ready.products === 'number');

  const health = await fetch(`${BASE}/health`);
  check('/health returns 200', health.status === 200);
  check(
    '/health is JSON, not an HTML fallback',
    (health.headers.get('content-type') ?? '').includes('application/json'),
  );

  // --- Write path -----------------------------------------------------------
  const sku = `SMOKE-${Date.now()}`;
  const createRes = await fetch(`${BASE}/api/v1/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sku,
      name: 'Smoke Test Runner',
      description: 'Created by the CI smoke test.',
      brand: 'Nike',
      category: 'Running',
      price: { amount: 1_299_00, currency: 'INR' },
      stock: 5,
      // Explicit, because the default is 'draft'. A POST does not publish a
      // product; this smoke test wants it visible in listings, so it says so.
      status: 'active',
    }),
  });
  check('POST creates a product', createRes.status === 201, `got ${createRes.status}`);

  const created = await createRes.json();
  const id = created?.data?.id;
  const etag = createRes.headers.get('etag');
  check('POST returns a Location header', Boolean(createRes.headers.get('location')));
  check('POST returns an ETag', Boolean(etag));
  check('price round-trips as integer minor units', created?.data?.price?.amount === 1_299_00);

  // --- Read path ------------------------------------------------------------
  const getRes = await fetch(`${BASE}/api/v1/products/${id}`);
  check('GET by id returns 200', getRes.status === 200);
  check(
    'GET sets a shared Cache-Control',
    (getRes.headers.get('cache-control') ?? '').includes('max-age'),
    getRes.headers.get('cache-control') ?? 'absent',
  );

  const notModified = await fetch(`${BASE}/api/v1/products/${id}`, {
    headers: { 'if-none-match': etag },
  });
  check('conditional GET returns 304', notModified.status === 304, `got ${notModified.status}`);

  const listRes = await fetch(
    `${BASE}/api/v1/products?category=Running&minPrice=100000&maxPrice=200000&limit=5`,
  );
  const list = await listRes.json();
  check('filtered list returns 200', listRes.status === 200);
  check('filtered list is paginated', list?.page?.limit === 5, JSON.stringify(list?.page));
  check(
    'filtered list contains the new product',
    list?.data?.some((p) => p.sku === sku),
  );

  // --- Concurrency ----------------------------------------------------------
  const noMatch = await fetch(`${BASE}/api/v1/products/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stock: 9 }),
  });
  check('PATCH without If-Match is refused', noMatch.status === 428, `got ${noMatch.status}`);

  const stale = await fetch(`${BASE}/api/v1/products/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'if-match': '"deadbeefdeadbeefdead"' },
    body: JSON.stringify({ stock: 9 }),
  });
  check('PATCH with a stale ETag returns 412', stale.status === 412, `got ${stale.status}`);

  const patched = await fetch(`${BASE}/api/v1/products/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'if-match': etag },
    body: JSON.stringify({ stock: 9 }),
  });
  check('PATCH with the current ETag succeeds', patched.status === 200, `got ${patched.status}`);
  const patchedBody = await patched.json();
  check('version increments on write', patchedBody?.data?.version === 2);

  // --- Validation -----------------------------------------------------------
  const badSort = await fetch(`${BASE}/api/v1/products?sort=discount:asc`);
  check('unsupported sort field returns 400', badSort.status === 400);

  const typo = await fetch(`${BASE}/api/v1/products?categoy=Running`);
  check('unknown query parameter returns 400', typo.status === 400);

  const inverted = await fetch(`${BASE}/api/v1/products?minPrice=900&maxPrice=100`);
  check('inverted price range returns 400', inverted.status === 400);

  // --- Delete ---------------------------------------------------------------
  const del = await fetch(`${BASE}/api/v1/products/${id}`, {
    method: 'DELETE',
    headers: { 'if-match': patched.headers.get('etag') },
  });
  // 200 with a body, not 204: this is a soft delete, so there is still a
  // representation to return and the client should see the new state.
  check('DELETE returns 200', del.status === 200, `got ${del.status}`);
  const deleted = await del.json();
  check('DELETE archives rather than destroying', deleted?.data?.status === 'archived');

  // Still addressable by id — an old order must be able to resolve what was
  // bought — but no longer present in the default listing.
  const afterDelete = await fetch(`${BASE}/api/v1/products/${id}`);
  check('archived product is still retrievable by id', afterDelete.status === 200);

  const afterList = await fetch(`${BASE}/api/v1/products?category=Running&limit=100`);
  const afterListBody = await afterList.json();
  check(
    'archived product is gone from the default listing',
    !afterListBody?.data?.some((p) => p.sku === sku),
  );

  console.log(
    failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
