import { z } from 'zod';
import { PRODUCT_STATUSES, SORTABLE_FIELDS, type ProductQuery } from '../domain/product.js';
import type { Config } from '../config.js';

/**
 * Request validation, using Zod.
 *
 * TypeScript's types are erased at compile time, so they cannot check a JSON body
 * arriving over the network — at runtime that data is simply `unknown`. Zod checks
 * the real shape while the program runs and the TypeScript type is inferred from
 * the same declaration, so one definition serves both.
 *
 * This is the only layer that touches untrusted input. Everything below assumes
 * its inputs are already well-formed, which is what keeps defensive checks out of
 * the service and repository.
 */

const moneySchema = z.object({
  // Integer minor units. Rejecting a float here is what keeps 19.999 out of the
  // database instead of discovering it in a total later.
  amount: z
    .number()
    .int('must be an integer number of minor units, e.g. 129900 for ₹1,299.00')
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  currency: z
    .string()
    .length(3, 'must be a 3-letter ISO 4217 code')
    .transform((c) => c.toUpperCase()),
});

export const createProductSchema = z
  .object({
    sku: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5000).default(''),
    brand: z.string().trim().min(1).max(100),
    category: z.string().trim().min(1).max(100),
    price: moneySchema,
    stock: z.number().int().nonnegative().default(0),
    status: z.enum(PRODUCT_STATUSES).default('draft'),
    attributes: z.record(z.unknown()).default({}),
  })
  // `.strict()` rejects unknown fields rather than silently dropping them, so a
  // client sending `{"pirce": 100}` is told about the typo instead of quietly
  // creating a product with no price.
  .strict();

/**
 * PATCH: every field optional, but an empty body is rejected.
 *
 * `{}` is almost always a client bug, and answering 200 hides it. SKU is absent
 * because it is immutable — an external identifier other systems quote.
 */
export const updateProductSchema = createProductSchema
  .omit({ sku: true })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Body must contain at least one field to update',
  });

/** `?a=1&a=2` arrives as an array, `?a=1,2` as a string. Normalise both. */
const csvList = z.union([z.string(), z.array(z.string())]).transform((value) =>
  (Array.isArray(value) ? value : value.split(','))
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean),
);

const intString = z.string().regex(/^\d+$/, 'must be a non-negative integer').transform(Number);
const boolString = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const rawQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    category: csvList.optional(),
    brand: csvList.optional(),
    status: csvList.optional(),
    minPrice: intString.optional(),
    maxPrice: intString.optional(),
    inStockOnly: boolString.optional(),
    sort: z.string().optional(),
    limit: intString.optional(),
    offset: intString.optional(),
    cursor: z.string().min(1).max(500).optional(),
    withTotal: boolString.optional(),
  })
  // Strict here too: a mistyped filter that silently returns the whole catalog is
  // worse than an error, because the caller believes the filter was applied.
  .strict();

function parseSort(raw: string | undefined) {
  if (!raw) return { field: 'relevance' as const, direction: 'desc' as const };

  const [field, direction = 'asc'] = raw.split(':');
  const parsedField = z.enum(SORTABLE_FIELDS).safeParse(field);
  if (!parsedField.success) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['sort'],
        message: `Unsupported sort field '${field}'. Allowed: ${SORTABLE_FIELDS.join(', ')}`,
      },
    ]);
  }

  const parsedDirection = z.enum(['asc', 'desc']).safeParse(direction);
  if (!parsedDirection.success) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['sort'],
        message: `Unsupported sort direction '${direction}'. Allowed: asc, desc`,
      },
    ]);
  }

  return { field: parsedField.data, direction: parsedDirection.data };
}

/**
 * Builds a fully-defaulted query. Two defaults are load-bearing:
 *
 *  - `status` defaults to `['active']`, so drafts and archived products cannot
 *    appear in a public listing because someone omitted a parameter.
 *  - `limit` is clamped to the configured ceiling rather than rejected, so a
 *    slightly-too-large request still succeeds. The ceiling exists so a client
 *    cannot ask for a million rows and use the API against itself.
 */
export function parseProductQuery(raw: unknown, config: Config): ProductQuery {
  const parsed = rawQuerySchema.parse(raw);

  if (parsed.cursor && parsed.offset !== undefined) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['cursor'],
        message: 'Use either cursor or offset, not both — they are different pagination modes',
      },
    ]);
  }

  if (
    parsed.minPrice !== undefined &&
    parsed.maxPrice !== undefined &&
    parsed.minPrice > parsed.maxPrice
  ) {
    throw new z.ZodError([{ code: 'custom', path: ['minPrice'], message: 'must be <= maxPrice' }]);
  }

  const status = parsed.status
    ? z.array(z.enum(PRODUCT_STATUSES)).parse(parsed.status.map((s) => s.toLowerCase()))
    : (['active'] as const);

  return {
    q: parsed.q,
    category: parsed.category,
    brand: parsed.brand,
    status: [...status],
    minPrice: parsed.minPrice,
    maxPrice: parsed.maxPrice,
    inStockOnly: parsed.inStockOnly,
    sort: parseSort(parsed.sort),
    limit: Math.min(parsed.limit ?? config.defaultPageSize, config.maxPageSize),
    offset: parsed.offset ?? 0,
    cursor: parsed.cursor,
    // Counting is opt-out: COUNT(*) over a filtered set is the most expensive
    // part of a listing request, and keyset clients never need it.
    withTotal: parsed.withTotal ?? !parsed.cursor,
  };
}
