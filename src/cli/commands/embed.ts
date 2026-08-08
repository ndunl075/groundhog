import { Store } from "../../store/db.ts";
import { backfillVectors, embeddingModel, DEFAULT_MODEL } from "../../index/embed.ts";
import { invalidateVectorIndex } from "../../search/vector.ts";
import { repoSlug } from "../../types.ts";
import { resolveRepo } from "../repo.ts";
import { bold, dim, endProgress, green, info, out, progress, yellow } from "../output.ts";

export interface EmbedArgs {
  repo?: string | undefined;
  enable?: boolean;
  disable?: boolean;
  model?: string | undefined;
}

/** `groundhog embed --enable` — opt in to semantic search. */
export async function embedCommand(args: EmbedArgs): Promise<void> {
  const repo = resolveRepo(args.repo);
  const store = Store.open(repo);

  try {
    if (args.disable) {
      store.raw.prepare("DELETE FROM vector").run();
      store.raw.prepare("DELETE FROM meta WHERE key LIKE 'embed:%'").run();
      invalidateVectorIndex(store);
      out(`Semantic search disabled for ${bold(repoSlug(repo))}; vectors dropped.`);
      return;
    }

    if (!args.enable) {
      const model = embeddingModel(store);
      const stats = store.stats();
      out(
        model
          ? `${green("enabled")} · ${model} · ${stats.vectors}/${stats.chunks} chunks embedded`
          : `${yellow("disabled")} · run ${bold("groundhog embed --enable")} to turn on semantic search`,
      );
      return;
    }

    await runEmbedBackfill(store, args.model);
  } finally {
    store.close();
  }
}

/**
 * Shared by `index`, `sync`, and `embed --enable`. The model download happens
 * once, on first use, and is reported because it is the only time Groundhog
 * makes the user wait on something other than the forge API.
 */
export async function runEmbedBackfill(store: Store, model?: string): Promise<void> {
  const pending = store.stats();
  if (pending.chunks === 0) {
    info(dim("  nothing to embed yet"));
    return;
  }

  info(dim(`  embedding with ${model ?? embeddingModel(store) ?? DEFAULT_MODEL}`));
  const result = await backfillVectors(store, {
    ...(model ? { modelId: model } : {}),
    onDownload: (msg) => progress(dim(`  downloading ${msg}`)),
    onProgress: (p) => progress(dim(`  embedded ${p.done}/${p.total}`)),
  });
  endProgress();
  invalidateVectorIndex(store);

  if (result.embedded === 0) {
    info(dim("  vectors already up to date"));
    return;
  }
  const perSecond = Math.round(result.embedded / Math.max(result.durationMs / 1000, 0.001));
  info(
    `  embedded ${green(String(result.embedded))} chunks ` +
      dim(`(${result.dim}d, ${(result.durationMs / 1000).toFixed(1)}s, ~${perSecond}/s)`),
  );
}
