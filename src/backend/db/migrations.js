'use strict';

/**
 * Versioned schema migrations.
 *
 * Each migration is applied once, inside a transaction, and recorded in
 * schema_migrations. Migrations are append-only: never edit an applied one,
 * add a new one.
 *
 * Data model notes that matter for correctness:
 *
 *   - `users` is the APPLICATION's own account. It is not an Instagram account
 *     and holds no Instagram credential. `upstream_identity` records, at most,
 *     that an operator explicitly linked an Instagram username; it never stores
 *     a token or password.
 *
 *   - Content tables (posts, comments, stories, messages) hold data created in
 *     THIS application. There is no path by which Instagram's private content
 *     arrives here, and no endpoint fabricates it. Anything that would require
 *     Instagram's authoritative data is reported as unavailable instead.
 *
 *   - Every content table carries an owner (author_id / owner_id) and the
 *     service layer scopes every read by that owner, which is what makes
 *     cross-user isolation testable rather than aspirational.
 */

const migrations = [
  {
    id: '0001_core',
    up(db) {
      db.exec(`
        CREATE TABLE users (
          id             TEXT PRIMARY KEY,
          username       TEXT NOT NULL,
          username_ci    TEXT NOT NULL UNIQUE,
          email          TEXT,
          email_ci       TEXT UNIQUE,
          password_hash  TEXT,
          password_salt  TEXT,
          password_params TEXT,
          display_name   TEXT,
          bio            TEXT,
          avatar_url     TEXT,
          is_private     INTEGER NOT NULL DEFAULT 0,
          status         TEXT NOT NULL DEFAULT 'active',
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );

        CREATE TABLE upstream_identity (
          user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          instagram_username TEXT NOT NULL,
          link_state     TEXT NOT NULL DEFAULT 'declared',
          note           TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );

        CREATE TABLE sessions (
          id             TEXT PRIMARY KEY,
          user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash     TEXT NOT NULL UNIQUE,
          csrf_secret    TEXT NOT NULL,
          user_agent     TEXT,
          created_at     TEXT NOT NULL,
          last_seen_at   TEXT NOT NULL,
          expires_at     TEXT NOT NULL,
          revoked_at     TEXT
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_sessions_expires ON sessions(expires_at);

        CREATE TABLE posts (
          id          TEXT PRIMARY KEY,
          author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          caption     TEXT,
          media_url   TEXT,
          media_type  TEXT NOT NULL DEFAULT 'image',
          location    TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          deleted_at  TEXT
        );
        CREATE INDEX idx_posts_author_created ON posts(author_id, created_at DESC);
        CREATE INDEX idx_posts_created ON posts(created_at DESC);

        CREATE TABLE comments (
          id          TEXT PRIMARY KEY,
          post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          body        TEXT NOT NULL,
          parent_id   TEXT REFERENCES comments(id) ON DELETE CASCADE,
          created_at  TEXT NOT NULL,
          deleted_at  TEXT
        );
        CREATE INDEX idx_comments_post_created ON comments(post_id, created_at);

        CREATE TABLE likes (
          user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          created_at  TEXT NOT NULL,
          PRIMARY KEY (user_id, post_id)
        );

        CREATE TABLE follows (
          follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          state       TEXT NOT NULL DEFAULT 'accepted',
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          PRIMARY KEY (follower_id, followee_id)
        );
        CREATE INDEX idx_follows_followee ON follows(followee_id, state);

        CREATE TABLE collections (
          id          TEXT PRIMARY KEY,
          owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX idx_collections_owner ON collections(owner_id);

        CREATE TABLE saved_posts (
          user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
          created_at    TEXT NOT NULL,
          PRIMARY KEY (user_id, post_id)
        );

        CREATE TABLE stories (
          id          TEXT PRIMARY KEY,
          author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          media_url   TEXT,
          caption     TEXT,
          created_at  TEXT NOT NULL,
          expires_at  TEXT NOT NULL
        );
        CREATE INDEX idx_stories_author ON stories(author_id, created_at DESC);

        CREATE TABLE notifications (
          id          TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind        TEXT NOT NULL,
          actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
          subject_type TEXT,
          subject_id  TEXT,
          body        TEXT,
          read_at     TEXT,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);

        CREATE TABLE conversations (
          id          TEXT PRIMARY KEY,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        CREATE TABLE conversation_members (
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          joined_at       TEXT NOT NULL,
          PRIMARY KEY (conversation_id, user_id)
        );

        CREATE TABLE messages (
          id              TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          body            TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          deleted_at      TEXT
        );
        CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

        CREATE TABLE user_settings (
          user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          locale      TEXT NOT NULL DEFAULT 'en',
          theme       TEXT NOT NULL DEFAULT 'system',
          is_private  INTEGER NOT NULL DEFAULT 0,
          allow_messages_from TEXT NOT NULL DEFAULT 'everyone',
          updated_at  TEXT NOT NULL
        );
      `);
    },
  },
  {
    /*
     * Compatibility with the original client's data model:
     *   - numeric string `pk` on every entity the client addresses by id, and a
     *     shortcode `code` for posts (the client builds /p/<code>/ from it);
     *   - stored media (uploads) referenced by posts, stories and avatars;
     *   - email confirmation codes for the client's signup flow;
     *   - story views and per-member read state for direct threads.
     * Existing rows are backfilled so the migration works on a populated database.
     */
    id: '0002_client_compat',
    up(db) {
      const { newPk, shortcodeFromPk } = require('../lib/ids');
      db.exec(`
        CREATE TABLE media (
          id            TEXT PRIMARY KEY,
          upload_id     TEXT NOT NULL UNIQUE,
          owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          storage_key   TEXT NOT NULL UNIQUE,
          content_type  TEXT NOT NULL,
          byte_size     INTEGER NOT NULL,
          width         INTEGER,
          height        INTEGER,
          sha256        TEXT NOT NULL,
          purpose       TEXT NOT NULL DEFAULT 'post',
          created_at    TEXT NOT NULL,
          attached_at   TEXT
        );
        CREATE INDEX idx_media_owner ON media(owner_id, created_at DESC);

        ALTER TABLE users ADD COLUMN pk TEXT;
        ALTER TABLE users ADD COLUMN external_url TEXT;
        ALTER TABLE users ADD COLUMN avatar_media_id TEXT REFERENCES media(id) ON DELETE SET NULL;

        ALTER TABLE posts ADD COLUMN pk TEXT;
        ALTER TABLE posts ADD COLUMN code TEXT;
        ALTER TABLE posts ADD COLUMN media_id TEXT REFERENCES media(id) ON DELETE SET NULL;
        ALTER TABLE posts ADD COLUMN comments_disabled INTEGER NOT NULL DEFAULT 0;

        ALTER TABLE comments ADD COLUMN pk TEXT;
        ALTER TABLE stories ADD COLUMN pk TEXT;
        ALTER TABLE stories ADD COLUMN media_id TEXT REFERENCES media(id) ON DELETE SET NULL;
        ALTER TABLE conversations ADD COLUMN pk TEXT;
        ALTER TABLE messages ADD COLUMN pk TEXT;
        ALTER TABLE messages ADD COLUMN client_context TEXT;
        ALTER TABLE conversation_members ADD COLUMN last_seen_at TEXT;

        CREATE TABLE story_views (
          story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
          viewer_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          seen_at    TEXT NOT NULL,
          PRIMARY KEY (story_id, viewer_id)
        );

        CREATE TABLE signup_codes (
          id            TEXT PRIMARY KEY,
          email_ci      TEXT NOT NULL,
          code_hash     TEXT NOT NULL,
          attempts      INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL,
          expires_at    TEXT NOT NULL,
          consumed_at   TEXT,
          signup_token_hash TEXT UNIQUE
        );
        CREATE INDEX idx_signup_codes_email ON signup_codes(email_ci, created_at DESC);
      `);

      for (const table of ['users', 'posts', 'comments', 'stories', 'conversations', 'messages']) {
        const rows = db.prepare(`SELECT id FROM ${table} WHERE pk IS NULL`).all();
        const set = db.prepare(`UPDATE ${table} SET pk = ? WHERE id = ?`);
        for (const row of rows) set.run(newPk(), row.id);
      }
      const posts = db.prepare('SELECT id, pk FROM posts WHERE code IS NULL').all();
      const setCode = db.prepare('UPDATE posts SET code = ? WHERE id = ?');
      for (const row of posts) setCode.run(shortcodeFromPk(row.pk), row.id);

      db.exec(`
        CREATE UNIQUE INDEX idx_users_pk ON users(pk);
        CREATE UNIQUE INDEX idx_posts_pk ON posts(pk);
        CREATE UNIQUE INDEX idx_posts_code ON posts(code);
        CREATE UNIQUE INDEX idx_comments_pk ON comments(pk);
        CREATE UNIQUE INDEX idx_stories_pk ON stories(pk);
        CREATE UNIQUE INDEX idx_conversations_pk ON conversations(pk);
        CREATE UNIQUE INDEX idx_messages_pk ON messages(pk);
        CREATE UNIQUE INDEX idx_messages_client_context ON messages(sender_id, client_context) WHERE client_context IS NOT NULL;
      `);
    },
  },
];

module.exports = { migrations };
