import { Store } from "../../store/db.ts";
import { listIndexedRepos, dataDir } from "../../store/paths.ts";
import { embeddingModel } from "../../index/embed.ts";
import { repoSlug } from "../../types.ts";
import { bold, dim, green, humanAge, humanBytes, out, yellow } from "../output.ts";
import { freshnessOf } from "../../freshness.ts";

export interface StatusArgs {
  json?: boolean;
}

/** `groundhog status` — what is indexed, how fresh, how big. */
export function statusCommand(args: StatusArgs): void {
  const repos = listIndexedRepos();

  if (args.json) {
    out(
      JSON.stringify(
        {
          dataDir: dataDir(),
          repos: repos.map((repo) => {
            const store = Store.open(repo, { readonly: true });
            try {
              return {
                repo: repoSlug(repo),
                host: repo.host,
                ...store.stats(),
                embedModel: embeddingModel(store),
              };
            } finally {
              store.close();
            }
          }),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (repos.length === 0) {
    out("Nothing indexed yet.");
    out(dim("  groundhog index <owner/repo>"));
    return;
  }

  out(dim(dataDir()));
  out();

  for (const repo of repos) {
    const store = Store.open(repo, { readonly: true });
    try {
      const s = store.stats();
      const kinds = Object.entries(s.byKind)
        .map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`)
        .join(", ");
      const model = embeddingModel(store);
      const semantic = model
        ? green(`semantic ${s.vectors}/${s.chunks}`)
        : yellow("lexical only");

      const fresh = freshnessOf(s.lastSync);
      const age = fresh.stale ? yellow(`synced ${fresh.label}`) : dim(`synced ${fresh.label}`);
      out(`${bold(repoSlug(repo))}  ${age}`);
      out(`  ${kinds || "no threads"} · ${s.chunks} chunks · ${semantic}`);
      out(`  ${dim(humanBytes(s.sizeBytes))}`);
      out();
    } finally {
      store.close();
    }
  }
}
