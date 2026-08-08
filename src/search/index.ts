import type { Store } from "../store/db.ts";
import { searchBm25 } from "./bm25.ts";
import { parseQuery } from "./query.ts";
import { rollup } from "./rollup.ts";
import { rrf } from "./fuse.ts";
import { vectorSearch, vectorIndexFor } from "./vector.ts";
import { Embedder, embeddingModel } from "../index/embed.ts";
import type { SearchOptions, ThreadHit } from "./types.ts";

export { searchBm25 } from "./bm25.ts";
export { parseQuery, referencedNumbers } from "./query.ts";
export { rollup } from "./rollup.ts";
export { rrf } from "./fuse.ts";
export { vectorSearch, vectorIndexFor, invalidateVectorIndex } from "./vector.ts";
export type * from "./types.ts";

export interface QueryOptions extends SearchOptions {
  /** Chunks pulled from each retriever before fusion. */
  candidates?: number;
  /** Skip tracker-native boosts and rank on raw retrieval score. */
  raw?: boolean;
  /** Force lexical-only, even when vectors exist. */
  lexical?: boolean;
}

/** One cached embedder per model; loading costs ~1s, queries cost ~5ms. */
let cachedEmbedder: Embedder | null = null;

/**
 * The one entry point every interface uses.
 *
 * Lexical recall always runs. Semantic recall joins it only when the repo has
 * vectors, so a Groundhog that never enabled embeddings never loads a model,
 * never allocates a matrix, and answers just as fast.
 */
export async function search(
  store: Store,
  query: string,
  opts: QueryOptions = {},
): Promise<ThreadHit[]> {
  const limit = opts.limit ?? 10;
  const candidates = opts.candidates ?? Math.max(50, limit * 5);

  const parsed = parseQuery(query);
  if (!parsed.match) return [];

  const filters = opts.filters ? { filters: opts.filters } : {};
  const lexical = searchBm25(store, query, { limit: candidates, ...filters });

  const semantic = opts.lexical ? [] : await semanticHits(store, query, candidates, opts);
  const fused = semantic.length ? rrf([lexical, semantic]) : lexical;

  return rollup(store, fused, parsed, { limit, boost: !opts.raw });
}

async function semanticHits(
  store: Store,
  query: string,
  candidates: number,
  opts: QueryOptions,
): Promise<ReturnType<typeof searchBm25>> {
  const modelId = embeddingModel(store);
  if (!modelId || !vectorIndexFor(store)) return [];

  try {
    if (!cachedEmbedder || cachedEmbedder.modelId !== modelId) {
      cachedEmbedder = await Embedder.load(modelId);
    }
    const [vector] = await cachedEmbedder.embed([query]);
    if (!vector) return [];
    return vectorSearch(store, vector, candidates, opts.filters);
  } catch (err) {
    // Semantic search is an enhancement, never a dependency: if the optional
    // package or the model is unavailable, lexical results still stand.
    process.env["GROUNDHOG_DEBUG"] &&
      process.stderr.write(`groundhog: semantic search unavailable (${String(err)})\n`);
    return [];
  }
}

/** Test seam; also lets long-lived servers release the model. */
export function releaseEmbedder(): void {
  cachedEmbedder = null;
}
