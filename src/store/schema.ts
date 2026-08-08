/**
 * Schema migrations. Append-only: never edit a shipped migration, add a new one.
 * The array index + 1 is the resulting `user_version`.
 */
export const MIGRATIONS: string[] = [
  /* 1 — initial schema */ `
  CREATE TABLE thread (
    id             TEXT PRIMARY KEY,
    number         INTEGER NOT NULL,
    kind           TEXT NOT NULL,
    title          TEXT NOT NULL,
    body           TEXT NOT NULL DEFAULT '',
    state          TEXT NOT NULL,
    author         TEXT,
    labels         TEXT NOT NULL DEFAULT '[]',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    closed_at      TEXT,
    merged         INTEGER NOT NULL DEFAULT 0,
    url            TEXT NOT NULL,
    resolution_ref TEXT,
    comment_count  INTEGER NOT NULL DEFAULT 0,
    indexed_at     TEXT
  );
  CREATE UNIQUE INDEX thread_kind_number ON thread(kind, number);
  CREATE INDEX thread_kind_state ON thread(kind, state);
  CREATE INDEX thread_updated ON thread(updated_at DESC);

  CREATE TABLE message (
    id         TEXT PRIMARY KEY,
    thread_id  TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    author     TEXT,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    url        TEXT,
    ord        INTEGER NOT NULL
  );
  CREATE INDEX message_thread ON message(thread_id, ord);

  CREATE TABLE chunk (
    id         INTEGER PRIMARY KEY,
    thread_id  TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
    message_id TEXT,
    ord        INTEGER NOT NULL,
    text       TEXT NOT NULL,
    token_est  INTEGER NOT NULL
  );
  CREATE INDEX chunk_thread ON chunk(thread_id, ord);

  -- External-content FTS: the text is stored once, in chunk.
  CREATE VIRTUAL TABLE chunk_fts USING fts5(
    text,
    content='chunk',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER chunk_ai AFTER INSERT ON chunk BEGIN
    INSERT INTO chunk_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER chunk_ad AFTER DELETE ON chunk BEGIN
    INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER chunk_au AFTER UPDATE ON chunk BEGIN
    INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chunk_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TABLE vector (
    chunk_id INTEGER PRIMARY KEY REFERENCES chunk(id) ON DELETE CASCADE,
    dim      INTEGER NOT NULL,
    data     BLOB NOT NULL
  );

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
