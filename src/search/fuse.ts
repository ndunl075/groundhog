import type { ChunkHit } from "./types.ts";

/**
 * Reciprocal Rank Fusion.
 *
 * BM25 scores and cosine similarities live on incomparable scales, and any
 * attempt to normalize them needs corpus statistics that shift every sync. RRF
 * ignores the scores and reads only the ranks, so it needs no calibration and
 * cannot be destabilized by one retriever's outlier.
 *
 * `k` damps the top of each list: at k=60 the difference between rank 1 and
 * rank 2 is small, so agreement between retrievers matters more than either
 * one's ordering.
 */
export function rrf(lists: ChunkHit[][], k = 60): ChunkHit[] {
  const scores = new Map<number, number>();
  const seen = new Map<number, ChunkHit>();

  for (const list of lists) {
    for (const hit of list) {
      scores.set(hit.chunkId, (scores.get(hit.chunkId) ?? 0) + 1 / (k + hit.rank));
      // Keep the first sighting, preferring one that carries an excerpt.
      const existing = seen.get(hit.chunkId);
      if (!existing || (!existing.excerpt && hit.excerpt)) seen.set(hit.chunkId, hit);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([chunkId, score], i) => {
      const hit = seen.get(chunkId)!;
      return {
        ...hit,
        score,
        rank: i + 1,
      };
    });
}
