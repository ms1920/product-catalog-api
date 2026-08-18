import { createHash } from 'node:crypto';

/**
 * The domain vocabulary. Pure types and pure functions — no SQL, no HTTP.
 *
 * Keeping this layer free of I/O is what lets the business rules be tested
 * without a database and reused by anything that is not an HTTP request.
 */

export const PRODUCT_STATUSES = ['active', 'draft', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * Money as an integer in the currency's minor unit.
 *
 * `amount: 1329500` is ₹13,295.00. Floats cannot represent most decimal
 * fractions exactly, so seven line items of 1499.95 summed disagree with
 * 1499.95 × 7 — a total wrong by a fraction of a paisa that reaches a customer.
 * Integers are exact up to 2^53, and ₹1 crore is only 10^9 paise.
 */
export interface Money {
  amount: number;
  currency: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  brand: string;
  category: string;
  price: Money;
  stock: number;
  status: ProductStatus;
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Monotonic write counter. Backs the ETag. */
  version: number;
}

export type NewProduct = Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'version'>;

/** SKU is immutable once assigned: it is an external identifier others quote. */
export type ProductPatch = Partial<Omit<NewProduct, 'sku'>>;

export const SORTABLE_FIELDS = ['price', 'name', 'createdAt', 'relevance'] as const;
export type SortField = (typeof SORTABLE_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

export interface ProductQuery {
  q?: string;
  category?: string[];
  brand?: string[];
  status?: ProductStatus[];
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  sort: { field: SortField; direction: SortDirection };
  limit: number;
  /** Offset paging. Mutually exclusive with `cursor`. */
  offset: number;
  /** Keyset paging. Preferred for deep pages — see repository. */
  cursor?: string;
  /**
   * Offset paging needs a total to render "page 4 of 87"; keyset paging does not.
   * `COUNT(*)` over a filtered set is the single most expensive part of a listing
   * request, so it is opt-out.
   */
  withTotal: boolean;
}

export interface PageInfo {
  limit: number;
  /** Null when the count was skipped. */
  total: number | null;
  /** Opaque token for the next page; null at the end. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Page<T> {
  data: T[];
  page: PageInfo;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function formatMoney(money: Money, locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
  }).format(money.amount / 100);
}

/**
 * ETag for a product.
 *
 * Derived from id and version rather than hashing the whole row: the version
 * counter already changes on every write, so this is cheap and cannot collide for
 * two different states of the same product.
 */
export function etagFor(product: Pick<Product, 'id' | 'version'>): string {
  return createHash('sha1').update(`${product.id}:${product.version}`).digest('hex').slice(0, 20);
}

/**
 * Encodes a keyset cursor.
 *
 * Base64url of the sort value plus the row id. Opaque on purpose: a client that
 * cannot parse it cannot come to depend on its shape, which leaves the sort
 * implementation free to change.
 */
export function encodeCursor(sortValue: string | number, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { sortValue: string | number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;

    const [sortValue, id] = parsed;
    if (typeof id !== 'string') return null;
    if (typeof sortValue !== 'string' && typeof sortValue !== 'number') return null;

    return { sortValue, id };
  } catch {
    return null;
  }
}

/** Maps a database row to the domain shape. */
export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string;
  brand: string;
  category: string;
  price_minor: string | number;
  currency: string;
  stock: number;
  status: ProductStatus;
  attributes: Record<string, unknown> | string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

export function rowToProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    brand: row.brand,
    category: row.category,
    price: {
      // BIGINT arrives as a string from node-postgres, because a 64-bit integer
      // does not always fit a JS number. Prices are far below 2^53, so the
      // conversion is safe here — but it has to be deliberate rather than implicit.
      amount: typeof row.price_minor === 'string' ? Number(row.price_minor) : row.price_minor,
      currency: row.currency.trim(),
    },
    stock: row.stock,
    status: row.status,
    attributes:
      typeof row.attributes === 'string'
        ? (JSON.parse(row.attributes) as Record<string, unknown>)
        : row.attributes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    version: row.version,
  };
}
