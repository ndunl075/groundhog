import type { Store } from "../store/db.ts";
import type { RepoRef, ThreadKind } from "../types.ts";
import { GitHubForge } from "./github.ts";
import type { Forge } from "./types.ts";

export interface SyncOptions {
  /** Ignore the stored cursor and walk the whole tracker again. */
  full?: boolean;
  kinds?: ThreadKind[];
  /** Cap threads per kind, for `--limit` and for tests. */
  max?: number;
  onProgress?: (p: SyncProgress) => void;
}

export interface SyncProgress {
  kind: ThreadKind;
  fetched: number;
  thread: { number: number; title: string };
}

export interface SyncResult {
  fetched: number;
  byKind: Record<string, number>;
  truncated: number;
  durationMs: number;
}

export function forgeFor(repo: RepoRef): Forge {
  // GitHub is the only implementation today; GHES hosts use the same adapter.
  return new GitHubForge(repo);
}

/**
 * Pulls new and updated threads into the store. Newest-first fetching plus a
 * per-kind cursor means a quiet day costs a handful of requests.
 *
 * The cursor advances only after every page of a kind has been committed, so an
 * interrupted sync resumes rather than skipping the gap.
 */
export async function sync(
  store: Store,
  opts: SyncOptions = {},
  forge: Forge = forgeFor(store.repo),
): Promise<SyncResult> {
  const started = Date.now();
  const available = await forge.supportedKinds();
  const kinds = opts.kinds ? opts.kinds.filter((k) => available.includes(k)) : available;

  const byKind: Record<string, number> = {};
  let fetched = 0;
  let truncated = 0;

  for (const kind of kinds) {
    const since = opts.full ? undefined : (store.getCursor(kind) ?? undefined);
    let newest: string | null = null;
    let count = 0;

    for await (const item of forge.fetchThreads(kind, { since, max: opts.max })) {
      store.tx(() => {
        store.upsertThread(item.thread);
        store.replaceMessages(item.thread.id, item.messages);
      });

      if (!newest || item.thread.updatedAt > newest) newest = item.thread.updatedAt;
      if (item.truncated) truncated++;
      count++;
      fetched++;
      opts.onProgress?.({
        kind,
        fetched,
        thread: { number: item.thread.number, title: item.thread.title },
      });
    }

    if (newest) store.setCursor(kind, newest);
    byKind[kind] = count;
  }

  store.setMeta("last_sync", new Date().toISOString());
  return { fetched, byKind, truncated, durationMs: Date.now() - started };
}
