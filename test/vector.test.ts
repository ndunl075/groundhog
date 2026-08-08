import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.ts";
import { buildIndex } from "../src/index/build.ts";
import { VectorIndex, vectorSearch, invalidateVectorIndex } from "../src/search/vector.ts";
import { rrf } from "../src/search/fuse.ts";
import { parseRepoRef, threadId } from "../src/types.ts";
import type { Thread, Chunk } from "../src/types.ts";
import type { ChunkHit } from "../src/search/types.ts";

const repo = parseRepoRef("acme/widgets");

function seed(store: Store, number: number, title: string, body: string, over: Partial<Thread> = {}): void {
  store.upsertThread({
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
    url: `https://x/${number}`,
    resolutionRef: null,
    commentCount: 0,
    ...over,
  } as Thread);
}

/** Deterministic unit vectors — no model, so the test stays fast and offline. */
function unit(...values: number[]): Float32Array {
  const v = Float32Array.from(values);
  const norm = Math.hypot(...values) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

function embedAll(store: Store, vectors: Record<string, Float32Array>): Chunk[] {
  const chunks = store.raw.prepare("SELECT * FROM chunk").all() as {
    id: number;
    thread_id: string;
  }[];
  store.putVectors(
    chunks.map((c) => ({ chunkId: c.id, vector: vectors[c.thread_id] ?? unit(0, 0, 1) })),
  );
  invalidateVectorIndex(store);
  return [];
}

function corpus(): Store {
  const store = Store.memory(repo);
  seed(store, 1, "Cannot log in", "authentication fails at the sign-in screen");
  seed(store, 2, "Slow build times", "webpack takes ten minutes");
  seed(store, 3, "Dark mode toggle", "theme switching does not persist");
  buildIndex(store);
  embedAll(store, {
    "issue:1": unit(1, 0, 0),
    "issue:2": unit(0, 1, 0),
    "issue:3": unit(0, 0, 1),
  });
  return store;
}

test("vector search ranks by cosine similarity", () => {
  const store = corpus();
  const hits = vectorSearch(store, unit(0.9, 0.1, 0), 3);

  assert.equal(hits.length, 3);
  assert.equal(hits[0]!.threadId, "issue:1");
  assert.ok(hits[0]!.score > hits[1]!.score);
  assert.deepEqual(hits.map((h) => h.rank), [1, 2, 3]);
  store.close();
});

test("vector search honours the limit", () => {
  const store = corpus();
  assert.equal(vectorSearch(store, unit(1, 0, 0), 1).length, 1);
  assert.equal(vectorSearch(store, unit(1, 0, 0), 2).length, 2);
  store.close();
});

test("top-k selection is correct when the best result arrives last", () => {
  const store = Store.memory(repo);
  for (let i = 1; i <= 20; i++) seed(store, i, `Issue ${i}`, `body ${i}`);
  buildIndex(store);

  const chunks = store.raw.prepare("SELECT id, thread_id FROM chunk ORDER BY id").all() as {
    id: number;
    thread_id: string;
  }[];
  // Similarity increases with insertion order, so the winner is scanned last.
  store.putVectors(
    chunks.map((c, i) => ({ chunkId: c.id, vector: unit(1, (chunks.length - i) * 0.5) })),
  );
  invalidateVectorIndex(store);

  const hits = vectorSearch(store, unit(1, 0), 3);
  assert.equal(hits[0]!.chunkId, chunks[chunks.length - 1]!.id);
  assert.ok(hits[0]!.score >= hits[1]!.score);
  assert.ok(hits[1]!.score >= hits[2]!.score);
  store.close();
});

test("filters restrict the vector scan", () => {
  const store = Store.memory(repo);
  seed(store, 1, "Cannot log in", "auth fails", { labels: ["bug"] });
  seed(store, 2, "Slow build", "webpack slow", { labels: ["perf"] });
  buildIndex(store);
  embedAll(store, { "issue:1": unit(1, 0, 0), "issue:2": unit(0, 1, 0) });

  const hits = vectorSearch(store, unit(1, 0, 0), 10, { labels: ["perf"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.threadId, "issue:2");
  store.close();
});

test("a dimension mismatch is reported, not silently wrong", () => {
  const store = corpus();
  assert.throws(() => vectorSearch(store, unit(1, 0), 3), /dims/);
  store.close();
});

test("no vectors means no semantic hits, not an error", () => {
  const store = Store.memory(repo);
  seed(store, 1, "Cannot log in", "auth fails");
  buildIndex(store);
  assert.deepEqual(vectorSearch(store, unit(1, 0, 0), 5), []);
  assert.equal(VectorIndex.load(store), null);
  store.close();
});

test("rrf rewards agreement between retrievers over either one's top hit", () => {
  const hit = (chunkId: number, rank: number): ChunkHit => ({
    chunkId,
    threadId: `issue:${chunkId}`,
    score: 1 / rank,
    rank,
  });

  // 2 is second on both lists; 1 and 3 are first on one and absent from the other.
  const fused = rrf([
    [hit(1, 1), hit(2, 2)],
    [hit(3, 1), hit(2, 2)],
  ]);

  assert.equal(fused[0]!.chunkId, 2);
  assert.deepEqual(fused.map((f) => f.rank), [1, 2, 3]);
});

test("rrf keeps the excerpt from whichever retriever supplied one", () => {
  const fused = rrf([
    [{ chunkId: 7, threadId: "issue:7", score: 0.5, rank: 1 }],
    [{ chunkId: 7, threadId: "issue:7", score: 0.9, rank: 1, excerpt: "the match" }],
  ]);
  assert.equal(fused.length, 1);
  assert.equal(fused[0]!.excerpt, "the match");
});
