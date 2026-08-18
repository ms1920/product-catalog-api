-- Catalog schema.
--
-- Shaped by three stated facts: a few hundred thousand products, reads vastly
-- outnumbering writes, and filtering by category and price range with pagination.
-- Every index below exists to serve that read pattern; nothing is indexed
-- speculatively, because each index is write amplification and memory it has to
-- earn back on reads.

CREATE TABLE IF NOT EXISTS products (
  id          UUID PRIMARY KEY,

  -- Business identifier, distinct from the surrogate key. Clients and warehouse
  -- systems quote SKUs; nothing external should depend on our row id.
  sku         TEXT NOT NULL,

  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  brand       TEXT NOT NULL,
  category    TEXT NOT NULL,

  -- Price in the currency's minor unit (paise/cents) as a BIGINT.
  --
  -- Not NUMERIC and definitely not DOUBLE PRECISION. Floating point cannot
  -- represent most decimal fractions exactly, so seven line items of 1499.95
  -- summed disagree with 1499.95 multiplied by seven — a total that is wrong by a
  -- fraction reaches customers. NUMERIC is exact but is variable-length and
  -- slower to compare, which matters when it is the second column of the hot
  -- index. An integer is exact, fixed-width, and compares in one instruction.
  price_minor BIGINT NOT NULL CHECK (price_minor >= 0),
  currency    CHAR(3) NOT NULL DEFAULT 'INR',

  -- Denormalised total across variants. Kept here rather than summed from a
  -- child table on every read because `in_stock_only` is a filter on the hot
  -- path, and a correlated subquery there would defeat the index.
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),

  -- Matches the API's default deliberately: a newly created product is a draft
  -- until someone publishes it, so a POST cannot put an unfinished listing in
  -- front of customers. If this default disagreed with the one in the request
  -- schema, rows inserted outside the API would silently become public.
  status      TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('active', 'draft', 'archived')),

  attributes  JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Monotonic counter backing the ETag, incremented on every write.
  --
  -- A version column rather than a timestamp because two updates inside the same
  -- millisecond would share a timestamp, and the second would be able to
  -- overwrite the first while presenting a matching If-Match.
  version     INTEGER NOT NULL DEFAULT 1
);

-- Case-insensitive uniqueness. A functional unique index rather than a UNIQUE
-- constraint on the raw column, so 'nike-am90' and 'NIKE-AM90' cannot both exist.
CREATE UNIQUE INDEX IF NOT EXISTS products_sku_key ON products (lower(sku));

-- ---------------------------------------------------------------------------
-- Read-path indexes
-- ---------------------------------------------------------------------------

-- THE index for the primary query: filter by category, range on price, ordered.
--
-- Column order is the whole design. Postgres can use a composite B-tree for
-- equality on leading columns plus a range on the first inequality, then stop.
-- With (category, price_minor) a query like
--   WHERE category = 'Running' AND price_minor BETWEEN x AND y ORDER BY price_minor
-- becomes one contiguous index range scan that is *already sorted*, so there is
-- no sort step and no heap visit for ordering. Reversing the columns to
-- (price_minor, category) would force a scan of every row in the price band
-- followed by a filter, which is dramatically worse when a category is selective.
--
-- `id` is the trailing column so it can act as the tie-break for keyset
-- pagination without a second lookup.
CREATE INDEX IF NOT EXISTS products_category_price_idx
  ON products (category, price_minor, id)
  WHERE status = 'active';

-- Partial on status = 'active' because that is the default every public listing
-- applies. Excluding drafts and archived rows from the index makes it smaller,
-- so more of it stays cached, and the planner does not have to re-check status.

-- Price-only range scans, for "everything under Rs 5,000" with no category.
CREATE INDEX IF NOT EXISTS products_price_idx
  ON products (price_minor, id)
  WHERE status = 'active';

-- Newest-first listings, the other common default ordering.
CREATE INDEX IF NOT EXISTS products_created_idx
  ON products (created_at DESC, id DESC)
  WHERE status = 'active';

-- Brand is lower cardinality than category and usually combined with it, so it
-- gets its own entry point rather than being wedged into the composite above.
CREATE INDEX IF NOT EXISTS products_brand_price_idx
  ON products (brand, price_minor, id)
  WHERE status = 'active';

-- Full-text search over name, brand and description, weighted so a name match
-- outranks a description match.
--
-- GIN, not GiST: GIN is slower to update and larger, but substantially faster to
-- search, and this catalog is read-heavy by definition. Generated rather than
-- maintained by a trigger so it cannot drift from the row it describes.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(brand, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS products_search_idx ON products USING GIN (search_vector);

-- Supports the facet counts the UI needs ("Running (1,284)") without a sequential
-- scan per request.
CREATE INDEX IF NOT EXISTS products_status_category_idx
  ON products (status, category);
