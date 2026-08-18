import { createDbFromEnv } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';

/**
 * Prints query plans and timings for the read patterns the brief names.
 *
 * A benchmark that only reports latency can hide a missing index — at small row
 * counts a sequential scan is fast. The plan is the evidence: it shows *which*
 * index was chosen and whether Postgres had to sort. `npm run explain`.
 */
const QUERIES: Array<{ label: string; sql: string; params: unknown[] }> = [
  {
    label: 'category + price range, ordered by price (the primary read pattern)',
    sql: `SELECT id, name, price_minor FROM products
          WHERE status = 'active' AND category = $1
            AND price_minor BETWEEN $2 AND $3
          ORDER BY price_minor ASC, id ASC
          LIMIT 20`,
    params: ['Running', 500_00, 15_000_00],
  },
  {
    label: 'price range only, no category',
    sql: `SELECT id, name, price_minor FROM products
          WHERE status = 'active' AND price_minor <= $1
          ORDER BY price_minor ASC, id ASC
          LIMIT 20`,
    params: [5_000_00],
  },
  {
    label: 'DEEP offset paging — page 5000 (the anti-pattern)',
    sql: `SELECT id, name, price_minor FROM products
          WHERE status = 'active' AND category = $1
          ORDER BY price_minor ASC, id ASC
          LIMIT 20 OFFSET 100000`,
    params: ['Running'],
  },
  {
    label: 'DEEP keyset paging — equivalent position (the fix)',
    sql: `SELECT id, name, price_minor FROM products
          WHERE status = 'active' AND category = $1
            AND (price_minor, id) > ($2, $3)
          ORDER BY price_minor ASC, id ASC
          LIMIT 20`,
    params: ['Running', 8_000_00, '00000000-0000-0000-0000-000000000000'],
  },
  {
    label: 'full-text search, ranked',
    sql: `SELECT id, name FROM products
          WHERE status = 'active'
            AND search_vector @@ websearch_to_tsquery('simple', $1)
          ORDER BY ts_rank(search_vector, websearch_to_tsquery('simple', $1)) DESC
          LIMIT 20`,
    params: ['pegasus'],
  },
  {
    label: 'facet counts grouped by category',
    sql: `SELECT category, COUNT(*) FROM products
          WHERE status = 'active' GROUP BY category ORDER BY COUNT(*) DESC`,
    params: [],
  },
  {
    label: 'COUNT(*) over a filtered set (why totals are opt-out)',
    sql: `SELECT COUNT(*) FROM products WHERE status = 'active' AND category = $1`,
    params: ['Running'],
  },
];

const { db, driver } = await createDbFromEnv();
await migrate(db);

const total = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM products');
console.log(`\ndriver: ${driver}   rows: ${Number(total.rows[0]?.count ?? 0).toLocaleString()}\n`);

if (Number(total.rows[0]?.count ?? 0) < 1000) {
  console.log('Seed first — plans on a tiny table are meaningless:  npm run seed\n');
}

for (const { label, sql, params } of QUERIES) {
  console.log('─'.repeat(78));
  console.log(label);

  const plan = await db.query<Record<string, string>>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);

  const lines = plan.rows.map((row) => Object.values(row)[0] ?? '');
  // Only the interesting lines: the access method chosen, any sort, and the timing.
  for (const line of lines) {
    if (
      /Scan|Sort|Limit|Aggregate|Execution Time|Planning Time|Heap|Index Cond|Filter/.test(line)
    ) {
      console.log('  ' + line.trim());
    }
  }
  console.log();
}

await db.close();
