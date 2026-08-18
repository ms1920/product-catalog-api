import { Router, type Request } from 'express';
import type { Config } from '../config.js';
import { ValidationError } from '../domain/errors.js';
import { etagFor, formatMoney, type Product } from '../domain/product.js';
import type { ProductService } from '../services/product.service.js';
import { asyncHandler, requireApiKey } from './middleware.js';
import { createProductSchema, parseProductQuery, updateProductSchema } from './schemas.js';

/**
 * Routes are a thin translation layer: parse and validate, call the service, shape
 * the response. No business logic, which keeps handlers boring and leaves the
 * service independently testable.
 */
export function productRoutes(service: ProductService, config: Config): Router {
  const router = Router();
  const authed = requireApiKey(config);

  /**
   * Products are enriched on read with derived fields. Computed, never stored, so
   * they cannot drift from the values they are derived from.
   */
  const present = (product: Product) => ({
    ...product,
    inStock: product.stock > 0,
    priceFormatted: formatMoney(product.price),
  });

  /**
   * GET /products — the hot path.
   *
   * `Cache-Control: public` matters more here than anywhere else in the service:
   * reads vastly outnumber writes, so letting a shared cache (nginx here, a CDN in
   * production) answer identical listing requests removes load the database never
   * has to see. `stale-while-revalidate` lets the cache serve the previous
   * response while it refreshes, so a cache miss never becomes a latency spike for
   * the user who happened to arrive at expiry.
   */
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = parseProductQuery(req.query, config);
      const result = await service.search(query);

      res.setHeader(
        'Cache-Control',
        `public, max-age=${config.cacheMaxAgeSeconds}, stale-while-revalidate=30`,
      );

      res.json({
        data: result.data.map(present),
        page: result.page,
        // Echoing the resolved query makes the API self-documenting: a client can
        // see exactly which defaults and clamps were applied to its request.
        query: {
          q: query.q ?? null,
          filters: {
            category: query.category ?? null,
            brand: query.brand ?? null,
            status: query.status ?? null,
            minPrice: query.minPrice ?? null,
            maxPrice: query.maxPrice ?? null,
            inStockOnly: query.inStockOnly ?? false,
          },
          sort: query.sort,
          pagination: query.cursor ? 'keyset' : 'offset',
        },
      });
    }),
  );

  /** Facet counts. Registered before `/:id` so "facets" is not read as an id. */
  router.get(
    '/facets',
    asyncHandler(async (req, res) => {
      const query = parseProductQuery(req.query, config);
      res.setHeader('Cache-Control', `public, max-age=${config.cacheMaxAgeSeconds}`);
      res.json({ data: { categories: await service.facets(query) } });
    }),
  );

  router.get(
    '/sku/:sku',
    asyncHandler(async (req, res) => {
      const product = await service.getBySku(pathParam(req, 'sku'));
      res.setHeader('ETag', `"${etagFor(product)}"`);
      res.json({ data: present(product) });
    }),
  );

  /**
   * GET /products/:id
   *
   * Returns an ETag, which does double duty: it is the token a client must echo in
   * `If-Match` to update the product, and it enables conditional GETs — an
   * unchanged product costs a 304 with no body rather than re-serialising and
   * re-transferring the whole thing. On a read-heavy service that is free
   * bandwidth.
   */
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const product = await service.getById(pathParam(req, 'id'));
      const tag = etagFor(product);

      res.setHeader('ETag', `"${tag}"`);
      res.setHeader('Cache-Control', `public, max-age=${config.cacheMaxAgeSeconds}`);

      const ifNoneMatch = req.header('if-none-match');
      if (ifNoneMatch && normalise(ifNoneMatch) === tag) {
        res.status(304).end();
        return;
      }

      res.json({ data: present(product) });
    }),
  );

  router.post(
    '/',
    authed,
    asyncHandler(async (req, res) => {
      const input = createProductSchema.parse(req.body);
      const created = await service.create(input);

      // 201 + Location is the correct contract for resource creation.
      res
        .status(201)
        .location(`/api/v1/products/${created.id}`)
        .setHeader('ETag', `"${etagFor(created)}"`);
      res.json({ data: present(created) });
    }),
  );

  /**
   * PATCH /products/:id — requires `If-Match`.
   *
   * PATCH rather than PUT: a catalog update is almost always a few fields, and PUT
   * semantics would require the client to send the whole product and risk erasing
   * fields it did not know about.
   */
  router.patch(
    '/:id',
    authed,
    asyncHandler(async (req, res) => {
      const patch = updateProductSchema.parse(req.body);
      const updated = await service.update(pathParam(req, 'id'), patch, req.header('if-match'));

      res.setHeader('ETag', `"${etagFor(updated)}"`);
      res.json({ data: present(updated) });
    }),
  );

  /** Soft delete: status becomes `archived`. See the repository for why. */
  router.delete(
    '/:id',
    authed,
    asyncHandler(async (req, res) => {
      const archived = await service.archive(pathParam(req, 'id'), req.header('if-match'));
      res.json({ data: present(archived) });
    }),
  );

  return router;
}

/** Express 5 types path params as possibly undefined; narrow once, at the edge. */
function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`Missing or invalid path parameter '${name}'`, { param: name });
  }
  return value;
}

function normalise(value: string): string {
  return value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}
