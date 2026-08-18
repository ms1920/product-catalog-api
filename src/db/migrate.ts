import { createDbFromEnv, loadSchemaSql, type Db } from './client.js';

/**
 * Applies the schema.
 *
 * Idempotent — every statement is `IF NOT EXISTS` — so running it twice is safe and
 * it can be invoked unconditionally at container start. That is deliberate: a
 * migration step that must only run once needs orchestration, and orchestration
 * that can be skipped is orchestration that will be.
 *
 * A production system outgrows this and wants versioned, ordered migrations with a
 * recorded history (node-pg-migrate, Flyway). The tradeoff is stated in the README
 * rather than pretended away.
 */
export async function migrate(db: Db): Promise<void> {
  const sql = await loadSchemaSql();
  await db.exec(sql);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { db, driver } = await createDbFromEnv();
  await migrate(db);
  console.log(JSON.stringify({ level: 'info', msg: 'schema applied', driver }));
  await db.close();
}
