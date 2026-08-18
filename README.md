# Product Catalog API

A REST service for an e-commerce product catalog: create, read, update and delete products, and list them with category and price filters plus pagination.

Built for the stated shape of the problem — a few hundred thousand products, reads vastly outnumbering writes, filtering and pagination as the primary access pattern.

**Live: https://nike-catalog.me/api/v1/products** — deployed on every push to `main`.

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
- [Deployment](#deployment)
- [Why Lightsail, and what production would actually look like](#why-lightsail-and-what-production-would-actually-look-like)
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

deploy/
├── nginx.conf                   Local caching reverse proxy — the read-heavy requirement,
│                                  applied. Used by docker-compose.yml
├── nginx.prod.conf              Production nginx: TLS, HSTS, HTTP->HTTPS, ACME challenge
│                                  path, same caching rules. Syntax-checked in CI
├── docker-compose.prod.yml      Server stack: pulls a SHA-pinned image from GHCR, Postgres
│                                  never published to the host, certbot sidecar for renewal
├── bootstrap.sh                 One-time instance setup: Docker, 2 GB swap, log caps, ufw,
│                                  unattended upgrades
├── init-letsencrypt.sh          Issues the first certificate, working around nginx needing
│                                  a cert to start and certbot needing nginx to answer
└── deploy.sh                    Runs on the server: pull, migrate, roll, wait for /ready,
                                   auto-rollback to the previous SHA on failure

Dockerfile                       Multi-stage build, production deps only, non-root, healthcheck
docker-compose.yml               nginx + API + PostgreSQL, the whole read path locally
.github/workflows/ci.yml         Static checks, tests, tests on real PostgreSQL, build, smoke,
                                   Docker with a live cache-HIT assertion, then deploy
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

A sixth job, `deploy`, runs only on a push to `main` and only after all five pass. See below.

---

## Deployment

Live at **https://nike-catalog.me**, on a single Amazon Lightsail instance in `ap-south-1` (Mumbai). Every push to `main` that passes CI redeploys automatically.

### How a deploy works

```
push to main
  → CI: static, tests, tests-on-real-postgres, build+smoke, docker+stack
  → docker job pushes the tested image to ghcr.io/<repo>:<sha>
  → deploy job: scp config → write .env → ssh → deploy.sh <sha>
       ├─ pull the image
       ├─ run migrations (one-off container, idempotent)
       ├─ recreate the API container
       ├─ poll /ready for 30s
       └─ not ready? roll back to the previous SHA
  → smoke test https://nike-catalog.me from the runner (read-only)
```

Three decisions in there are deliberate.

**The image is built in CI, not on the server.** A 2 GB instance running `npm ci` and `tsc` next to Postgres is how a deploy gets OOM-killed. The server only pulls a prebuilt image from GHCR, so a deploy costs it almost nothing.

**Images are tagged with the commit SHA, never just `latest`.** `latest` makes "what is actually running?" unanswerable and rollback a guess. A SHA tag makes rollback a matter of pointing at the previous one — no rebuild, no registry archaeology.

**The image that gets pushed is the exact image that passed the stack test.** It is built once, tagged twice, tested under the local tag, and pushed under the registry tag. Rebuilding for the registry would mean shipping bytes that were never tested.

**Rollback is automatic.** `deploy.sh` records the outgoing SHA before touching anything. If the new container never reports ready within 30 seconds, it restores the previous SHA, waits for that to come back, and exits non-zero. A failed deploy leaves the site up on the last known good version.

**The post-deploy smoke test is read-only.** The full write lifecycle already ran against the throwaway stack in the `docker` job. Repeating it against production would leave an archived test product in the real catalog on every deploy. What the production run does verify is the part CI cannot: that DNS resolves, that the certificate is valid, that nginx is caching (`X-Cache-Status: HIT`), and that unauthenticated writes are refused.

### One-time setup

**1. Lightsail instance.** Mumbai `ap-south-1`, Ubuntu 22.04 or 24.04 LTS, **General purpose, 2 GB RAM / 2 vCPU / 60 GB SSD ($12/month)**.

Not compute-optimized. This workload is I/O- and cache-bound, not CPU-bound: nginx answers most reads from its own cache without waking Node, and the whole table plus all seven indexes is roughly 200 MB, so it lives in RAM. Compute-optimized would cost 3.5× for CPU that idles.

Then attach a **static IP** (free while attached) and open ports 80 and 443 in the Lightsail firewall. The default dynamic IP changes on stop/start, which would silently break DNS.

**2. DNS at Namecheap.** Domain List → Manage → Advanced DNS. Delete the default parking records first — Namecheap ships a `CNAME www → parkingpage.namecheap.com` and a URL-redirect record that will fight your A records.

| Type | Host  | Value          | TTL       |
| ---- | ----- | -------------- | --------- |
| A    | `@`   | your static IP | Automatic |
| A    | `www` | your static IP | Automatic |

Verify before going further, because Let's Encrypt rate-limits failures at five per hostname per hour:

```bash
dig +short nike-catalog.me
```

**3. Bootstrap the server.**

```bash
scp deploy/bootstrap.sh ubuntu@<STATIC_IP>:~
ssh ubuntu@<STATIC_IP> 'sudo bash bootstrap.sh'
```

Installs Docker with the Compose v2 plugin, adds 2 GB of swap, caps container log size, configures `ufw`, enables unattended security upgrades, and creates `/opt/product-catalog`.

The swap line is the most valuable one. On a 2 GB box running Postgres, Node and nginx, a memory spike without swap means the OOM killer — and it usually picks Postgres. Swap turns a hard failure into a slow moment. Capping log size prevents the other classic small-instance death: a full disk three weeks after a successful launch.

**4. GitHub secrets.** Settings → Secrets and variables → Actions.

| Secret              | Value                                     |
| ------------------- | ----------------------------------------- |
| `LIGHTSAIL_HOST`    | The static IP                             |
| `LIGHTSAIL_USER`    | `ubuntu`                                  |
| `LIGHTSAIL_SSH_KEY` | Private key contents, the whole PEM block |
| `POSTGRES_PASSWORD` | Generate one: `openssl rand -base64 32`   |
| `API_KEY`           | Generate one: `openssl rand -hex 32`      |

`GITHUB_TOKEN` is provided automatically and is what authenticates the GHCR push and pull.

Secrets are never committed. CI writes them into `/opt/product-catalog/.env` (mode 600) on every deploy, so rotating one means updating the secret and pushing — not SSHing into a box to edit a file.

**5. First certificate.** Push to `main` once so the compose files land on the server, then:

```bash
ssh ubuntu@<STATIC_IP>
cd /opt/product-catalog
LETSENCRYPT_EMAIL=you@example.com ./init-letsencrypt.sh
```

This is a one-time bootstrap because of a chicken-and-egg problem: nginx will not start with a config pointing at a certificate that does not exist, and certbot cannot answer an HTTP-01 challenge without a web server on port 80. The script plants a self-signed placeholder, starts nginx, swaps in the real certificate, and reloads. Renewal after that is automatic — the certbot sidecar checks twice a day and nginx keeps serving throughout, because challenges are answered from a shared volume rather than by stopping the server.

After that, every push to `main` deploys itself.

### Operating it

```bash
ssh ubuntu@<STATIC_IP>
cd /opt/product-catalog

docker compose -f docker-compose.prod.yml ps            # what is running
docker compose -f docker-compose.prod.yml logs -f api    # tail the API
grep IMAGE_TAG .env                                      # which commit is live
./deploy.sh <older-sha>                                  # manual rollback
```

Postgres is never published to the host — only `expose`, so it is reachable on the compose network and nowhere else. Even if the firewall were later misconfigured, the database is not on the internet.

---

## Why Lightsail, and what production would actually look like

**Lightsail is chosen for cost, and that is the whole reason.** $12/month, flat, predictable, no NAT gateway billing surprises. For a portfolio deployment serving light traffic it is genuinely the right call, and pretending otherwise would be architecture theatre.

It is worth being precise about what that $12 buys and what it does not:

|              | Lightsail today                        | What it costs you                                     |
| ------------ | -------------------------------------- | ----------------------------------------------------- |
| Availability | One instance, one AZ                   | Reboot or hardware failure is downtime                |
| Scaling      | Vertical only                          | A traffic spike needs a resize and a restart          |
| Database     | Postgres in a container beside the app | No automated failover; backups are instance snapshots |
| Cache        | nginx on the same box                  | Cache dies with the instance; no edge presence        |
| Secrets      | `.env` at mode 600                     | No rotation, no audit trail                           |
| Deploys      | Container replace, ~15s gap            | Not zero-downtime                                     |

### The version I would actually run

Roughly $150–250/month, which is precisely why it is not what is running today.

```
                    Route 53
                        │
                   CloudFront            ← edge cache; most reads never go further
                        │
        ┌───────────────┴────────────────┐
        │                                │
  ALB → ECS Fargate (2+ tasks)      S3 (product images)
        │
        ├── ElastiCache Redis            ← hot products by id
        │
        └── RDS PostgreSQL Multi-AZ
                ├── writer
                └── read replica(s)      ← the actual read-scaling mechanism
```

**CloudFront is the single biggest win, and the API is already built for it.** It emits `Cache-Control: public, max-age=60, stale-while-revalidate=30` and a stable ETag on every read. A CDN needs exactly those two things, so the work is done — putting CloudFront in front is configuration, not a rewrite. Reads then get absorbed at the edge, close to the user, and the origin sees a trickle.

Two settings decide whether it helps or silently breaks things:

- **The cache key must include the filter query parameters** (`category`, `brand`, `minPrice`, `maxPrice`, `sort`, `limit`, `cursor`, `offset`). CloudFront ignores the query string by default, which would collapse every filter combination into one cached response and serve running shoes to someone browsing basketball. This is the most common way an API behind a CDN goes wrong.
- **Nothing carrying `X-API-Key` or `Authorization` may be cached.** Writes must reach the origin, and an authenticated response must never be served to another caller.

**Read replicas are the correct answer to "faster reads" for this query pattern**, and the code is already ready for them. Reads and writes go through separate repository methods, so pointing `search` and `findById` at a replica endpoint is a change in one file. That was the point of the `Db` seam.

**ECS Fargate over EC2** because there is no reason to patch an operating system to run one container. **RDS Multi-AZ** for automated failover and point-in-time recovery, which instance snapshots do not give you. **Secrets Manager** instead of a `.env` file, for rotation and an audit trail.

A cheap intermediate step worth naming: **Lightsail's own CDN distribution is $2.50/month** and is CloudFront underneath. It would put the read caching at the edge without leaving Lightsail or the flat-rate pricing.

### On DynamoDB, specifically

The idea of DynamoDB for fast reads plus a separate store for writes, kept in sync, is a real pattern — CQRS with read models. It is worth explaining why I would not reach for it here, because the reasoning matters more than the conclusion.

**DynamoDB is not a read replica.** A read replica is another copy of the same engine, kept current by the database itself, answering the same SQL. DynamoDB is a different database with a different query model. Putting it in the read path is not replication, it is maintaining a second, differently-shaped copy of the catalog — and you own the sync.

**It does not fit this query shape.** The core request is `category = X AND price BETWEEN a AND b ORDER BY price`, paginated. DynamoDB can serve exactly that with a GSI keyed on `category` with `price` as the sort key — genuinely well, in fact. The trouble is everything else the brief implies. Add a brand filter, in-stock, text search, sort by name or newest, and each combination wants its own GSI. DynamoDB's `FilterExpression` is applied _after_ items are read, so you are billed for rows you then discard. Postgres evaluates the same predicates during an index range scan and never materialises them at all. Six GSIs later you have paid write capacity on every one of them for every write, and arbitrary filter combinations still are not covered.

**Syncing two stores buys an eventual-consistency bug surface.** Write to Postgres, stream to DynamoDB, and a client that POSTs and immediately GETs may not see its own write. Replication lag becomes part of the API contract, and every consumer has to reason about it. That is a real cost, and it should buy something.

**Here it buys nothing, because caching already solved the problem.** Reads vastly outnumber writes and a product listing tolerates 60 seconds of staleness. CloudFront plus nginx already absorb the overwhelming majority of reads before they reach the database. Adding DynamoDB solves a problem the cache has already handled while introducing a distributed-systems problem that is entirely new.

**Where DynamoDB would genuinely earn its place** is workloads that are actually key-value shaped, which a filtered catalog listing is not:

- Session state and shopping carts — looked up by one known key, very high rate, no range queries
- Idempotency keys for checkout — single-key writes with a TTL, which DynamoDB does natively
- Inventory counters — atomic increments on a hot single item, where row-level lock contention in Postgres is a real risk
- Clickstream and view events — enormous write volume, no relational shape

So the honest split is not "DynamoDB for reads, Postgres for writes". It is: **Postgres stays the source of truth** for the catalog because the query pattern is relational; **OpenSearch** becomes the query engine once filtering and text search outgrow it, fed by change-data-capture off the Postgres WAL; and **DynamoDB** takes the genuinely key-value workloads alongside them. Each store gets the work it is actually built for, and the catalog listing — the thing this service exists to serve — stays on the index that answers it in 0.68 ms.

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

**Everything runs on one $12 Lightsail box, so a deploy has a ~15 second gap** and an instance failure is downtime. Bought deliberately, for cost. The alternative and its price are laid out above.

**Production secrets live in a `.env` file at mode 600.** No rotation, no audit trail. Secrets Manager is the right answer and costs more than the instance does.

---

## Future developments

Roughly in the order the constraints would actually bite.

**A CDN at the edge.** The cheapest real improvement available: a Lightsail distribution is $2.50/month, CloudFront underneath. The API already emits the `Cache-Control` and ETag headers a CDN needs, so this is configuration rather than code — provided the cache key includes the filter query parameters, which is the one setting that decides whether it works or serves the wrong category to everyone.

**Read replicas.** The `Db` seam already separates reads from writes, so pointing `search` and `findById` at a replica pool is a change in one file. This is the first move when a single instance runs out of headroom, and it is the reason the seam exists.

**Zero-downtime deploys.** Today the container is replaced, which leaves a ~15 second gap. Two API containers behind nginx with a drain-and-swap would close it without leaving one box.

**Materialised view for facet counts,** refreshed on a schedule. Facet counts that are thirty seconds stale are almost never a problem, and it turns the 81 ms scan into an index lookup.

**Elasticsearch or OpenSearch as a search sidecar,** fed from Postgres by change-data-capture off the WAL. Postgres stays the source of truth; the search engine handles typo tolerance, synonyms, faceting and learned ranking. Worth adding when search becomes a feature rather than a filter.

**Redis for hot product reads.** nginx already caches by URL; Redis would cache by product id, which survives across different filter URLs that return the same product.

**DynamoDB for the workloads that are actually key-value shaped** — carts, session state, idempotency keys, inventory counters — rather than as a second copy of the catalog. Reasoning in full above.

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
