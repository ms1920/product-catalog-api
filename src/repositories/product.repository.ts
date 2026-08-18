import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { ConflictError } from '../domain/errors.js';
import {
  decodeCursor,
  encodeCursor,
  rowToProduct,
  type NewProduct,
  type Page,
  type Product,
  type ProductPatch,
  type ProductQuery,
  type ProductRow,
} from '../domain/product.js';

/**
 * Persistence boundary.
 *
 * The service depends on this interface, never on SQL. Swapping Postgres for
 * something else means writing one class; the layers above do not change.
 */
export interface ProductRepository {
  search(query: ProductQuery): Promise<Page<Product>>;
  findById(id: string): Promise<Product | null>;
  findBySku(sku: string): Promise<Product | null>;
  create(input: NewProduct): Promise<Product>;
  /** `expectedVersion` enforces optimistic concurrency when supplied. */
  update(id: string, patch: ProductPatch, expectedVersion?: number): Promise<Product | null>;
  archive(id: string, expectedVersion?: number): Promise<Product | null>;
  hardDelete(id: string): Promise<boolean>;
  categoryFacets(query: ProductQuery): Promise<Array<{ value: string; count: number }>>;
  count(): Promise<number>;
}

const SELECT_COLUMNS = `
  id, sku, name, description, brand, category,
  price_minor, currency, stock, status, attributes,
  created_at, updated_at, version
`;

export class PostgresProductRepository implements ProductRepository {
  constructor(private readonly db: Db) {}

  /**
   * The hot path.
   *
   * Filtering, ordering and pagination all happen in SQL. Doing any of it in
   * application code would mean transferring rows only to discard them — at a few
   * hundred thousand products that is the difference between a millisecond and
   * multiple seconds, and it does not degrade gracefully.
   *
   * Two pagination modes, because they solve different problems:
   *
   *   - **Offset** (`?offset=`) is what a numbered pager needs and can report a
   *     total page count. It degrades on deep pages: `OFFSET 100000` makes
   *     Postgres walk and discard 100,000 index entries before returning
   *     anything, so cost grows with depth.
   *   - **Keyset** (`?cursor=`) carries the last row's sort value and id, turning
   *     the next page into `WHERE (sort, id) > (last_sort, last_id)` — a fresh
   *     index seek that costs the same at page 1 and page 10,000. It cannot jump
   *     to an arbitrary page, and it is immune to items shifting between pages
   *     when the catalog changes mid-scroll.
   *
   * Offset is the default because clients expect page numbers; keyset is there for
   * the deep-scroll and export cases where offset falls over.
   */
  async search(query: ProductQuery): Promise<Page<Product>> {
    const params: unknown[] = [];
    const filters: string[] = [];

    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    // Status defaults to 'active' at the HTTP boundary, so drafts and archived
    // rows cannot leak into a public listing by omission.
    if (query.status?.length) {
      filters.push(`status = ANY(${bind(query.status)})`);
    }

    // ANY($n) rather than an interpolated IN list: one prepared statement shape
    // serves any number of values, so Postgres can reuse the plan instead of
    // recompiling for every distinct filter count.
    if (query.category?.length) filters.push(`category = ANY(${bind(query.category)})`);
    if (query.brand?.length) filters.push(`brand = ANY(${bind(query.brand)})`);

    if (query.minPrice !== undefined) filters.push(`price_minor >= ${bind(query.minPrice)}`);
    if (query.maxPrice !== undefined) filters.push(`price_minor <= ${bind(query.maxPrice)}`);
    if (query.inStockOnly) filters.push('stock > 0');

    const terms = query.q?.trim();
    // The placeholder is captured rather than assumed: the term's position depends
    // on how many filters precede it, so hardcoding `$1` in the ORDER BY would
    // silently rank by whichever parameter happened to land first.
    let termPlaceholder: string | undefined;
    if (terms) {
      // websearch_to_tsquery accepts what a person actually types — quoted
      // phrases, `-excluded` — and does not throw on syntax a user invented,
      // unlike to_tsquery which rejects a bare `&`.
      termPlaceholder = bind(terms);
      filters.push(`search_vector @@ websearch_to_tsquery('simple', ${termPlaceholder})`);
    }

    // Everything bound so far describes *what matches*. The count reuses exactly
    // this prefix, so it cannot drift out of step with the page query.
    const filterSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const filterParams = params.slice();

    const { orderBy, sortColumn } = this.resolveOrder(query, termPlaceholder);

    // Keyset predicate. Row-value comparison `(a, b) > (x, y)` is what makes this
    // a single index seek; expanding it into `a > x OR (a = x AND b > y)` is
    // logically equivalent but the planner handles it far less well.
    //
    // It narrows the *page*, never the total: a cursor means "resume here", so a
    // client asking for a total still wants the size of the whole result set, not
    // the number of rows left ahead of it.
    const pageFilters = filters.slice();
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (!decoded) throw new ConflictError('Malformed cursor', { cursor: query.cursor });

      const comparison = query.sort.direction === 'asc' ? '>' : '<';
      pageFilters.push(
        `(${sortColumn}, id) ${comparison} (${bind(decoded.sortValue)}, ${bind(decoded.id)})`,
      );
    }

    const pageSql = pageFilters.length ? `WHERE ${pageFilters.join(' AND ')}` : '';

    // Fetch one extra row to learn whether another page exists, instead of
    // issuing a second COUNT to answer the same question.
    const limitParam = bind(query.limit + 1);
    const offsetSql = query.cursor ? '' : ` OFFSET ${bind(query.offset)}`;

    const rows = await this.db.query<ProductRow>(
      `SELECT ${SELECT_COLUMNS} FROM products ${pageSql} ${orderBy} LIMIT ${limitParam}${offsetSql}`,
      params,
    );

    const hasMore = rows.rows.length > query.limit;
    const pageRows = hasMore ? rows.rows.slice(0, query.limit) : rows.rows;
    const products = pageRows.map(rowToProduct);

    let total: number | null = null;
    if (query.withTotal) {
      // Deliberately a separate statement. Combining it as a window function
      // (`COUNT(*) OVER ()`) forces Postgres to materialise the entire matching
      // set even when only 20 rows are wanted, which is slower than two queries
      // once the filtered set is large.
      const counted = await this.db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM products ${filterSql}`,
        filterParams,
      );
      total = Number(counted.rows[0]?.total ?? 0);
    }

    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(this.cursorValueOf(last, query), last.id) : null;

    return { data: products, page: { limit: query.limit, total, nextCursor, hasMore } };
  }

  /**
   * Order clause, matched to the indexes.
   *
   * `id` is always the final sort key. Without it two rows sharing a price have no
   * defined relative order, so the same row can appear on page 1 and page 2 while
   * another is never shown — and keyset pagination breaks outright, since the
   * cursor would not identify a unique position.
   */
  private resolveOrder(
    query: ProductQuery,
    termPlaceholder: string | undefined,
  ): { orderBy: string; sortColumn: string } {
    const dir = query.sort.direction === 'asc' ? 'ASC' : 'DESC';

    switch (query.sort.field) {
      case 'price':
        return {
          orderBy: `ORDER BY price_minor ${dir}, id ${dir}`,
          sortColumn: 'price_minor',
        };
      case 'name':
        return { orderBy: `ORDER BY name ${dir}, id ${dir}`, sortColumn: 'name' };
      case 'createdAt':
        return {
          orderBy: `ORDER BY created_at ${dir}, id ${dir}`,
          sortColumn: 'created_at',
        };
      case 'relevance':
        // Relevance is meaningless without a query, so it degrades to
        // newest-first rather than returning an arbitrary order.
        if (!termPlaceholder) {
          return { orderBy: 'ORDER BY created_at DESC, id DESC', sortColumn: 'created_at' };
        }
        return {
          orderBy:
            `ORDER BY ts_rank(search_vector, websearch_to_tsquery('simple', ${termPlaceholder})) DESC,` +
            ' created_at DESC, id DESC',
          sortColumn: 'created_at',
        };
    }
  }

  private cursorValueOf(row: ProductRow, query: ProductQuery): string | number {
    switch (query.sort.field) {
      case 'price':
        return typeof row.price_minor === 'string' ? Number(row.price_minor) : row.price_minor;
      case 'name':
        return row.name;
      default:
        return new Date(row.created_at).toISOString();
    }
  }

  async findById(id: string): Promise<Product | null> {
    const result = await this.db.query<ProductRow>(
      `SELECT ${SELECT_COLUMNS} FROM products WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToProduct(row) : null;
  }

  async findBySku(sku: string): Promise<Product | null> {
    // lower(sku) matches the functional unique index, so this is an index lookup
    // rather than a sequential scan with a per-row function call.
    const result = await this.db.query<ProductRow>(
      `SELECT ${SELECT_COLUMNS} FROM products WHERE lower(sku) = lower($1)`,
      [sku],
    );
    const row = result.rows[0];
    return row ? rowToProduct(row) : null;
  }

  async create(input: NewProduct): Promise<Product> {
    const id = randomUUID();
    try {
      const result = await this.db.query<ProductRow>(
        `INSERT INTO products
           (id, sku, name, description, brand, category,
            price_minor, currency, stock, status, attributes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING ${SELECT_COLUMNS}`,
        [
          id,
          input.sku,
          input.name,
          input.description,
          input.brand,
          input.category,
          input.price.amount,
          input.price.currency,
          input.stock,
          input.status,
          JSON.stringify(input.attributes ?? {}),
        ],
      );
      return rowToProduct(result.rows[0]!);
    } catch (error) {
      // Let the database decide uniqueness rather than checking first. A
      // check-then-insert has a race between the two statements; the unique index
      // is the only authority that cannot be raced.
      if (isUniqueViolation(error)) {
        throw new ConflictError(`A product with SKU '${input.sku}' already exists`, {
          sku: input.sku,
        });
      }
      throw error;
    }
  }

  /**
   * Partial update with optional optimistic concurrency.
   *
   * `version = version + 1` and the `WHERE version = $n` guard are in the same
   * statement, so the check and the write are atomic without an explicit
   * transaction — two concurrent updates cannot both succeed.
   */
  async update(id: string, patch: ProductPatch, expectedVersion?: number): Promise<Product | null> {
    const sets: string[] = [];
    const params: unknown[] = [];

    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (patch.name !== undefined) sets.push(`name = ${bind(patch.name)}`);
    if (patch.description !== undefined) sets.push(`description = ${bind(patch.description)}`);
    if (patch.brand !== undefined) sets.push(`brand = ${bind(patch.brand)}`);
    if (patch.category !== undefined) sets.push(`category = ${bind(patch.category)}`);
    if (patch.stock !== undefined) sets.push(`stock = ${bind(patch.stock)}`);
    if (patch.status !== undefined) sets.push(`status = ${bind(patch.status)}`);
    if (patch.price !== undefined) {
      sets.push(`price_minor = ${bind(patch.price.amount)}`);
      sets.push(`currency = ${bind(patch.price.currency)}`);
    }
    if (patch.attributes !== undefined) {
      sets.push(`attributes = ${bind(JSON.stringify(patch.attributes))}`);
    }

    if (sets.length === 0) return this.findById(id);

    sets.push('updated_at = now()');
    sets.push('version = version + 1');

    const idParam = bind(id);
    const versionGuard =
      expectedVersion !== undefined ? ` AND version = ${bind(expectedVersion)}` : '';

    const result = await this.db.query<ProductRow>(
      `UPDATE products SET ${sets.join(', ')}
       WHERE id = ${idParam}${versionGuard}
       RETURNING ${SELECT_COLUMNS}`,
      params,
    );

    const row = result.rows[0];
    return row ? rowToProduct(row) : null;
  }

  /**
   * Soft delete.
   *
   * Catalog rows are referenced by orders, analytics and search indexes, so
   * removing the row orphans that history. Archiving hides it from default
   * listings — which filter to `status = 'active'` — while keeping it addressable
   * by id, so an old order can still resolve what was bought.
   */
  async archive(id: string, expectedVersion?: number): Promise<Product | null> {
    return this.update(id, { status: 'archived' }, expectedVersion);
  }

  /** Present for completeness and for tests; not exposed over HTTP. */
  async hardDelete(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM products WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  /**
   * Facet counts for the current filter set.
   *
   * Grouped in the database, not in application code: counting 300,000 rows in
   * Node would mean fetching 300,000 rows. At larger scale this becomes a
   * materialised view refreshed on a schedule, since a facet count that is
   * seconds stale is almost never a problem.
   */
  async categoryFacets(query: ProductQuery): Promise<Array<{ value: string; count: number }>> {
    const params: unknown[] = [];
    const where: string[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.status?.length) where.push(`status = ANY(${bind(query.status)})`);
    if (query.brand?.length) where.push(`brand = ANY(${bind(query.brand)})`);
    if (query.minPrice !== undefined) where.push(`price_minor >= ${bind(query.minPrice)}`);
    if (query.maxPrice !== undefined) where.push(`price_minor <= ${bind(query.maxPrice)}`);
    if (query.inStockOnly) where.push('stock > 0');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await this.db.query<{ category: string; count: string }>(
      `SELECT category, COUNT(*)::text AS count
       FROM products ${whereSql}
       GROUP BY category
       ORDER BY COUNT(*) DESC, category ASC`,
      params,
    );

    return result.rows.map((row) => ({ value: row.category, count: Number(row.count) }));
  }

  async count(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM products',
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}

/** 23505 is Postgres' unique_violation; PGlite reports the same code. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;

  const message = error instanceof Error ? error.message : '';
  return /duplicate key value|unique constraint/i.test(message);
}
