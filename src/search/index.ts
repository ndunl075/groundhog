import type { Store } from "../store/db.ts";
import { searchBm25 } from "./bm25.ts";
import { parseQuery } from "./query.ts";
import { rollup } from "./rollup.ts";
import type { SearchOptions, ThreadHit } from "./types.ts";

export { searchBm25 } from "./bm25.ts";
export { parseQuery, referencedNumbers } from "./query.ts";
export { rollup } from "./rollup.ts";
export type * from "./types.ts";

export interface QueryOptions extends SearchOptions {
  /** Chunks pulled from each retriever before roll-up. */
  candidates?: number;
  /** Skip tracker-native boosts and rank on raw retrieval score. */
  raw?: boolean;
}

/**
 * The one entry point every interface uses. Retrieves candidate chunks, rolls
 * them up to threads, and ranks. Vector recall joins here in the next layer;
 * callers do not change when it does.
 */
export function search(
  store: Store,
  query: string,
  opts: QueryOptions = {},
): ThreadHit[] {
  const limit = opts.limit ?? 10;
  const candidates = opts.candidates ?? Math.max(50, limit * 5);

  const parsed = parseQuery(query);
  if (!parsed.match) return [];

  const hits = searchBm25(store, query, {
    limit: candidates,
    ...(opts.filters ? { filters: opts.filters } : {}),
  });

  return rollup(store, hits, parsed, { limit, boost: !opts.raw });
}
