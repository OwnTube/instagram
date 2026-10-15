'use strict';

/**
 * Database access layer.
 *
 * Uses `node:sqlite`, the SQLite binding built into Node 24. That choice is
 * deliberate:
 *   - no native compilation and no extra dependency, so the backend stays
 *     deployable in this environment exactly as the loader is;
 *   - real transactions and foreign keys, which the service layer needs for
 *     cross-entity integrity;
 *   - a single file, which suits a single-process deployment.
 *
 * This is the application's own store. It is NOT a copy of Instagram's data and
 * must never be presented as one. Instagram remains the source of truth for
 * anything that mirrors an Instagram entity (see src/backend/db/models.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { migrations } = require('./migrations');

function openDatabase(file) {
  const resolved = file === ':memory:' ? ':memory:' : path.resolve(file);
  if (resolved !== ':memory:') {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Apply any migrations the database has not recorded yet. Returns applied ids. */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id)
  );

  const pending = migrations.filter((m) => !applied.has(m.id));
  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString()
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.id} failed: ${error.message}`);
    }
  }
  return pending.map((m) => m.id);
}

function appliedMigrations(db) {
  return db
    .prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id')
    .all();
}

module.exports = { openDatabase, migrate, appliedMigrations };
