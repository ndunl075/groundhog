import { z } from "zod";
import { Store } from "../store/db.ts";
import { search } from "../search/index.ts";
import { sync } from "../ingest/sync.ts";
import { buildIndex } from "../index/build.ts";
import { embeddingsEnabled, embeddingModel } from "../index/embed.ts";
import { packEvidence, renderEvidence, renderThread } from "../pack/context.ts";
import { listIndexedRepos } from "../store/paths.ts";
import { parseRepoRef, repoSlug } from "../types.ts";
import type { RepoRef, ThreadKind } from "../types.ts";
import type { SearchFilters } from "../search/types.ts";

/**
 * Opens repo databases on demand and closes them once idle, so an MCP server
 * left running all day holds no handles for repos nobody asked about.
 */
export class StorePool {
  private readonly open = new Map<string, { store: Store; timer: NodeJS.Timeout }>();
  private readonly idleMs: number;

  constructor(idleMs = 60_000) {
    this.idleMs = idleMs;
  }

  get(repo: RepoRef, opts: { readonly?: boolean } = {}): Store {
    // Keyed by access mode as well as repo. Handing a read-only handle to
    // sync_repo fails with "attempt to write a readonly database", and
    // upgrading in place would close a handle a concurrent read may still be
    // using — so the two modes get their own connections. SQLite in WAL mode
    // is happy with both, and the pool holds at most two per repo.
    const mode = opts.readonly ? "ro" : "rw";
    const key = `${repo.host}/${repo.owner}/${repo.name}:${mode}`;
    const existing = this.open.get(key);
    if (existing) {
      existing.timer.refresh();
      return existing.store;
    }

    const store = Store.open(repo, opts);
    const timer = setTimeout(() => this.release(key), this.idleMs);
    timer.unref(); // never hold the process open
    this.open.set(key, { store, timer });
    return store;
  }

  private release(key: string): void {
    const entry = this.open.get(key);
    if (!entry) return;
    this.open.delete(key);
    clearTimeout(entry.timer);
    try {
      entry.store.close();
    } catch {
      // already closed; nothing to do
    }
  }

  closeAll(): void {
    for (const key of [...this.open.keys()]) this.release(key);
  }
}

/** Resolves the `repo` argument, defaulting to the only indexed repo. */
export function resolveRepoArg(repo?: string): RepoRef {
  if (repo) return parseRepoRef(repo);

  const indexed = listIndexedRepos();
  if (indexed.length === 1) return indexed[0]!;
  if (indexed.length === 0) {
    throw new Error("No repos are indexed. Run `groundhog index <owner/repo>` in a terminal first.");
  }
  throw new Error(
    `Several repos are indexed — pass "repo". Available: ${indexed.map(repoSlug).join(", ")}`,
  );
}

const repoArg = z
  .string()
  .optional()
  .describe('Repo as "owner/name". Omit when only one repo is indexed.');

export const searchThreadsSchema = {
  query: z.string().describe("What to look for — a question, an error message, or a symptom."),
  repo: repoArg,
  kind: z
    .array(z.enum(["issue", "pr", "discussion"]))
    .optional()
    .describe("Restrict to these thread kinds."),
  state: z
    .array(z.enum(["open", "closed", "merged"]))
    .optional()
    .describe("Restrict to these states."),
  label: z.array(z.string()).optional().describe("Thread must carry all of these labels."),
  author: z.string().optional().describe("Thread author's login."),
  since: z.string().optional().describe("ISO date; only threads updated since then."),
  limit: z.number().int().min(1).max(50).optional().describe("Max threads to return (default 8)."),
};

export const getThreadSchema = {
  number: z.number().int().positive().describe("Issue, PR, or discussion number."),
  repo: repoArg,
  kind: z
    .enum(["issue", "pr", "discussion"])
    .optional()
    .describe("Disambiguates when a number exists as more than one kind."),
};

export const findSimilarSchema = {
  text: z
    .string()
    .describe("An error message, stack trace, or bug description to match against past threads."),
  repo: repoArg,
  limit: z.number().int().min(1).max(50).optional().describe("Max threads to return (default 5)."),
};

export const syncRepoSchema = {
  repo: repoArg,
  full: z.boolean().optional().describe("Re-walk the whole tracker instead of just what changed."),
};

export const listReposSchema = {};

// ---- handlers --------------------------------------------------------------

export async function searchThreads(
  pool: StorePool,
  args: {
    query: string;
    repo?: string;
    kind?: ThreadKind[];
    state?: ("open" | "closed" | "merged")[];
    label?: string[];
    author?: string;
    since?: string;
    limit?: number;
  },
): Promise<string> {
  const repo = resolveRepoArg(args.repo);
  const store = pool.get(repo, { readonly: true });

  const filters: SearchFilters = {};
  if (args.kind?.length) filters.kind = args.kind;
  if (args.state?.length) filters.state = args.state;
  if (args.label?.length) filters.labels = args.label;
  if (args.author) filters.author = args.author;
  if (args.since) filters.since = args.since;

  const hits = await search(store, args.query, { limit: args.limit ?? 8, filters });
  const packed = packEvidence(store, hits);

  if (packed.items.length === 0) {
    return `No threads in ${repoSlug(repo)} match "${args.query}".${
      embeddingsEnabled(store)
        ? ""
        : "\n\nOnly exact-word search is enabled. `groundhog embed --enable` adds meaning-based matching."
    }`;
  }
  return `${packed.items.length} matching threads in ${repoSlug(repo)}:\n\n${renderEvidence(packed)}`;
}

export function getThread(
  pool: StorePool,
  args: { number: number; repo?: string; kind?: ThreadKind },
): string {
  const repo = resolveRepoArg(args.repo);
  const store = pool.get(repo, { readonly: true });

  const thread = store.getThreadByNumber(args.number, args.kind);
  if (!thread) {
    return `#${args.number} is not in the local index for ${repoSlug(repo)}. It may be newer than the last sync — try sync_repo.`;
  }
  return renderThread(store, thread);
}

/**
 * The duplicate-finder. Distinct from search_threads because pasted errors are
 * long, noisy, and mostly stack frames — so results skew toward resolved
 * threads, where the answer actually is.
 */
export async function findSimilar(
  pool: StorePool,
  args: { text: string; repo?: string; limit?: number },
): Promise<string> {
  const repo = resolveRepoArg(args.repo);
  const store = pool.get(repo, { readonly: true });

  const hits = await search(store, args.text, { limit: args.limit ?? 5 });
  const packed = packEvidence(store, hits, { budget: 3000 });

  if (packed.items.length === 0) return `Nothing similar in ${repoSlug(repo)}.`;

  const resolved = packed.items.filter(
    (i) => i.thread.state !== "open" && i.thread.resolutionRef,
  ).length;
  const header = resolved
    ? `${packed.items.length} similar threads in ${repoSlug(repo)}, ${resolved} of them resolved:`
    : `${packed.items.length} similar threads in ${repoSlug(repo)} (none resolved yet):`;

  return `${header}\n\n${renderEvidence(packed)}`;
}

export async function syncRepo(
  pool: StorePool,
  args: { repo?: string; full?: boolean },
): Promise<string> {
  const repo = resolveRepoArg(args.repo);
  const store = pool.get(repo);

  const result = await sync(store, args.full ? { full: true } : {});
  if (result.fetched === 0) return `${repoSlug(repo)} was already up to date.`;

  const built = buildIndex(store);
  const stats = store.stats();
  const note = embeddingsEnabled(store)
    ? " New chunks are not embedded yet — run `groundhog sync` in a terminal to backfill vectors."
    : "";

  return (
    `Synced ${repoSlug(repo)}: ${result.fetched} threads updated, ${built.chunks} chunks rebuilt. ` +
    `Index now holds ${stats.threads} threads.${note}`
  );
}

export function listRepos(pool: StorePool): string {
  const repos = listIndexedRepos();
  if (repos.length === 0) {
    return "No repos indexed. Run `groundhog index <owner/repo>` in a terminal.";
  }

  const lines = repos.map((repo) => {
    const store = pool.get(repo, { readonly: true });
    const s = store.stats();
    const kinds = Object.entries(s.byKind)
      .map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`)
      .join(", ");
    const model = embeddingModel(store);
    return `${repoSlug(repo)} — ${kinds || "empty"}, ${s.chunks} chunks, ${
      model ? `semantic (${model})` : "lexical only"
    }, last synced ${s.lastSync ?? "never"}`;
  });

  return lines.join("\n");
}
