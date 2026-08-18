import {
  NotFoundError,
  PreconditionFailedError,
  PreconditionRequiredError,
} from '../domain/errors.js';
import {
  etagFor,
  type NewProduct,
  type Page,
  type Product,
  type ProductPatch,
  type ProductQuery,
} from '../domain/product.js';
import type { ProductRepository } from '../repositories/product.repository.js';

/**
 * Business rules.
 *
 * Rules that must hold no matter who is calling live here. Shape validation
 * ("is price an integer?") belongs at the HTTP boundary; rules that need to
 * consult stored state ("does this version still match?") belong here, because
 * only this layer can reach the repository.
 */
export class ProductService {
  constructor(private readonly repo: ProductRepository) {}

  async search(query: ProductQuery): Promise<Page<Product>> {
    return this.repo.search(query);
  }

  async facets(query: ProductQuery) {
    return this.repo.categoryFacets(query);
  }

  async getById(id: string): Promise<Product> {
    const product = await this.repo.findById(id);
    if (!product) throw new NotFoundError('Product', id);
    return product;
  }

  async getBySku(sku: string): Promise<Product> {
    const product = await this.repo.findBySku(sku);
    if (!product) throw new NotFoundError('Product', sku);
    return product;
  }

  /** Uniqueness is enforced by the database's unique index, which cannot be raced. */
  async create(input: NewProduct): Promise<Product> {
    return this.repo.create(input);
  }

  /**
   * Updates a product, requiring the caller to prove which version they read.
   *
   * `ifMatch` is mandatory rather than optional. Optional would make
   * last-write-wins the default for every client that forgets the header, and
   * those clients would never find out they were silently losing other people's
   * edits. `*` is the explicit way to say "overwrite regardless".
   *
   * A 404 from the guarded UPDATE is ambiguous — the row is either missing or the
   * version moved — so it is disambiguated with a read before answering, to avoid
   * telling a client the product does not exist when it merely changed.
   */
  async update(id: string, patch: ProductPatch, ifMatch: string | undefined): Promise<Product> {
    if (!ifMatch) throw new PreconditionRequiredError();

    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundError('Product', id);

    const currentTag = etagFor(current);
    const wildcard = ifMatch.trim() === '*';

    if (!wildcard && normaliseEtag(ifMatch) !== currentTag) {
      throw new PreconditionFailedError(normaliseEtag(ifMatch), currentTag);
    }

    const updated = await this.repo.update(id, patch, wildcard ? undefined : current.version);

    if (!updated) {
      // The guard failed between the read and the write: someone else committed
      // first. That is exactly what 412 is for.
      const latest = await this.repo.findById(id);
      if (!latest) throw new NotFoundError('Product', id);
      throw new PreconditionFailedError(normaliseEtag(ifMatch), etagFor(latest));
    }

    return updated;
  }

  /** Soft delete — see repository for why the row is kept. */
  async archive(id: string, ifMatch: string | undefined): Promise<Product> {
    return this.update(id, { status: 'archived' }, ifMatch);
  }

  async count(): Promise<number> {
    return this.repo.count();
  }
}

/** `W/"abc"`, `"abc"` and `abc` all compare equal to a stored tag. */
export function normaliseEtag(value: string): string {
  return value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}
