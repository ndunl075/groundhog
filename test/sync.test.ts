import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.ts";
import { sync } from "../src/ingest/sync.ts";
import { mergeMessages } from "../src/ingest/github.ts";
import type { Forge, IngestedThread, FetchOptions } from "../src/ingest/types.ts";
import { parseRepoRef, threadId } from "../src/types.ts";
import type { ThreadKind, Message } from "../src/types.ts";

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

test("mergeMessages drops the GraphQL/REST overlap instead of duplicating ids", () => {
  const msg = (id: string, createdAt: string, body: string): Message => ({
    id,
    threadId: "issue:1",
    kind: "comment",
    author: "dev",
    body,
    createdAt,
    url: null,
    ord: 0,
  });

  // GraphQL returned the first two; REST page 1 returns those two again plus more.
  const inline = [msg("a", "2026-01-01T00:00:00Z", "first"), msg("b", "2026-01-02T00:00:00Z", "second")];
  const rest = [
    msg("a", "2026-01-01T00:00:00Z", "first"),
    msg("b", "2026-01-02T00:00:00Z", "second"),
    msg("c", "2026-01-03T00:00:00Z", "third"),
  ];

  const merged = mergeMessages(inline, rest);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((m) => m.id), ["a", "b", "c"]);
  assert.deepEqual(merged.map((m) => m.ord), [0, 1, 2]);
  assert.equal(new Set(merged.map((m) => m.id)).size, merged.length);
});

test("merged messages store without violating the primary key", () => {
  const store = Store.memory(repo);
  store.upsertThread(ingested(1, "2026-02-01T00:00:00Z").thread);

  const dupe = (id: string, createdAt: string): Message => ({
    id,
    threadId: "issue:1",
    kind: "comment",
    author: "dev",
    body: "text",
    createdAt,
    url: null,
    ord: 0,
  });
  const inline = [dupe("x", "2026-01-01T00:00:00Z")];
  const rest = [dupe("x", "2026-01-01T00:00:00Z"), dupe("y", "2026-01-02T00:00:00Z")];

  // Appending instead of merging is what used to throw.
  assert.throws(() => store.replaceMessages("issue:1", [...inline, ...rest]), /UNIQUE|constraint/i);
  store.replaceMessages("issue:1", mergeMessages(inline, rest));
  assert.equal(store.getMessages("issue:1").length, 2);
  store.close();
});

test("mergeMessages orders a thread chronologically regardless of source order", () => {
  const at = (id: string, createdAt: string): Message => ({
    id,
    threadId: "issue:1",
    kind: "comment",
    author: null,
    body: "b",
    createdAt,
    url: null,
    ord: 99,
  });
  const merged = mergeMessages(
    [at("late", "2026-05-01T00:00:00Z")],
    [at("early", "2026-01-01T00:00:00Z"), at("mid", "2026-03-01T00:00:00Z")],
  );
  assert.deepEqual(merged.map((m) => m.id), ["early", "mid", "late"]);
  assert.deepEqual(merged.map((m) => m.ord), [0, 1, 2]);
});
