/**
 * Public API.
 *
 * Groundhog is usable as a library, not only a CLI: the MCP server is built
 * entirely from these exports and adds nothing the surface below lacks.
 *
 *   import { Store, sync, buildIndex, search, packEvidence } from "groundhog-rag";
 *
 *   const repo = parseRepoRef("vercel/next.js");
 *   const store = Store.open(repo);
 *   await sync(store);
 *   buildIndex(store);
 *   const hits = await search(store, "hydration mismatch");
 */

export { Store } from "./store/db.ts";
export type { StoreStats } from "./store/db.ts";
export { dataDir, dbPath, repoDir, listIndexedRepos } from "./store/paths.ts";
export { SCHEMA_VERSION } from "./store/schema.ts";

export { sync, forgeFor } from "./ingest/sync.ts";
export type { SyncOptions, SyncResult, SyncProgress } from "./ingest/sync.ts";
export { GitHubForge } from "./ingest/github.ts";
export { resolveToken } from "./ingest/auth.ts";
export { ForgeError } from "./ingest/types.ts";
export type { Forge, IngestedThread, FetchOptions } from "./ingest/types.ts";

export { buildIndex } from "./index/build.ts";
export type { BuildOptions, BuildResult } from "./index/build.ts";
export { chunkThread, estimateTokens, isBot } from "./index/chunk.ts";
export type { ChunkOptions } from "./index/chunk.ts";
export {
  Embedder,
  backfillVectors,
  embeddingsEnabled,
  embeddingModel,
  DEFAULT_MODEL,
} from "./index/embed.ts";

export {
  search,
  searchBm25,
  parseQuery,
  referencedNumbers,
  rollup,
  rrf,
  vectorSearch,
  invalidateVectorIndex,
  releaseEmbedder,
} from "./search/index.ts";
export type { QueryOptions } from "./search/index.ts";
export type {
  SearchFilters,
  SearchOptions,
  ChunkHit,
  ThreadHit,
} from "./search/types.ts";

export { packEvidence, renderEvidence, renderThread, headerLine } from "./pack/context.ts";
export type { PackedEvidence, PackOptions, EvidenceItem } from "./pack/context.ts";

export { createServer, serve } from "./mcp/server.ts";

export { parseRepoRef, repoSlug, threadId } from "./types.ts";
export type {
  RepoRef,
  Thread,
  Message,
  Chunk,
  ThreadKind,
  ThreadState,
  MessageKind,
} from "./types.ts";
