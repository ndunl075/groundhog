import { Store } from "../../store/db.ts";
import { sync } from "../../ingest/sync.ts";
import { buildIndex } from "../../index/build.ts";
import { repoSlug } from "../../types.ts";
import type { ThreadKind } from "../../types.ts";
import { resolveRepo } from "../repo.ts";
import { bold, dim, endProgress, green, info, out, progress } from "../output.ts";
import { runEmbedBackfill } from "./embed.ts";

export interface IndexArgs {
  repo?: string | undefined;
  limit?: number | undefined;
  kinds?: ThreadKind[] | undefined;
  full?: boolean;
  embed?: boolean;
}

/** `groundhog index <owner/repo>` — fetch, then chunk. */
export async function indexCommand(args: IndexArgs): Promise<void> {
  const repo = resolveRepo(args.repo);
  const store = Store.open(repo);

  try {
    info(`${bold("Indexing")} ${repoSlug(repo)}`);

    const result = await sync(store, {
      full: args.full ?? true,
      ...(args.kinds ? { kinds: args.kinds } : {}),
      ...(args.limit !== undefined ? { max: args.limit } : {}),
      onProgress: (p) =>
        progress(dim(`  ${p.fetched} threads · ${p.kind} #${p.thread.number}`)),
    });
    endProgress();
    info(
      `  fetched ${green(String(result.fetched))} threads ` +
        dim(`(${describeKinds(result.byKind)}) in ${(result.durationMs / 1000).toFixed(1)}s`),
    );

    const built = buildIndex(store, {
      onProgress: (done, total) => progress(dim(`  chunking ${done}/${total}`)),
    });
    endProgress();
    info(`  built ${green(String(built.chunks))} chunks ${dim(`in ${built.durationMs}ms`)}`);

    if (args.embed) await runEmbedBackfill(store);

    const stats = store.stats();
    out();
    out(`${bold(repoSlug(repo))} indexed — ${stats.threads} threads, ${stats.chunks} chunks`);
    out(dim(`Ask it something:  groundhog ask "..."`));
  } finally {
    store.close();
  }
}

export function describeKinds(byKind: Record<string, number>): string {
  const parts = Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "nothing new";
}
