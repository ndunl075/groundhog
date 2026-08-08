import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  StorePool,
  searchThreads,
  getThread,
  findSimilar,
  syncRepo,
  listRepos,
  searchThreadsSchema,
  getThreadSchema,
  findSimilarSchema,
  syncRepoSchema,
  listReposSchema,
} from "./tools.ts";

const VERSION = "0.1.0";

/** Every tool returns text; failures come back as text too, never as a crash. */
function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}

async function guard(fn: () => Promise<string> | string) {
  try {
    return text(await fn());
  } catch (err) {
    // A thrown tool is a dead conversation; a returned error is a recoverable one.
    return text(err instanceof Error ? err.message : String(err), true);
  }
}

export function createServer(pool: StorePool = new StorePool()): {
  server: McpServer;
  pool: StorePool;
} {
  const server = new McpServer({ name: "groundhog", version: VERSION });

  server.registerTool(
    "search_threads",
    {
      title: "Search issues, PRs, and discussions",
      description:
        "Search this repo's issue tracker and PR history for prior discussion of a problem. " +
        "Returns ranked threads with the matching excerpts and links. Everything is local — " +
        "the query is not sent anywhere.",
      inputSchema: searchThreadsSchema,
    },
    async (args) => guard(() => searchThreads(pool, args)),
  );

  server.registerTool(
    "get_thread",
    {
      title: "Read a full thread",
      description:
        "Return one issue, PR, or discussion in full, with every comment in order, from the local index.",
      inputSchema: getThreadSchema,
    },
    async (args) => guard(() => getThread(pool, args)),
  );

  server.registerTool(
    "find_similar",
    {
      title: "Find prior reports of a problem",
      description:
        "Paste an error message, stack trace, or bug description to find threads that reported the " +
        "same thing before. Use this to answer 'has anyone hit this?' — results favour threads that " +
        "were actually resolved.",
      inputSchema: findSimilarSchema,
    },
    async (args) => guard(() => findSimilar(pool, args)),
  );

  server.registerTool(
    "sync_repo",
    {
      title: "Refresh the local index",
      description:
        "Fetch threads that changed since the last sync. The only tool here that touches the network.",
      inputSchema: syncRepoSchema,
    },
    async (args) => guard(() => syncRepo(pool, args)),
  );

  server.registerTool(
    "list_repos",
    {
      title: "List indexed repos",
      description: "Which repos are indexed locally, how big each index is, and how fresh.",
      inputSchema: listReposSchema,
    },
    async () => guard(() => listRepos(pool)),
  );

  return { server, pool };
}

/** Runs the server on stdio until the client disconnects. */
export async function serve(): Promise<void> {
  const { server, pool } = createServer();

  const shutdown = (): void => {
    pool.closeAll();
    void server.close();
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  await server.connect(new StdioServerTransport());
}
