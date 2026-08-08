import type { Thread, ThreadKind, ThreadState } from "../types.ts";

export interface SearchFilters {
  kind?: ThreadKind | ThreadKind[];
  state?: ThreadState | ThreadState[];
  /** Thread must carry every label listed. */
  labels?: string[];
  author?: string;
  /** ISO timestamp; threads updated before this are excluded. */
  since?: string;
}

/** One matching chunk, before roll-up to its thread. */
export interface ChunkHit {
  chunkId: number;
  threadId: string;
  score: number;
  /** 1-based position within this retriever's own result list. */
  rank: number;
  excerpt?: string;
}

/** A thread with the evidence that matched it. */
export interface ThreadHit {
  thread: Thread;
  score: number;
  chunks: ChunkHit[];
}

export interface SearchOptions {
  limit?: number;
  filters?: SearchFilters;
}
