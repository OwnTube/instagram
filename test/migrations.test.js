'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { openDatabase, migrate, appliedMigrations } = require('../src/backend/db');
const { migrations } = require('../src/backend/db/migrations');
const { tempDbFile } = require('./helpers');

test('migrations apply to a fresh database and record themselves', () => {
  const { file, dir } = tempDbFile();
  const db = openDatabase(file);
  const applied = migrate(db);
  assert.deepStrictEqual(applied, migrations.map((m) => m.id));

  const recorded = appliedMigrations(db);
  assert.strictEqual(recorded.length, migrations.length);
  assert.ok(recorded.every((r) => typeof r.applied_at === 'string'));

  db.close();
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});

test('migrations are idempotent', () => {
  const { file, dir } = tempDbFile();
  const db = openDatabase(file);
  migrate(db);
  const second = migrate(db);
  assert.deepStrictEqual(second, [], 'second migrate must apply nothing');

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const expected of ['users', 'posts', 'comments', 'follows', 'sessions', 'messages', 'stories', 'notifications']) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }

  db.close();
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});

test('foreign keys are enforced', () => {
  const { file, dir } = tempDbFile();
  const db = openDatabase(file);
  migrate(db);

  assert.throws(
    () =>
      db
        .prepare('INSERT INTO posts (id, author_id, media_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('p1', 'no-such-user', 'image', new Date().toISOString(), new Date().toISOString()),
    /FOREIGN KEY/i
  );

  db.close();
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});

test('cascade delete removes a user\'s content', () => {
  const { file, dir } = tempDbFile();
  const db = openDatabase(file);
  migrate(db);
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO users (id, username, username_ci, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run('u1', 'u1', 'u1', now, now);
  db.prepare(
    'INSERT INTO posts (id, author_id, media_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run('p1', 'u1', 'image', now, now);

  db.prepare('DELETE FROM users WHERE id = ?').run('u1');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0);

  db.close();
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});

test('unique constraints reject duplicate usernames case-insensitively', () => {
  const { file, dir } = tempDbFile();
  const db = openDatabase(file);
  migrate(db);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO users (id, username, username_ci, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run('u1', 'Alice', 'alice', now, now);

  assert.throws(
    () =>
      db
        .prepare('INSERT INTO users (id, username, username_ci, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('u2', 'ALICE', 'alice', now, now),
    /UNIQUE/i
  );

  db.close();
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});
