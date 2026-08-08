import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.ts";
import { buildIndex } from "../src/index/build.ts";
import { search } from "../src/search/index.ts";
import { packEvidence, renderEvidence, renderThread, headerLine } from "../src/pack/context.ts";
import { parseRepoRef, threadId } from "../src/types.ts";
import type { Thread } from "../src/types.ts";

const repo = parseRepoRef("acme/widgets");

function seed(store: Store, number: number, title: string, body: string, over: Partial<Thread> = {}): Thread {
  const t = {
    id: threadId(over.kind ?? "issue", number),
    number,
    kind: "issue",
    title,
    body,
    state: "open",
    author: "octocat",
    labels: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    closedAt: null,
    merged: false,
    url: `https://github.com/acme/widgets/issues/${number}`,
    resolutionRef: null,
    commentCount: 0,
    ...over,
  } as Thread;
  store.upsertThread(t);
  return t;
}

function corpus(): Store {
  const store = Store.memory(repo);
  for (let i = 1; i <= 5; i++) {
    seed(store, i, `Timeout number ${i}`, `the request times out after 30 seconds, attempt ${i}`);
    store.replaceMessages(threadId("issue", i), [
      {
        id: `c${i}a`,
        threadId: threadId("issue", i),
        kind: "comment",
        author: "dev",
        body: `first reply about the timeout in case ${i}`,
        createdAt: "2026-01-02T00:00:00Z",
        url: null,
        ord: 0,
      },
      {
        id: `c${i}b`,
        threadId: threadId("issue", i),
        kind: "comment",
        author: "other",
        body: `second reply, the timeout is caused by a slow upstream in case ${i}`,
        createdAt: "2026-01-03T00:00:00Z",
        url: null,
        ord: 1,
      },
    ]);
  }
  buildIndex(store);
  return store;
}

test("packing fills breadth-first before depth", async () => {
  const store = corpus();
  const hits = await search(store, "request times out slow upstream", { limit: 5 });
  assert.ok(hits.length >= 3);

  const packed = packEvidence(store, hits, { budget: 4000 });
  assert.equal(packed.items.length, hits.length);
  // Every thread got its first excerpt.
  for (const item of packed.items) assert.ok(item.excerpts.length >= 1);
  store.close();
});

test("a tight budget spreads across threads instead of exhausting one", async () => {
  const store = corpus();
  const hits = await search(store, "request times out slow upstream", { limit: 5 });

  const packed = packEvidence(store, hits, { budget: 200, excerptTokens: 20 });
  assert.ok(packed.items.length >= 2, "should cover several threads");
  // Nothing got a deep dive while others had nothing.
  const depths = packed.items.map((i) => i.excerpts.length);
  assert.ok(Math.max(...depths) - Math.min(...depths) <= 1);
  store.close();
});

test("packing stays within budget and reports truncation", async () => {
  const store = corpus();
  const hits = await search(store, "timeout", { limit: 5 });

  const packed = packEvidence(store, hits, { budget: 60, excerptTokens: 15 });
  assert.ok(packed.tokensUsed <= 60, `used ${packed.tokensUsed}`);
  assert.equal(packed.truncated, true);
  store.close();
});

test("an empty result set packs to nothing, not an error", () => {
  const store = corpus();
  const packed = packEvidence(store, []);
  assert.deepEqual(packed.items, []);
  assert.equal(packed.tokensUsed, 0);
  assert.equal(renderEvidence(packed), "No matching threads.");
  store.close();
});

test("headers carry state, resolution, and freshness", () => {
  const store = Store.memory(repo);
  const t = seed(store, 42, "Boom", "it booms", {
    state: "closed",
    resolutionRef: "#99",
    commentCount: 7,
  });
  const line = headerLine(t);
  assert.match(line, /#42/);
  assert.match(line, /closed/);
  assert.match(line, /resolved by #99/);
  assert.match(line, /7 comments/);
  assert.match(line, /2026-06-01/);
  store.close();
});

test("rendered evidence quotes and cites, and never summarises", async () => {
  const store = corpus();
  const hits = await search(store, "slow upstream timeout", { limit: 2 });
  const text = renderEvidence(packEvidence(store, hits));

  assert.match(text, /#\d+ · issue/);
  assert.match(text, /https:\/\/github\.com\/acme\/widgets\/issues\//);
  assert.match(text, /"/); // excerpts are quoted verbatim
  store.close();
});

test("renderThread reconstructs the whole conversation in order", () => {
  const store = corpus();
  const thread = store.getThread("issue:1")!;
  const text = renderThread(store, thread);

  assert.match(text, /ISSUE #1: Timeout number 1/);
  assert.match(text, /opened by octocat on 2026-01-01/);
  assert.ok(text.indexOf("first reply") < text.indexOf("second reply"));
  store.close();
});

test("renderThread handles a thread with no body or comments", () => {
  const store = Store.memory(repo);
  const t = seed(store, 1, "Empty", "");
  const text = renderThread(store, t);
  assert.match(text, /\(no description\)/);
  store.close();
});
