import { Store } from "../../store/db.ts";
import { search } from "../../search/index.ts";
import { packEvidence, renderEvidence } from "../../pack/context.ts";
import { embeddingsEnabled } from "../../index/embed.ts";
import type { SearchFilters } from "../../search/types.ts";
import type { ThreadKind, ThreadState } from "../../types.ts";
import { repoSlug } from "../../types.ts";
import { freshnessOf, staleNotice } from "../../freshness.ts";
import { resolveRepo } from "../repo.ts";
import { bold, cyan, dim, info, out, stateColor, yellow } from "../output.ts";

export interface AskArgs {
  query: string;
  repo?: string | undefined;
  limit?: number | undefined;
  kind?: ThreadKind[] | undefined;
  state?: ThreadState[] | undefined;
  label?: string[] | undefined;
  author?: string | undefined;
  since?: string | undefined;
  lexical?: boolean;
  json?: boolean;
  budget?: number | undefined;
}

/** `groundhog ask "<question>"` — the whole point of the tool. */
export async function askCommand(args: AskArgs): Promise<void> {
  const repo = resolveRepo(args.repo);
  const store = Store.open(repo, { readonly: true });

  try {
    const filters: SearchFilters = {};
    if (args.kind?.length) filters.kind = args.kind;
    if (args.state?.length) filters.state = args.state;
    if (args.label?.length) filters.labels = args.label;
    if (args.author) filters.author = args.author;
    if (args.since) filters.since = args.since;

    const hits = await search(store, args.query, {
      limit: args.limit ?? 8,
      filters,
      ...(args.lexical ? { lexical: true } : {}),
    });

    const packed = packEvidence(store, hits, {
      ...(args.budget !== undefined ? { budget: args.budget } : {}),
    });

    if (args.json) {
      out(
        JSON.stringify(
          {
            repo: `${repo.owner}/${repo.name}`,
            query: args.query,
            results: packed.items.map((item) => ({
              number: item.thread.number,
              kind: item.thread.kind,
              state: item.thread.state,
              title: item.thread.title,
              url: item.thread.url,
              labels: item.thread.labels,
              resolution: item.thread.resolutionRef,
              updatedAt: item.thread.updatedAt,
              score: Number(item.score.toFixed(4)),
              excerpts: item.excerpts,
            })),
            truncated: packed.truncated,
            lastSync: store.getMeta("last_sync"),
            stale: freshnessOf(store.getMeta("last_sync")).stale,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (packed.items.length === 0) {
      out(renderEvidence(packed));
      if (!embeddingsEnabled(store) && !args.lexical) {
        info(
          dim("\nOnly exact-word search is on. For meaning-based matches: groundhog embed --enable"),
        );
      }
      return;
    }

    for (const item of packed.items) {
      const t = item.thread;
      const badge = stateColor(t.state)(t.state);
      const resolution =
        t.resolutionRef && t.resolutionRef !== "merged" ? dim(` · fixed in ${t.resolutionRef}`) : "";

      out(`${cyan(`#${t.number}`)}  ${bold(t.title)}`);
      out(`   ${dim(t.kind)} · ${badge}${resolution} · ${dim(t.updatedAt.slice(0, 10))}`);
      for (const excerpt of item.excerpts) out(`   ${dim(`"${excerpt}"`)}`);
      out(`   ${dim(t.url)}`);
      out();
    }

    if (packed.truncated) info(dim("(more matches available — raise --limit)"));

    // A tracker answer is only as good as its last sync, so say so rather than
    // letting a stale index look authoritative.
    const notice = staleNotice(freshnessOf(store.getMeta("last_sync")), repoSlug(repo));
    if (notice) info(yellow(notice));
  } finally {
    store.close();
  }
}
