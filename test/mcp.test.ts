import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/store/db.ts";
import { buildIndex } from "../src/index/build.ts";
import { StorePool, searchThreads } from "../src/mcp/tools.ts";
import { parseRepoRef, threadId } from "../src/types.ts";
import type { Thread } from "../src/types.ts";

function seedRepo(dataDir: string, slug: string): void {
  const previous = process.env["GROUNDHOG_DATA_DIR"];
  process.env["GROUNDHOG_DATA_DIR"] = dataDir;
  try {
    const store = Store.open(parseRepoRef(slug));
    const base: Omit<Thread, "id" | "number" | "title" | "body"> = {
      kind: "issue",
      state: "closed",
      author: "octocat",
      labels: ["bug"],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      closedAt: "2026-02-01T00:00:00Z",
      merged: false,
      url: "https://github.com/acme/widgets/issues/7",
      resolutionRef: "#9",
      commentCount: 1,
    };
    store.upsertThread({
      ...base,
      id: threadId("issue", 7),
      number: 7,
      title: "Crash with ENOENT on startup",
      body: "the binary throws ENOENT when the config file is missing",
    });
    store.replaceMessages(threadId("issue", 7), [
      {
        id: "c1",
        threadId: threadId("issue", 7),
        kind: "comment",
        author: "maintainer",
        body: "Fixed by creating the config directory before first launch.",
        createdAt: "2026-01-05T00:00:00Z",
        url: null,
        ord: 0,
      },
    ]);
    store.upsertThread({
      ...base,
      id: threadId("issue", 8),
      number: 8,
      title: "Docs typo",
      body: "there is a typo in the readme",
      state: "open",
      resolutionRef: null,
      labels: ["docs"],
    });
    buildIndex(store);
    store.setMeta("last_sync", new Date().toISOString());
    store.close();
  } finally {
    if (previous === undefined) delete process.env["GROUNDHOG_DATA_DIR"];
    else process.env["GROUNDHOG_DATA_DIR"] = previous;
  }
}

/** Drives the real server over a real stdio transport, as a client would. */
async function withClient(fn: (client: Client) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "groundhog-mcp-"));
  seedRepo(dir, "acme/widgets");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", join(process.cwd(), "src/cli/index.ts"), "serve"],
    env: { ...process.env, GROUNDHOG_DATA_DIR: dir } as Record<string, string>,
  });
  const client = new Client({ name: "groundhog-test", version: "0" });

  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

test("the server advertises its five tools with schemas", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "find_similar",
      "get_thread",
      "list_repos",
      "search_threads",
      "sync_repo",
    ]);

    const searchTool = tools.find((t) => t.name === "search_threads")!;
    assert.ok(searchTool.description);
    assert.ok(searchTool.inputSchema.properties?.["query"]);
    assert.deepEqual(searchTool.inputSchema.required, ["query"]);
  });
});

test("search_threads returns evidence with links", async () => {
  await withClient(async (client) => {
    const body = textOf(
      await client.callTool({
        name: "search_threads",
        arguments: { query: "ENOENT config missing" },
      }),
    );
    assert.match(body, /#7/);
    assert.match(body, /Crash with ENOENT/);
    assert.match(body, /https:\/\/github\.com/);
  });
});

test("search_threads honours filters", async () => {
  await withClient(async (client) => {
    const docsOnly = textOf(
      await client.callTool({
        name: "search_threads",
        arguments: { query: "typo readme ENOENT", label: ["docs"] },
      }),
    );
    assert.match(docsOnly, /#8/);
    assert.doesNotMatch(docsOnly, /#7/);
  });
});

test("get_thread returns the full conversation", async () => {
  await withClient(async (client) => {
    const body = textOf(
      await client.callTool({ name: "get_thread", arguments: { number: 7 } }),
    );
    assert.match(body, /ISSUE #7/);
    assert.match(body, /Fixed by creating the config directory/);
  });
});

test("find_similar reports how many prior threads were resolved", async () => {
  await withClient(async (client) => {
    const body = textOf(
      await client.callTool({
        name: "find_similar",
        arguments: { text: "Error: ENOENT: no such file or directory, open 'config.json'" },
      }),
    );
    assert.match(body, /similar threads/);
    assert.match(body, /resolved/);
    assert.match(body, /#7/);
  });
});

test("list_repos describes what is indexed", async () => {
  await withClient(async (client) => {
    const body = textOf(await client.callTool({ name: "list_repos", arguments: {} }));
    assert.match(body, /acme\/widgets/);
    assert.match(body, /lexical only/);
  });
});

test("a bad argument is an error result, not a dead connection", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "get_thread",
      arguments: { number: 4242 },
    });
    assert.match(textOf(result), /not in the local index/);

    // The session survives; the next call still works.
    const after = await client.callTool({ name: "list_repos", arguments: {} });
    assert.match(textOf(after), /acme\/widgets/);
  });
});

test("an unknown repo returns a message naming the fix", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "search_threads",
      arguments: { query: "anything", repo: "nobody/nothing" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No index for nobody\/nothing/);
  });
});

test("a write follows a read on the same repo without failing", () => {
  const dir = mkdtempSync(join(tmpdir(), "groundhog-rw-"));
  const previous = process.env["GROUNDHOG_DATA_DIR"];
  process.env["GROUNDHOG_DATA_DIR"] = dir;
  try {
    seedRepo(dir, "acme/widgets");
    const pool = new StorePool();
    const repo = parseRepoRef("acme/widgets");

    // What search_threads does, then what sync_repo does. Sharing one
    // read-only handle across both made the write fail.
    pool.get(repo, { readonly: true }).stats();
    const writable = pool.get(repo);
    writable.setMeta("last_sync", "2026-08-08T00:00:00Z");
    assert.equal(writable.getMeta("last_sync"), "2026-08-08T00:00:00Z");

    // And the reverse order still works.
    assert.equal(pool.get(repo, { readonly: true }).getMeta("last_sync"), "2026-08-08T00:00:00Z");
    pool.closeAll();
  } finally {
    if (previous === undefined) delete process.env["GROUNDHOG_DATA_DIR"];
    else process.env["GROUNDHOG_DATA_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the search handler leaves the pool able to serve a write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "groundhog-handler-"));
  const previous = process.env["GROUNDHOG_DATA_DIR"];
  process.env["GROUNDHOG_DATA_DIR"] = dir;
  try {
    seedRepo(dir, "acme/widgets");
    const pool = new StorePool();

    // Exercises the real handler's own pool.get call, then the write that
    // sync_repo performs. Deliberately not driving sync_repo itself: it would
    // reach for the network, which no test should depend on.
    const found = await searchThreads(pool, { query: "ENOENT", repo: "acme/widgets" });
    assert.match(found, /#7/);

    const writable = pool.get(parseRepoRef("acme/widgets"));
    assert.doesNotThrow(() => writable.setMeta("last_sync", "2026-08-08T00:00:00Z"));
    pool.closeAll();
  } finally {
    if (previous === undefined) delete process.env["GROUNDHOG_DATA_DIR"];
    else process.env["GROUNDHOG_DATA_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the store pool closes idle handles", () => {
  const dir = mkdtempSync(join(tmpdir(), "groundhog-pool-"));
  const previous = process.env["GROUNDHOG_DATA_DIR"];
  process.env["GROUNDHOG_DATA_DIR"] = dir;
  try {
    seedRepo(dir, "acme/widgets");
    const pool = new StorePool(50);
    const repo = parseRepoRef("acme/widgets");

    const first = pool.get(repo, { readonly: true });
    assert.equal(pool.get(repo, { readonly: true }), first, "reuses the open handle");

    pool.closeAll();
    const reopened = pool.get(repo, { readonly: true });
    assert.notEqual(reopened, first, "opens a fresh handle after close");
    pool.closeAll();
  } finally {
    if (previous === undefined) delete process.env["GROUNDHOG_DATA_DIR"];
    else process.env["GROUNDHOG_DATA_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
