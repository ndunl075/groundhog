import type { Store } from "../store/db.ts";
import { buildFilters } from "./bm25.ts";
import type { ChunkHit, SearchFilters } from "./types.ts";

/**
 * Brute-force cosine over one contiguous Float32Array.
 *
 * At tracker scale this is the right answer: 20k chunks x 384 dims is 31 MB and
 * scans in ~15 ms. An ANN index would add a dependency and a build step to
 * save nothing.
 */
export class VectorIndex {
  readonly dim: number;
  private readonly ids: Int32Array;
  private readonly matrix: Float32Array;

  private constructor(ids: Int32Array, matrix: Float32Array, dim: number) {
    this.ids = ids;
    this.matrix = matrix;
    this.dim = dim;
  }

  static load(store: Store): VectorIndex | null {
    const loaded = store.loadVectorMatrix();
    if (!loaded || loaded.ids.length === 0) return null;
    return new VectorIndex(loaded.ids, loaded.matrix, loaded.dim);
  }

  get size(): number {
    return this.ids.length;
  }

  /**
   * `allowed`, when given, restricts the scan to chunk ids that passed the SQL
   * filters — vectors carry no metadata of their own.
   */
  search(
    store: Store,
    query: Float32Array,
    limit: number,
    allowed?: Set<number> | null,
  ): ChunkHit[] {
    if (query.length !== this.dim) {
      throw new Error(
        `Query vector has ${query.length} dims but the index has ${this.dim}. Re-run: groundhog embed --enable`,
      );
    }

    // A small max-heap would win only above ~1M rows; a sorted insert into a
    // fixed top-k array is faster at the sizes this actually sees.
    const topIds: number[] = [];
    const topScores: number[] = [];
    let floor = -Infinity;

    for (let row = 0; row < this.ids.length; row++) {
      const id = this.ids[row]!;
      if (allowed && !allowed.has(id)) continue;

      const base = row * this.dim;
      let dot = 0;
      for (let d = 0; d < this.dim; d++) dot += this.matrix[base + d]! * query[d]!;

      if (topScores.length === limit && dot <= floor) continue;

      let at = topScores.length;
      while (at > 0 && topScores[at - 1]! < dot) at--;
      topScores.splice(at, 0, dot);
      topIds.splice(at, 0, id);
      if (topScores.length > limit) {
        topScores.pop();
        topIds.pop();
      }
      if (topScores.length === limit) floor = topScores[topScores.length - 1]!;
    }

    if (topIds.length === 0) return [];

    const threads = threadIdsFor(store, topIds);
    return topIds.map((id, i) => ({
      chunkId: id,
      threadId: threads.get(id) ?? "",
      score: topScores[i]!,
      rank: i + 1,
    }));
  }
}

/** One cached index per store, built on first semantic query. */
const CACHE = new WeakMap<Store, VectorIndex | null>();

export function vectorIndexFor(store: Store): VectorIndex | null {
  if (CACHE.has(store)) return CACHE.get(store) ?? null;
  const index = VectorIndex.load(store);
  CACHE.set(store, index);
  return index;
}

/** Drops the cached matrix, e.g. after a backfill added vectors. */
export function invalidateVectorIndex(store: Store): void {
  CACHE.delete(store);
}

export function vectorSearch(
  store: Store,
  query: Float32Array,
  limit: number,
  filters?: SearchFilters,
): ChunkHit[] {
  const index = vectorIndexFor(store);
  if (!index) return [];
  return index.search(store, query, limit, allowedChunkIds(store, filters));
}

/** Chunk ids whose thread passes the filters, or null when unfiltered. */
function allowedChunkIds(store: Store, filters?: SearchFilters): Set<number> | null {
  const { clause, params } = buildFilters(filters);
  if (!clause) return null;

  const rows = store.raw
    .prepare(`SELECT c.id FROM chunk c JOIN thread t ON t.id = c.thread_id WHERE 1=1${clause}`)
    .all(...params) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

function threadIdsFor(store: Store, chunkIds: number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (let i = 0; i < chunkIds.length; i += 400) {
    const slice = chunkIds.slice(i, i + 400);
    const rows = store.raw
      .prepare(
        `SELECT id, thread_id FROM chunk WHERE id IN (${slice.map(() => "?").join(",")})`,
      )
      .all(...slice) as { id: number; thread_id: string }[];
    for (const row of rows) out.set(row.id, row.thread_id);
  }
  return out;
}
