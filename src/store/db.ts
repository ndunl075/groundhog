import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { existsSync } from "node:fs";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";
import { dbPath, ensureRepoDir } from "./paths.ts";
import { nativeBinding } from "./native.ts";
import type {
  Chunk,
  Message,
  RepoRef,
  Thread,
  ThreadKind,
  MessageKind,
  ThreadState,
} from "../types.ts";

export interface StoreStats {
  threads: number;
  byKind: Record<string, number>;
  messages: number;
  chunks: number;
  vectors: number;
  lastSync: string | null;
  sizeBytes: number;
}

/**
 * One SQLite file per repo. Synchronous by design — better-sqlite3 is faster
 * than an async driver here and removes a whole class of interleaving bugs.
 */
export class Store {
  readonly repo: RepoRef;
  private readonly db: Db;

  private constructor(repo: RepoRef, db: Db) {
    this.repo = repo;
    this.db = db;
  }

  static open(repo: RepoRef, opts: { readonly?: boolean } = {}): Store {
    const path = dbPath(repo);
    if (opts.readonly && !existsSync(path)) {
      throw new Error(
        `No index for ${repo.owner}/${repo.name}. Run: groundhog index ${repo.owner}/${repo.name}`,
      );
    }
    if (!opts.readonly) ensureRepoDir(repo);

    // better-sqlite3 v11 accepts a loaded addon object here; @types only
    // declares the string form, hence the cast.
    const binding = nativeBinding() as string | undefined;
    const db = new Database(path, {
      readonly: opts.readonly ?? false,
      ...(binding ? { nativeBinding: binding } : {}),
    });
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("cache_size = -65536"); // 64 MB
    db.pragma("mmap_size = 268435456"); // 256 MB
    db.pragma("temp_store = MEMORY");

    const store = new Store(repo, db);
    try {
      // A read-only open cannot migrate, but it still has to refuse a schema it
      // does not understand — otherwise `ask` reports raw SQL errors about
      // missing columns instead of saying the index needs attention.
      if (opts.readonly) store.checkVersion();
      else store.migrate();
    } catch (err) {
      // Leaving the handle open on a rejected index locks the file on Windows,
      // so the next command fails with EBUSY instead of the real reason.
      db.close();
      throw err;
    }
    return store;
  }

  /** In-memory store, for tests. */
  static memory(repo: RepoRef): Store {
    const binding = nativeBinding() as string | undefined;
    const db = new Database(":memory:", binding ? { nativeBinding: binding } : {});
    db.pragma("foreign_keys = ON");
    const store = new Store(repo, db);
    store.migrate();
    return store;
  }

  /** Rejects a schema this build cannot read, in either direction. */
  private checkVersion(): number {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Index was written by a newer Groundhog (schema ${current} > ${SCHEMA_VERSION}). Upgrade, or delete the index.`,
      );
    }
    if (current < SCHEMA_VERSION && this.db.readonly) {
      throw new Error(
        `Index uses an older schema (${current} < ${SCHEMA_VERSION}). Run: groundhog sync ${this.repo.owner}/${this.repo.name}`,
      );
    }
    return current;
  }

  private migrate(): void {
    const current = this.checkVersion();
    for (let v = current; v < SCHEMA_VERSION; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** Wraps `fn` in a transaction; better-sqlite3 handles nesting via savepoints. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- meta ----------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Newest `updated_at` ingested for a thread kind; drives incremental sync. */
  getCursor(kind: ThreadKind): string | null {
    return this.getMeta(`cursor:${kind}`);
  }

  setCursor(kind: ThreadKind, updatedAt: string): void {
    const prev = this.getCursor(kind);
    if (prev === null || updatedAt > prev) this.setMeta(`cursor:${kind}`, updatedAt);
  }

  // ---- threads -------------------------------------------------------------

  upsertThread(t: Thread): void {
    this.db
      .prepare(
        `INSERT INTO thread (id, number, kind, title, body, state, author, labels,
                             created_at, updated_at, closed_at, merged, url,
                             resolution_ref, comment_count)
         VALUES (@id, @number, @kind, @title, @body, @state, @author, @labels,
                 @createdAt, @updatedAt, @closedAt, @merged, @url,
                 @resolutionRef, @commentCount)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, body = excluded.body, state = excluded.state,
           author = excluded.author, labels = excluded.labels,
           updated_at = excluded.updated_at, closed_at = excluded.closed_at,
           merged = excluded.merged, url = excluded.url,
           resolution_ref = excluded.resolution_ref,
           comment_count = excluded.comment_count`,
      )
      .run({
        id: t.id,
        number: t.number,
        kind: t.kind,
        title: t.title,
        body: t.body,
        state: t.state,
        author: t.author,
        labels: JSON.stringify(t.labels),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        closedAt: t.closedAt,
        merged: t.merged ? 1 : 0,
        url: t.url,
        resolutionRef: t.resolutionRef,
        commentCount: t.commentCount,
      });
  }

  getThread(id: string): Thread | null {
    const row = this.db.prepare("SELECT * FROM thread WHERE id = ?").get(id) as
      | ThreadRow
      | undefined;
    return row ? toThread(row) : null;
  }

  getThreadByNumber(number: number, kind?: ThreadKind): Thread | null {
    const row = (
      kind
        ? this.db
            .prepare("SELECT * FROM thread WHERE kind = ? AND number = ?")
            .get(kind, number)
        : this.db
            .prepare("SELECT * FROM thread WHERE number = ? ORDER BY kind LIMIT 1")
            .get(number)
    ) as ThreadRow | undefined;
    return row ? toThread(row) : null;
  }

  getThreads(ids: string[]): Map<string, Thread> {
    const out = new Map<string, Thread>();
    if (ids.length === 0) return out;
    // Chunked to stay clear of SQLITE_MAX_VARIABLE_NUMBER.
    for (let i = 0; i < ids.length; i += 400) {
      const slice = ids.slice(i, i + 400);
      const rows = this.db
        .prepare(
          `SELECT * FROM thread WHERE id IN (${slice.map(() => "?").join(",")})`,
        )
        .all(...slice) as ThreadRow[];
      for (const row of rows) out.set(row.id, toThread(row));
    }
    return out;
  }

  /** Threads whose content changed since they were last chunked. */
  staleThreadIds(): string[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM thread WHERE indexed_at IS NULL OR indexed_at < updated_at",
      )
      .all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  markIndexed(threadId: string, at: string = new Date().toISOString()): void {
    this.db.prepare("UPDATE thread SET indexed_at = ? WHERE id = ?").run(at, threadId);
  }

  deleteThread(id: string): void {
    this.db.prepare("DELETE FROM thread WHERE id = ?").run(id);
  }

  // ---- messages ------------------------------------------------------------

  /** Messages are immutable in practice; replacing wholesale keeps edits correct. */
  replaceMessages(threadId: string, messages: Message[]): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM message WHERE thread_id = ?").run(threadId);
      const insert = this.db.prepare(
        `INSERT INTO message (id, thread_id, kind, author, body, created_at, url, ord)
         VALUES (@id, @threadId, @kind, @author, @body, @createdAt, @url, @ord)`,
      );
      for (const m of messages) insert.run(m);
    });
  }

  getMessages(threadId: string): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM message WHERE thread_id = ? ORDER BY ord")
      .all(threadId) as MessageRow[];
    return rows.map(toMessage);
  }

  // ---- chunks --------------------------------------------------------------

  /** Replaces every chunk for a thread and returns the new rowids, in order. */
  replaceChunks(threadId: string, chunks: Omit<Chunk, "id">[]): number[] {
    return this.tx(() => {
      this.db.prepare("DELETE FROM chunk WHERE thread_id = ?").run(threadId);
      const insert = this.db.prepare(
        `INSERT INTO chunk (thread_id, message_id, ord, text, token_est)
         VALUES (@threadId, @messageId, @ord, @text, @tokenEst)`,
      );
      const ids: number[] = [];
      for (const c of chunks) {
        ids.push(Number(insert.run(c).lastInsertRowid));
      }
      return ids;
    });
  }

  getChunks(ids: number[]): Map<number, Chunk> {
    const out = new Map<number, Chunk>();
    if (ids.length === 0) return out;
    for (let i = 0; i < ids.length; i += 400) {
      const slice = ids.slice(i, i + 400);
      const rows = this.db
        .prepare(`SELECT * FROM chunk WHERE id IN (${slice.map(() => "?").join(",")})`)
        .all(...slice) as ChunkRow[];
      for (const row of rows) out.set(row.id, toChunk(row));
    }
    return out;
  }

  chunksWithoutVectors(limit: number): Chunk[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM chunk c
         LEFT JOIN vector v ON v.chunk_id = c.id
         WHERE v.chunk_id IS NULL
         ORDER BY c.id LIMIT ?`,
      )
      .all(limit) as ChunkRow[];
    return rows.map(toChunk);
  }

  // ---- vectors -------------------------------------------------------------

  putVectors(entries: { chunkId: number; vector: Float32Array }[]): void {
    this.tx(() => {
      const stmt = this.db.prepare(
        `INSERT INTO vector (chunk_id, dim, data) VALUES (?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET dim = excluded.dim, data = excluded.data`,
      );
      for (const { chunkId, vector } of entries) {
        stmt.run(chunkId, vector.length, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
      }
    });
  }

  /** All vectors as one contiguous matrix — see ARCHITECTURE.md §5. */
  loadVectorMatrix(): { ids: Int32Array; matrix: Float32Array; dim: number } | null {
    const head = this.db.prepare("SELECT dim FROM vector LIMIT 1").get() as
      | { dim: number }
      | undefined;
    if (!head) return null;

    const dim = head.dim;
    const count = this.db
      .prepare("SELECT COUNT(*) AS n FROM vector WHERE dim = ?")
      .get(dim) as { n: number };

    const ids = new Int32Array(count.n);
    const matrix = new Float32Array(count.n * dim);
    let i = 0;
    const rows = this.db
      .prepare("SELECT chunk_id, data FROM vector WHERE dim = ? ORDER BY chunk_id")
      .iterate(dim) as Iterable<{ chunk_id: number; data: Buffer }>;

    for (const row of rows) {
      if (i >= count.n) break;
      ids[i] = row.chunk_id;
      matrix.set(
        new Float32Array(row.data.buffer, row.data.byteOffset, dim),
        i * dim,
      );
      i++;
    }
    return { ids, matrix, dim };
  }

  // ---- introspection -------------------------------------------------------

  stats(): StoreStats {
    const one = (sql: string): number =>
      (this.db.prepare(sql).get() as { n: number }).n;

    const byKind: Record<string, number> = {};
    for (const row of this.db
      .prepare("SELECT kind, COUNT(*) AS n FROM thread GROUP BY kind")
      .all() as { kind: string; n: number }[]) {
      byKind[row.kind] = row.n;
    }

    const pageCount = this.db.pragma("page_count", { simple: true }) as number;
    const pageSize = this.db.pragma("page_size", { simple: true }) as number;

    return {
      threads: one("SELECT COUNT(*) AS n FROM thread"),
      byKind,
      messages: one("SELECT COUNT(*) AS n FROM message"),
      chunks: one("SELECT COUNT(*) AS n FROM chunk"),
      vectors: one("SELECT COUNT(*) AS n FROM vector"),
      lastSync: this.getMeta("last_sync"),
      sizeBytes: pageCount * pageSize,
    };
  }

  /** Escape hatch for the search layer, which needs bespoke SQL. */
  get raw(): Db {
    return this.db;
  }
}

// ---- row mapping -----------------------------------------------------------

interface ThreadRow {
  id: string;
  number: number;
  kind: string;
  title: string;
  body: string;
  state: string;
  author: string | null;
  labels: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged: number;
  url: string;
  resolution_ref: string | null;
  comment_count: number;
}

interface MessageRow {
  id: string;
  thread_id: string;
  kind: string;
  author: string | null;
  body: string;
  created_at: string;
  url: string | null;
  ord: number;
}

interface ChunkRow {
  id: number;
  thread_id: string;
  message_id: string | null;
  ord: number;
  text: string;
  token_est: number;
}

export function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind as ThreadKind,
    title: row.title,
    body: row.body,
    state: row.state as ThreadState,
    author: row.author,
    labels: safeLabels(row.labels),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    merged: row.merged === 1,
    url: row.url,
    resolutionRef: row.resolution_ref,
    commentCount: row.comment_count,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    kind: row.kind as MessageKind,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
    url: row.url,
    ord: row.ord,
  };
}

function toChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    ord: row.ord,
    text: row.text,
    tokenEst: row.token_est,
  };
}

function safeLabels(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}
