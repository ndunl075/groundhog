import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.ts";
import { sync } from "../src/ingest/sync.ts";
import type { Forge, IngestedThread, FetchOptions } from "../src/ingest/types.ts";
import { parseRepoRef, threadId } from "../src/types.ts";
import type { ThreadKind } from "../src/types.ts";

const repo = parseRepoRef("acme/widgets");

function ingested(number: number, updatedAt: string, comments = 0): IngestedThread {
  const id = threadId("issue", number);
  return {
    thread: {
      id,
      number,
      kind: "issue",
      title: `Issue ${number}`,
      body: "body",
      state: "open",
      author: "octocat",
      labels: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt,
      closedAt: null,
      merged: false,
      url: `https://x/${number}`,
      resolutionRef: null,
      commentCount: comments,
    },
    messages: Array.from({ length: comments }, (_, i) => ({
      id: `${id}-c${i}`,
      threadId: id,
      kind: "comment" as const,
      author: "dev",
      body: `comment ${i}`,
      createdAt: "2026-01-01T00:00:00Z",
      url: null,
      ord: i,
    })),
    truncated: false,
  };
}

/** Records the `since` it was called with so cursor behaviour is observable. */
class FakeForge implements Forge {
  readonly host = "github.com";
  seenSince: (string | undefined)[] = [];
  private readonly items: IngestedThread[];

  constructor(items: IngestedThread[]) {
    this.items = items;
  }

  async supportedKinds(): Promise<ThreadKind[]> {
    return ["issue"];
  }

  async *fetchThreads(_kind: ThreadKind, opts: FetchOptions) {
    this.seenSince.push(opts.since);
    for (const item of this.items) {
      if (opts.since && item.thread.updatedAt <= opts.since) return;
      yield item;
    }
  }
}

test("sync stores threads and messages, and records a cursor", async () => {
  const store = Store.memory(repo);
  const forge = new FakeForge([
    ingested(3, "2026-02-03T00:00:00Z", 2),
    ingested(2, "2026-02-02T00:00:00Z"),
  ]);

  const result = await sync(store, {}, forge);

  assert.equal(result.fetched, 2);
  assert.equal(result.byKind["issue"], 2);
  assert.equal(store.getCursor("issue"), "2026-02-03T00:00:00Z");
  assert.equal(store.getMessages("issue:3").length, 2);
  assert.ok(store.getMeta("last_sync"));
  store.close();
});

test("a second sync passes the cursor and stops at unchanged threads", async () => {
  const store = Store.memory(repo);
  const first = [ingested(3, "2026-02-03T00:00:00Z"), ingested(2, "2026-02-02T00:00:00Z")];
  await sync(store, {}, new FakeForge(first));

  const forge = new FakeForge([
    ingested(4, "2026-02-05T00:00:00Z"),
    ...first, // already seen; must be cut off by the cursor
  ]);
  const result = await sync(store, {}, forge);

  assert.deepEqual(forge.seenSince, ["2026-02-03T00:00:00Z"]);
  assert.equal(result.fetched, 1);
  assert.equal(store.stats().threads, 3);
  assert.equal(store.getCursor("issue"), "2026-02-05T00:00:00Z");
  store.close();
});

test("full sync ignores the cursor", async () => {
  const store = Store.memory(repo);
  await sync(store, {}, new FakeForge([ingested(1, "2026-02-01T00:00:00Z")]));

  const forge = new FakeForge([ingested(1, "2026-02-01T00:00:00Z")]);
  const result = await sync(store, { full: true }, forge);

  assert.deepEqual(forge.seenSince, [undefined]);
  assert.equal(result.fetched, 1);
  store.close();
});

test("re-syncing an edited thread replaces its messages", async () => {
  const store = Store.memory(repo);
  await sync(store, {}, new FakeForge([ingested(1, "2026-02-01T00:00:00Z", 3)]));
  assert.equal(store.getMessages("issue:1").length, 3);

  await sync(store, { full: true }, new FakeForge([ingested(1, "2026-02-02T00:00:00Z", 1)]));
  assert.equal(store.getMessages("issue:1").length, 1);
  assert.equal(store.stats().threads, 1);
  store.close();
});

test("unsupported kinds are skipped", async () => {
  const store = Store.memory(repo);
  const result = await sync(
    store,
    { kinds: ["discussion"] },
    new FakeForge([ingested(1, "2026-02-01T00:00:00Z")]),
  );
  assert.equal(result.fetched, 0);
  store.close();
});
