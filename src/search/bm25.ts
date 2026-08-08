import type { Store } from "../store/db.ts";
import type { ChunkHit, SearchFilters, SearchOptions } from "./types.ts";
import { parseQuery } from "./query.ts";

/** Lexical retrieval over the FTS5 index. */
export function searchBm25(
  store: Store,
  rawQuery: string,
  opts: SearchOptions = {},
): ChunkHit[] {
  const parsed = parseQuery(rawQuery);
  if (!parsed.match) return [];

  const limit = opts.limit ?? 50;
  const { clause, params } = buildFilters(opts.filters);

  const sql = `
    SELECT c.id AS chunk_id,
           c.thread_id AS thread_id,
           bm25(chunk_fts) AS rank,
           snippet(chunk_fts, 0, '', '', '…', 24) AS excerpt
    FROM chunk_fts
    JOIN chunk c ON c.id = chunk_fts.rowid
    JOIN thread t ON t.id = c.thread_id
    WHERE chunk_fts MATCH ?${clause}
    ORDER BY rank
    LIMIT ?`;

  let rows: Bm25Row[];
  try {
    rows = store.raw.prepare(sql).all(parsed.match, ...params, limit) as Bm25Row[];
  } catch (err) {
    // parseQuery should make this unreachable; degrade instead of crashing a search.
    if (err instanceof Error && /fts5|syntax/i.test(err.message)) return [];
    throw err;
  }

  // bm25() is negative and lower-is-better; flip it so higher-is-better holds
  // everywhere above this layer.
  return rows.map((row, i) => ({
    chunkId: row.chunk_id,
    threadId: row.thread_id,
    score: -row.rank,
    rank: i + 1,
    excerpt: row.excerpt,
  }));
}

/** Filters are pushed into SQL so ranking never sees rows it must discard. */
export function buildFilters(filters?: SearchFilters): {
  clause: string;
  params: unknown[];
} {
  if (!filters) return { clause: "", params: [] };

  const parts: string[] = [];
  const params: unknown[] = [];

  const kinds = toArray(filters.kind);
  if (kinds.length) {
    parts.push(`t.kind IN (${kinds.map(() => "?").join(",")})`);
    params.push(...kinds);
  }

  const states = toArray(filters.state);
  if (states.length) {
    parts.push(`t.state IN (${states.map(() => "?").join(",")})`);
    params.push(...states);
  }

  for (const label of filters.labels ?? []) {
    // labels is a JSON array of strings; the quotes make the match exact.
    parts.push("t.labels LIKE ?");
    params.push(`%"${label}"%`);
  }

  if (filters.author) {
    parts.push("t.author = ?");
    params.push(filters.author);
  }

  if (filters.since) {
    parts.push("t.updated_at >= ?");
    params.push(filters.since);
  }

  return {
    clause: parts.length ? ` AND ${parts.join(" AND ")}` : "",
    params,
  };
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

interface Bm25Row {
  chunk_id: number;
  thread_id: string;
  rank: number;
  excerpt: string;
}
