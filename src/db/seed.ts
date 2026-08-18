import { randomUUID } from 'node:crypto';
import { createDbFromEnv, type Db } from './client.js';
import { migrate } from './migrate.js';

/**
 * Generates a catalog at the scale the brief describes.
 *
 * The default is 200,000 products, because "a few hundred thousand" is the stated
 * scale and index behaviour is only interesting at scale. With a few dozen rows
 * Postgres ignores every index and sequentially scans, so a benchmark on a small
 * fixture would measure nothing and would happily hide a missing index.
 *
 *   npm run seed              # 200,000
 *   COUNT=500000 npm run seed
 */

const CATEGORIES = [
  'Running',
  'Basketball',
  'Lifestyle',
  'Training',
  'Football',
  'Tennis',
  'Skateboarding',
  'Apparel',
  'Accessories',
  'Outdoor',
];

const BRANDS = ['Nike', 'Jordan', 'Converse', 'Adidas', 'Puma', 'New Balance', 'Asics', 'Reebok'];

const LINES = [
  'Air Max',
  'Air Force',
  'Pegasus',
  'Vaporfly',
  'Metcon',
  'Dunk',
  'Blazer',
  'Cortez',
  'Invincible',
  'Structure',
  'Alphafly',
  'Mercurial',
  'Phantom',
  'Tiempo',
  'Zoom',
];

const COLOURWAYS = [
  'Black/White',
  'White/Volt',
  'Navy/Crimson',
  'Grey/Pink',
  'Olive/Sail',
  'Royal/Gold',
  'Triple Black',
  'Bone/Rust',
  'Teal/Coral',
  'Sand/Chocolate',
];

/**
 * Deterministic pseudo-random generator.
 *
 * A seeded LCG rather than `Math.random` so the dataset is reproducible: the same
 * COUNT always produces the same catalog. That matters because benchmark numbers
 * are only comparable across runs if the data is identical, and a flaky test on
 * random data is impossible to debug.
 */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export async function seed(db: Db, count: number): Promise<void> {
  const random = makeRandom(42);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

  // Batched multi-row INSERT. One statement per row would mean `count` round trips;
  // at 200,000 rows that is the difference between seconds and many minutes. 1,000
  // is a deliberate ceiling — Postgres has a 65,535 bind-parameter limit, and at 11
  // parameters per row a larger batch would exceed it.
  const BATCH = 1000;
  const COLUMNS = 11;

  const startedAt = Date.now();
  let inserted = 0;

  for (let offset = 0; offset < count; offset += BATCH) {
    const rows = Math.min(BATCH, count - offset);
    const values: unknown[] = [];
    const placeholders: string[] = [];

    for (let i = 0; i < rows; i += 1) {
      const n = offset + i;
      const line = pick(LINES);
      const category = pick(CATEGORIES);
      const brand = pick(BRANDS);
      const colourway = pick(COLOURWAYS);

      // Prices skewed toward the low end, as a real catalog is: many affordable
      // items, few premium. A uniform distribution would make every price-range
      // filter equally selective and hide how the index behaves on realistic data.
      const tier = random();
      const priceMinor =
        tier < 0.55
          ? Math.floor(199_00 + random() * 4_800_00)
          : tier < 0.9
            ? Math.floor(5_000_00 + random() * 10_000_00)
            : Math.floor(15_000_00 + random() * 15_000_00);

      // ~8% out of stock, so `inStockOnly` filters something.
      const stock = random() < 0.08 ? 0 : Math.floor(random() * 200);
      // ~5% not active, so the default status filter is doing visible work.
      const status = random() < 0.05 ? (random() < 0.5 ? 'draft' : 'archived') : 'active';

      const base = i * COLUMNS;
      placeholders.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`,
      );

      values.push(
        randomUUID(),
        `${brand.toUpperCase().replace(/\s+/g, '')}-${line.toUpperCase().replace(/\s+/g, '')}-${n}`,
        `${brand} ${line} ${100 + (n % 900)}`,
        `${brand} ${line} in ${colourway}. Built for ${category.toLowerCase()}.`,
        brand,
        category,
        priceMinor,
        'INR',
        stock,
        status,
        JSON.stringify({ colourway, generated: true }),
      );
    }

    await db.query(
      `INSERT INTO products
         (id, sku, name, description, brand, category, price_minor, currency, stock, status, attributes)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );

    inserted += rows;
    if (inserted % 25_000 === 0 || inserted === count) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'seeding',
          inserted,
          of: count,
          elapsedSeconds: elapsed,
        }),
      );
    }
  }

  // Without fresh statistics the planner works from defaults and can pick a
  // sequential scan over a perfectly good index. Bulk loads must always be
  // followed by ANALYZE.
  await db.query('ANALYZE products');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = Number(process.env.COUNT ?? 200_000);
  const { db, driver } = await createDbFromEnv();

  await migrate(db);
  const before = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM products');

  if (Number(before.rows[0]?.count ?? 0) >= count) {
    console.log(
      JSON.stringify({ level: 'info', msg: 'already seeded', products: before.rows[0]?.count }),
    );
  } else {
    console.log(JSON.stringify({ level: 'info', msg: 'seeding', driver, target: count }));
    await seed(db, count);
  }

  const after = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM products');
  console.log(
    JSON.stringify({ level: 'info', msg: 'seed complete', products: after.rows[0]?.count }),
  );
  await db.close();
}
