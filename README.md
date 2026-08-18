# Product Catalog API

A REST service for an e-commerce product catalog: create, read, update and delete products, and list them with category and price filters plus pagination.

Built for the stated shape of the problem — a few hundred thousand products, reads vastly outnumbering writes, filtering and pagination as the primary access pattern.

```bash
npm install
npm start          # http://localhost:3000 — no configuration needed
```

`npm start` works on a fresh clone with no database to install and no `.env` to write. The reason why is the first design decision below.

```bash
npm test           # 49 tests against real PostgreSQL
npm run verify     # types, lint, formatting, tests
npm run seed       # 200,000 generated products
npm run explain    # query plans and timings on the seeded data
docker compose up  # nginx + API + PostgreSQL, on :8080
```

---

## Contents

- [The shape of the problem](#the-shape-of-the-problem)
- [Why PostgreSQL](#why-postgresql)
- [How the service runs without installing a database](#how-the-service-runs-without-installing-a-database)
- [The index that does the work](#the-index-that-does-the-work)
- [Pagination: two kinds, and why](#pagination-two-kinds-and-why)
- [Money is an integer](#money-is-an-integer)
- [Serving reads](#serving-reads)
- [Writes: concurrency and deletion](#writes-concurrency-and-deletion)
- [Validation at the boundary](#validation-at-the-boundary)
- [Layout](#layout)
- [API](#api)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Tradeoffs](#tradeoffs)
- [Future developments](#future-developments)

---

## The shape of the problem

Three constraints drive nearly every decision here.

**A few hundred thousand products.** Large enough that the difference between a good query plan and a bad one is the difference between one millisecond and several seconds. Small enough that it fits comfortably on one machine — this does not need sharding, and pretending otherwise would add moving parts that buy nothing.

**Reads vastly outnumber writes.** So reads get the budget: indexes shaped to the exact filters, HTTP caching, a proxy that can answer without touching the application. Writes are allowed to be slower in exchange, which is why there are seven indexes rather than one.

**Filter by category and price range, with pagination.** This is not a general-purpose search problem. It is equality on one column, a range on another, ordered output, in pages. That specific shape has an obvious right answer in a relational database, and it is the reason for the datastore choice.

---

## Why PostgreSQL

The listing query is: match a category, restrict to a price band, sort, return page N. In plain terms, a composite B-tree index turns that into "jump to where the Running shoes start, walk forward in price order until you leave the band, stop after 20 rows". The database reads roughly as many rows as it returns. That property is what keeps the query flat as the catalog grows.

What I considered and did not choose:

**DynamoDB (key-value).** Fast and operationally simple when access patterns are known up front and few. Here clients combine category, brand, price range, stock and text freely. Each new combination is another global secondary index or a full scan with a filter — and a filter in DynamoDB runs _after_ reading, so you pay for rows you discard. Modelling arbitrary filter combinations in a key-value store means rebuilding a query planner by hand.

**MongoDB (document).** A reasonable choice, and it does support compound indexes on the same columns. But the data is uniformly shaped — every product has a SKU, a price, a category — which is the case relational storage is built for. Choosing documents would trade away transactions, joins and constraint enforcement in return for schema flexibility this data does not need.

**Elasticsearch.** Better than Postgres at full-text relevance, and worse as a source of truth: near-real-time indexing means a write is not immediately readable, and there are no transactions. The right use is a sidecar fed from Postgres once search becomes a real feature. Postgres full-text search (included here, `?q=`) is good enough well past the scale in the brief.

**A cache in front, not a different database.** The read-heavy requirement is satisfied by caching, and caching sits _in front of_ the datastore. It is not an argument for changing the datastore.

The deciding factor: a composite index range scan is the cheapest correct way to serve this query, and Postgres has one.

---

## How the service runs without installing a database

`npm start` on a fresh clone works with no PostgreSQL server running. Both drivers sit behind one interface:

```
src/db/client.ts        ->  interface Db { query, exec, transaction, close }
                              PGlite adapter        (development, tests, CI)
                              node-postgres adapter (production)
```

[PGlite](https://pglite.dev) is PostgreSQL compiled to WebAssembly and run in-process. Not a mock, not an emulation — the actual PostgreSQL engine, so the same SQL, the same query planner, the same index types, the same error codes.

Why this matters beyond convenience: the tests exercise real SQL. Mocking the repository would test that the mock behaves like the mock, while the substance of this service _is_ its query behaviour — whether the index is used, whether keyset pagination returns disjoint pages, whether a unique violation surfaces as a 409. Nothing about that is testable against a fake.

The tradeoff is real: PGlite is single-connection with no concurrent-write behaviour to test against, and it is not what production runs. Both gaps are covered by a CI job that runs the same suite against a real PostgreSQL 16 server. "Same engine" is a claim worth verifying rather than trusting.

---

## The index that does the work

```sql
CREATE INDEX products_category_price_idx
  ON products (category, price_minor, id)
  WHERE status = 'active';
```

**Column order is the whole point.** Equality first, range second. Postgres descends to the `category = 'Running'` block, then walks it in `price_minor` order and stops when it leaves the band. Because the walk is already in price order, `ORDER BY price` needs no sort step at all.

Reverse the columns to `(price_minor, category)` and the same query scans every product in the price band across all categories, discarding non-Running rows one at a time. Same columns, same data, dramatically more work.

**`id` last** so the index also satisfies the tie-break (see pagination).

**`WHERE status = 'active'`** makes it a partial index. Drafts and archived products are excluded, so the index is smaller, more of it stays in memory, and the planner does not re-check status on every row. Public listings filter to active by default, so this covers the common case exactly.

Measured on 200,000 seeded products via `npm run explain`:

| Query                                      | Plan                                           | Time         |
| ------------------------------------------ | ---------------------------------------------- | ------------ |
| `category` + price range, ordered by price | `Index Scan using products_category_price_idx` | **0.68 ms**  |
| Price range only, ordered by price         | `Index Scan using products_price_idx`          | **0.42 ms**  |
| Page 5000 via `OFFSET 100000`              | Sort + Bitmap Heap Scan                        | **26.72 ms** |
| Same position via keyset cursor            | `Index Scan`                                   | **0.33 ms**  |
| Full-text search `?q=`                     | Bitmap Index Scan on GIN                       | **25.64 ms** |
| Category facet counts                      | HashAggregate over the table                   | **81.22 ms** |

No sort step appears in the first row of that table. That is the index doing its job.

The last two rows are the honest weak spots. Full-text search at 26 ms is acceptable but is the first thing that would move to a dedicated search engine. Facet counts at 81 ms scan the whole table by necessity — counting every category means visiting every row — which is why they are a separate opt-in endpoint rather than part of every listing response, and why a materialised view is the obvious next step.

---

## Pagination: two kinds, and why

Both are implemented, because they solve different problems and neither is strictly better.

**Offset** — `?limit=20&offset=40`. What a numbered pager needs, and the only way to report "page 3 of 87". It degrades with depth: `OFFSET 100000` makes Postgres walk and discard 100,000 index entries before returning anything. Cost grows with how deep you are. This is the default, because page numbers are what clients expect.

**Keyset** — `?cursor=...`. The cursor carries the last row's sort value and id, so the next page becomes `WHERE (price_minor, id) > (last_price, last_id)` — a fresh index seek that costs the same at page 1 and page 10,000. The measured 0.33 ms versus 26.72 ms above is the same position in the same dataset, reached two ways.

Keyset also fixes a correctness problem, not just a speed one. Under offset pagination, if someone inserts a product while a customer is on page 2, every subsequent page shifts by one and an item is silently skipped. A cursor describes a position in the data rather than a count of rows to skip, so it is immune to that.

What keyset cannot do is jump to an arbitrary page, which is exactly why offset is still here.

**`id` is always the final sort key, in both modes.** Two products at ₹4,999.00 have no defined relative order otherwise, and "no defined order" means Postgres may return them differently between two queries. The consequence is that the same product appears on page 1 and page 2 while a different one is never shown at all. For keyset it is worse: the cursor would not identify a unique position, so a page boundary in the middle of a group of tied prices could skip or repeat the whole group. A test in the suite creates deliberate price ties every ten rows and asserts that paging through all 50 products yields exactly 50 distinct ids.

**`?withTotal=true` is opt-in.** `COUNT(*)` over a filtered set is the most expensive part of a listing — it visits every matching row, while the page itself only needs 20. Offset requests get a total by default because a pager is useless without one; cursor requests do not, because a cursor client has nothing to do with it. A total counts the whole filtered set and deliberately ignores the cursor: "resume from here" should not change what the result set _is_.

---

## Money is an integer

`price_minor BIGINT` — ₹1,299.00 is stored as `129900`, and formatted on the way out.

Floating-point cannot represent most decimal fractions. `0.1 + 0.2` is `0.30000000000000004` in any IEEE-754 language, including JavaScript. In a catalog that produces this:

```js
1499.95 * 7; // 10499.649999999998
1499.95 + 1499.95 + 1499.95 + 1499.95 + 1499.95 + 1499.95 + 1499.95;
// 10499.650000000001
```

Two ways of totalling seven identical items disagree, and neither equals ₹10,499.65. Multiply that across a cart, tax and a discount and you get a total that is off by a paisa — which reconciles against nothing, and is the kind of bug that surfaces in accounting weeks later rather than in a test.

Integers have no such failure mode: `129900 * 7` is exact, always. Every currency has a smallest indivisible unit, so an integer count of those units is not a workaround — it is the honest data type. Rounding still happens, but only once, deliberately, at the point of display.

`NUMERIC` would also be exact and is the textbook answer. `BIGINT` is chosen over it because this is the second column of the hot composite index: `NUMERIC` is variable-length with slower comparisons, while `BIGINT` is a fixed 8 bytes and compares in one instruction. On the one query that matters most, that difference is worth having.

The API enforces this rather than trusting it — a request with `"amount": 1299.99` is rejected with a 400 pointing at `price.amount`, instead of being silently truncated.

---

## Serving reads

**`Cache-Control: public, max-age=60, stale-while-revalidate=30`** on product listings. This is the highest-leverage line in the codebase for a read-heavy service: a response that a shared cache can reuse for 60 seconds means the origin sees one request instead of a thousand. `stale-while-revalidate` lets a cache serve the slightly-stale copy _immediately_ while refreshing in the background, so no customer waits for the refresh.

**ETags and conditional GETs.** Every product carries an ETag derived from `id:version`, where `version` increments on every write. A client sending `If-None-Match` gets a 304 with no body when nothing has changed — the row is still read, but the payload is not serialised or transferred.

The ETag comes from the version counter rather than a hash of the content, because the counter already exists and is guaranteed to change on write. A timestamp would be wrong: two writes within the same millisecond would produce identical ETags, and a client would cache a stale product indefinitely.

**nginx as a caching reverse proxy** (`deploy/nginx.conf`). A cached GET never reaches Node and never touches Postgres. Notable settings and their reasons:

- `proxy_cache_key` includes the query string, so each filter combination caches separately.
- `proxy_cache_lock on` — when an entry expires, one request repopulates it and the rest wait, instead of all of them stampeding the origin at once.
- `proxy_cache_use_stale ... http_502 http_503` — if the API is down, keep serving the last known good response. For a product catalog, a 60-second-old price beats an error page.
- `/health` and `/ready` are proxied explicitly and never cached. A cached readiness probe reports the state of a process that may have died since — worse than having no probe at all.
- `X-Cache-Status` is exposed on every response, so `HIT` versus `MISS` is observable rather than assumed. CI asserts on it.

**Rate limiting** per IP, and pagination limits clamped rather than rejected — `?limit=5000` returns the 100-item maximum instead of a 400, because the useful response to an over-large request is data, not an error.

---

## Writes: concurrency and deletion

**`If-Match` is required on `PATCH`, not optional.** Without an `If-Match` header the request is refused with `428 Precondition Required`; with a stale one, `412 Precondition Failed`; `If-Match: *` explicitly opts out.

Two staff members editing the same product is not an edge case, it is a Tuesday. If the header were optional, the default behaviour would be last-write-wins — one person's change silently erasing another's, with no error anywhere. Requiring it makes the conflict visible to the client that caused it. `*` exists so a deliberate force-overwrite is still possible, but it has to be asked for.

The check and the write are one statement:

```sql
UPDATE products SET ..., version = version + 1
WHERE id = $1 AND version = $2
```

`WHERE version = $2` and `version = version + 1` in the same statement means the compare and the write are atomic without an explicit transaction. Two concurrent updates cannot both match the same version, so exactly one wins and the other gets a 412.

**Delete is a soft delete** — `status` becomes `archived`. Catalog rows are referenced by order history, analytics and search indexes; removing the row orphans all of it, so a customer's two-year-old order can no longer say what was in it. Archiving hides the product from default listings while keeping it addressable by id. `DELETE` returns `200` with the archived product rather than `204`, because there is still a representation to return and the client should see the new state.

**SKU uniqueness is enforced by a unique index**, not by checking first. `SELECT` then `INSERT` has a gap between the two statements in which another request can insert the same SKU; the index is the only authority that cannot be raced. The 23505 violation is caught and translated into a `409`. The index is on `lower(sku)`, so `NIKE-AM90` and `nike-am90` collide — and lookups use the same expression, so they stay index lookups rather than full scans.

---

## Validation at the boundary

Every request is parsed by a [Zod](https://zod.dev) schema before it reaches business logic. In plain terms: incoming JSON is untyped and could contain anything, and a schema is a description of the acceptable shape that also produces a typed value. One declaration gives both the runtime check and the TypeScript type, so the two cannot drift apart — TypeScript alone disappears at compile time and checks nothing about what actually arrives over the network.

**Schemas are `.strict()`, so unknown fields are rejected.** A request with `"pirce"` or `?categoy=Running` returns a 400 naming the offending key. The alternative — ignoring what you do not recognise — means a client sends a filter, gets a 200, and receives the whole unfiltered catalog believing it was filtered. A typo that silently returns the wrong data is far worse than one that fails loudly.

Validation also spans fields: `minPrice` above `maxPrice` is rejected as a range that cannot match anything, rather than returning an empty list that looks like "no products found".

Errors have one shape everywhere, with a machine-readable code and a path to the offending field:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "path": "price.amount", "message": "Price must be an integer number of minor units" }
    ]
  }
}
```

---

## Layout

Each layer depends only on the one beneath it. A route never writes SQL; the repository never knows what HTTP is.

```
src/
├── server.ts                    Process entry: reads env, opens the DB, migrates, listens,
│                                  and shuts down cleanly on SIGTERM
├── app.ts                       Composition root — builds the DB, repository, service and
│                                  routes and wires them together. The only place that knows
│                                  how the layers connect, which is what lets tests swap the
│                                  database without touching anything else
├── config.ts                    All environment reading, in one file. Nothing deeper touches
│                                  process.env, so every knob is discoverable in one place
│
├── db/
│   ├── schema.sql               Table, constraints and the seven indexes, each with a comment
│   │                             explaining the query it serves
│   ├── client.ts                The Db seam: one interface, two adapters (PGlite for
│   │                             dev/test, node-postgres for production)
│   ├── migrate.ts               Applies schema.sql. Idempotent, so restarts and scale-ups
│   │                             are safe
│   └── seed.ts                  Generates N realistic products with a seeded PRNG, so the
│                                 same COUNT always produces the same catalog. Batched
│                                 inserts, then ANALYZE so the planner has real statistics
│
├── domain/
│   ├── product.ts               The Product type, Money as integer minor units, cursor
│   │                             encode/decode, ETag derivation, row-to-domain mapping.
│   │                             No SQL, no HTTP — pure rules
│   └── errors.ts                Typed errors (NotFound, Conflict, PreconditionFailed...)
│                                 that carry the HTTP status they map to, so handlers stay
│                                 free of status-code branching
│
├── repositories/
│   └── product.repository.ts    All SQL. Filtering, ordering and pagination happen here,
│                                 in the database. The interface is what the service depends
│                                 on, so swapping datastores means writing one class
│
├── services/
│   └── product.service.ts       Use cases and rules that are not the database's job:
│                                 SKU conflicts, ETag comparison, archive-vs-delete
│
└── http/
    ├── schemas.ts               Zod request schemas — the trust boundary. Everything past
    │                             this point is validated and typed
    ├── product.routes.ts        Route handlers: parse, delegate, set cache headers, respond
    └── middleware.ts            Rate limiting, API-key check on writes, request logging,
                                  and the single error handler that turns typed errors into
                                  the one error response shape

tests/
├── helpers.ts                   Builds an app on a fresh in-memory PostgreSQL per test, so
│                                 tests share no state and can run in parallel
└── products.api.test.ts         49 tests driving the real app over HTTP against real SQL

scripts/
├── explain.ts                   EXPLAIN ANALYZE harness — prints the plans and timings in
│                                 the table above. Turns "this index helps" into a number
└── smoke.mjs                    Post-deploy checks over a real socket: header casing, 304s,
                                  412/428 preconditions, cache headers

deploy/nginx.conf                Caching reverse proxy — the read-heavy requirement, applied
Dockerfile                       Multi-stage build, production deps only, non-root, healthcheck
docker-compose.yml               nginx + API + PostgreSQL, the whole read path locally
.github/workflows/ci.yml         Static checks, tests, tests on real PostgreSQL, build, smoke,
                                   Docker, and a live cache-HIT assertion
```

---

## API

Base path `/api/v1`.

| Method   | Path                          | Notes                                               |
| -------- | ----------------------------- | --------------------------------------------------- |
| `GET`    | `/products`                   | Filter, sort, paginate                              |
| `GET`    | `/products/:id`               | Supports `If-None-Match` → 304                      |
| `GET`    | `/products/facets/categories` | Category counts for the current filters             |
| `POST`   | `/products`                   | 201 with `Location` and `ETag`. Defaults to `draft` |
| `PATCH`  | `/products/:id`               | Requires `If-Match`                                 |
| `DELETE` | `/products/:id`               | Soft delete → `archived`                            |
| `GET`    | `/health`                     | Liveness. Does not touch the database               |
| `GET`    | `/ready`                      | Readiness. Runs a real query                        |

### Listing parameters

| Parameter               | Example              | Notes                                             |
| ----------------------- | -------------------- | ------------------------------------------------- |
| `category`              | `Running,Basketball` | Comma-separated values are ORed                   |
| `brand`                 | `Nike`               | ANDed with other filters                          |
| `minPrice` / `maxPrice` | `100000`             | Minor units, inclusive                            |
| `inStockOnly`           | `true`               | `stock > 0`                                       |
| `q`                     | `pegasus`            | Full-text over name, brand, category, description |
| `status`                | `active`             | Defaults to `active`, so drafts never leak        |
| `sort`                  | `price:asc`          | `price`, `name`, `createdAt`, `relevance`         |
| `limit`                 | `20`                 | Clamped to `MAX_PAGE_SIZE`                        |
| `offset`                | `40`                 | Mutually exclusive with `cursor`                  |
| `cursor`                | opaque               | Keyset pagination                                 |
| `withTotal`             | `true`               | Opt in to `COUNT(*)`                              |

```bash
# The primary read pattern
curl "localhost:3000/api/v1/products?category=Running&minPrice=500000&maxPrice=1500000&sort=price:asc&limit=20"

# Deep pagination without the offset penalty
curl "localhost:3000/api/v1/products?limit=20&cursor=WyIxMjk5MDAiLCJhYmMt..."
```

Responses separate the data from the page metadata, and echo back how the query was interpreted — so a client can see that `categoy` was not silently ignored:

```json
{
  "data": [
    {
      "id": "...",
      "sku": "...",
      "price": { "amount": 129900, "currency": "INR" },
      "priceFormatted": "₹1,299.00"
    }
  ],
  "page": { "limit": 20, "total": 2162, "nextCursor": "WyIx...", "hasMore": true },
  "query": {
    "filters": { "category": ["Running"], "minPrice": 500000 },
    "sort": { "field": "price", "direction": "asc" }
  }
}
```

---

## Testing

49 tests, all against a real PostgreSQL engine. They cover the behaviour that is easy to get wrong rather than restating the implementation:

- Category and price-range filtering, including rows sitting exactly on both bounds — an off-by-one there silently drops the products priced at precisely the number the customer typed.
- Offset paging with deliberate price ties every ten rows, asserting 50 distinct ids across 5 pages. This fails without the `id` tie-break.
- Keyset paging walking the full set with no duplicates and no gaps.
- `withTotal` with a cursor returning the size of the whole filtered set, not the rows remaining after the cursor.
- 400s for unknown query parameters, unsupported sort fields, inverted price ranges and fractional prices.
- 409 on duplicate SKU regardless of case; 428/412/200 across the `If-Match` cases; 304 on conditional GET.
- Full-text search ranked by relevance.

`scripts/smoke.mjs` adds 24 checks over a real socket, because in-process tests skip real HTTP: header casing, wire status codes, actual 304 handling. It earned its place immediately — it caught that `tsc` does not copy `schema.sql` into `dist/`, so the compiled image would have started, passed every test, and failed to migrate. No in-process test could have found that.

---

## CI/CD

`.github/workflows/ci.yml`, cheapest checks first so a formatting error fails in under a minute rather than after a Docker build.

| Job             | What it proves                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static`        | Prettier, ESLint and `tsc --noEmit` are clean                                                                                                                                      |
| `test`          | 49 tests pass on PGlite — the same command a contributor runs locally                                                                                                              |
| `test-postgres` | The same suite against real PostgreSQL 16, then seed 50,000 rows and verify the query plans still use the indexes                                                                  |
| `build`         | `tsc` emits a runnable `dist/server.js`, and the compiled server passes the smoke suite over real HTTP                                                                             |
| `docker`        | The image builds, runs as a non-root user, and the full nginx + API + PostgreSQL stack passes smoke _through the proxy_ — then asserts `X-Cache-Status: HIT` on a repeated request |

Two of those exist because of specific failure modes. `build` asserts `dist/server.js` exists, since `tsc` exiting 0 does not prove it emitted what the Dockerfile runs. `docker` smoke-tests through nginx rather than against the API directly, because that is the only way to catch a proxy rule that swallows `/ready` or strips a header — a mistake that leaves every test green while production health checks fail.

---

## Tradeoffs

Things that are deliberately not free.

**Seven indexes make writes slower.** Every insert updates all of them. Correct for reads ≫ writes, and it would be the wrong call for a write-heavy system.

**PGlite in development is not PostgreSQL in production.** Single-connection, no concurrent-write behaviour to test against. Mitigated by the real-PostgreSQL CI job, not by pretending the gap is not there.

**Facet counts scan the table** — 81 ms on 200k rows. They are a separate opt-in endpoint rather than part of every listing response for exactly this reason.

**Full-text search is Postgres, not Elasticsearch.** 26 ms and no typo tolerance, no synonyms, no learned ranking. Right for now; the first thing to outgrow.

**Requiring `If-Match` makes `PATCH` less convenient.** A caller must read before writing. That is the cost of not making silent overwrites the default.

**Soft delete means archived rows stay in the table** and every default query carries a status filter. Paid for by partial indexes, which exclude those rows from the indexes entirely.

**Cached responses can be up to 60 seconds stale.** Fine for a catalog. Not fine for stock levels during a launch, which would need a shorter TTL or explicit invalidation on write.

**A single Postgres instance is a single point of failure.** Correct at this scale; the fix is a read replica, and the code is already replica-ready because reads and writes go through separate methods.

---

## Future developments

Roughly in the order the constraints would actually bite.

**Read replicas.** The `Db` seam already separates reads from writes, so pointing `search` and `findById` at a replica pool is a change in one file. This is the first move when a single instance runs out of headroom, and it is the reason the seam exists.

**Materialised view for facet counts,** refreshed on a schedule. Facet counts that are thirty seconds stale are almost never a problem, and it turns the 81 ms scan into an index lookup.

**Elasticsearch as a search sidecar,** fed from Postgres via logical replication. Postgres stays the source of truth; ES handles typo tolerance, synonyms and learned ranking. Worth adding when search becomes a feature rather than a filter.

**Redis for hot product reads.** nginx already caches by URL; Redis would cache by product id, which survives across different filter URLs that return the same product.

**Cache invalidation on write.** Today freshness comes from a 60-second TTL. Purging the affected keys on write would let the TTL rise substantially, cutting origin traffic further.

**Bulk endpoints.** A catalog import that creates 10,000 products currently means 10,000 requests. `POST /products/batch` inside one transaction, with per-item results.

**Partitioning by category** if the table reaches tens of millions of rows. Not before — partitioning adds real complexity and buys nothing at this scale.

**Metrics and tracing.** Structured logs exist; Prometheus histograms per route and OpenTelemetry spans around queries are what turn "it feels slow" into a specific slow query.

**Author-based authorisation.** Writes currently take a shared API key. Real deployment needs per-user identity and an audit trail of who changed which price.

---

## Configuration

Every value has a working default; the service starts with no `.env`. See `.env.example`.

| Variable            | Default          | Purpose                                                |
| ------------------- | ---------------- | ------------------------------------------------------ |
| `PORT`              | `3000`           | HTTP port                                              |
| `DATABASE_URL`      | unset            | Set to use a real PostgreSQL server; unset uses PGlite |
| `PGLITE_DATA_DIR`   | `./.data/pglite` | Where PGlite stores data                               |
| `DEFAULT_PAGE_SIZE` | `20`             | Page size when `limit` is omitted                      |
| `MAX_PAGE_SIZE`     | `100`            | Ceiling; larger requests are clamped                   |
| `CACHE_MAX_AGE`     | `60`             | Seconds a GET stays fresh in a shared cache            |
| `RATE_LIMIT`        | `600`            | Requests per minute per IP                             |
| `API_KEY`           | unset            | When set, writes require `X-API-Key`                   |
