import { Store } from "../../store/db.ts";
import { sync } from "../../ingest/sync.ts";
import { buildIndex } from "../../index/build.ts";
import { embeddingsEnabled } from "../../index/embed.ts";
import { listIndexedRepos } from "../../store/paths.ts";
import { repoSlug } from "../../types.ts";
import type { RepoRef } from "../../types.ts";
import { resolveRepo } from "../repo.ts";
import { bold, dim, endProgress, green, info, progress } from "../output.ts";
import { describeKinds } from "./index-repo.ts";
import { runEmbedBackfill } from "./embed.ts";

export interface SyncArgs {
  repo?: string | undefined;
  all?: boolean;
  full?: boolean;
}

/** `groundhog sync` — incremental refresh of one repo, or every indexed repo. */
export async function syncCommand(args: SyncArgs): Promise<void> {
  const repos: RepoRef[] = args.all ? listIndexedRepos() : [resolveRepo(args.repo)];
  if (repos.length === 0) {
    info("Nothing indexed yet. Run: groundhog index <owner/repo>");
    return;
  }

  for (const repo of repos) {
    const store = Store.open(repo);
    try {
      info(`${bold(repoSlug(repo))}`);

      const result = await sync(store, {
        ...(args.full ? { full: true } : {}),
        onProgress: (p) => progress(dim(`  ${p.fetched} threads · ${p.kind} #${p.thread.number}`)),
      });
      endProgress();
      info(
        result.fetched === 0
          ? dim("  already up to date")
          : `  ${green(String(result.fetched))} updated ${dim(`(${describeKinds(result.byKind)})`)}`,
      );

      if (result.fetched > 0) {
        const built = buildIndex(store);
        info(dim(`  re-chunked ${built.threads} threads → ${built.chunks} chunks`));
        // Only worth loading a model when there is actually new text.
        if (embeddingsEnabled(store)) await runEmbedBackfill(store);
      }
    } finally {
      store.close();
    }
  }
}
