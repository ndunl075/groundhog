import type { Store } from "../store/db.ts";
import { chunkThread } from "./chunk.ts";
import type { ChunkOptions } from "./chunk.ts";

export interface BuildResult {
  threads: number;
  chunks: number;
  durationMs: number;
}

export interface BuildOptions extends ChunkOptions {
  /** Re-chunk everything, not just threads that changed since last index. */
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/**
 * (Re)chunks threads whose content changed since they were last indexed.
 * Chunking is pure and cheap, so this stays synchronous — the expensive,
 * optional step is embedding, which runs separately.
 */
export function buildIndex(store: Store, opts: BuildOptions = {}): BuildResult {
  const started = Date.now();
  const ids = opts.force
    ? (store.raw.prepare("SELECT id FROM thread").all() as { id: string }[]).map(
        (r) => r.id,
      )
    : store.staleThreadIds();

  let chunks = 0;
  let done = 0;

  for (const id of ids) {
    const thread = store.getThread(id);
    if (!thread) continue;
    const messages = store.getMessages(id);

    store.tx(() => {
      const produced = chunkThread(thread, messages, opts);
      store.replaceChunks(id, produced);
      store.markIndexed(id, thread.updatedAt);
      chunks += produced.length;
    });

    opts.onProgress?.(++done, ids.length);
  }

  return { threads: ids.length, chunks, durationMs: Date.now() - started };
}
