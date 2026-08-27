import migration0001Sql from '../migrations/0001_init.sql?raw';
import migration0002Sql from '../migrations/0002_run_candidates_and_claims.sql?raw';

/**
 * Splits a migration file's text into runnable statements: comment lines
 * stripped, then split on `;`. The `?raw` import above is what gets each
 * migration file's text into the test's module bundle at all - this suite
 * runs inside the Workers runtime, where `node:fs` only sees that bundle,
 * not the real filesystem. `applyD1Migrations` is not used instead because
 * it needs a Node-side `readD1Migrations()` wired into vitest.config.ts as a
 * bound migrations array.
 */
function statementsFrom(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const ALTER_ADD_COLUMN_RE = /ALTER TABLE (\w+) ADD COLUMN (\w+)/i;

async function columnExists(db: D1Database, table: string, column: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT count(*) AS n FROM pragma_table_info(?) WHERE name = ?`)
    .bind(table, column)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

/**
 * Applies both migrations to `db`. Safe to call once per test even though
 * the schema persists across tests within a file (only each file's own
 * `resetSchema()` clears rows between tests): 0001 is naturally idempotent -
 * every statement is `CREATE TABLE IF NOT EXISTS` - but 0002's `ALTER TABLE
 * ... ADD COLUMN` cannot say the same, since SQLite has no `IF NOT EXISTS`
 * there (deliberately - see that migration's header comment). So an `ADD
 * COLUMN` statement whose column already exists is skipped rather than run
 * and its error swallowed: a future migration that genuinely tries to add
 * the same column twice should still fail loudly, not disappear into a
 * broad catch. The column check is generic (a regex over the statement, not
 * a match on `claimed_at` by name), so the next migration that adds a column
 * inherits this for free.
 */
export async function applySchema(db: D1Database): Promise<void> {
  for (const stmt of [...statementsFrom(migration0001Sql), ...statementsFrom(migration0002Sql)]) {
    const match = ALTER_ADD_COLUMN_RE.exec(stmt);
    if (match !== null) {
      const table = match[1];
      const column = match[2];
      if (table !== undefined && column !== undefined && (await columnExists(db, table, column))) continue;
    }
    await db.prepare(stmt).run();
  }
}
