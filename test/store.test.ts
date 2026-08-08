import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/store/db.ts";
import { dbPath } from "../src/store/paths.ts";
import { parseRepoRef, threadId } from "../src/types.ts";
import type { Thread, Message } from "../src/types.ts";

const repo = parseRepoRef("acme/widgets");

function makeThread(number: number, over: Partial<Thread> = {}): Thread {
  return {
    id: threadId("issue", number),
    number,
    kind: "issue",
    title: `Issue ${number}`,
    body: "body text",
    state: "open",
    author: "octocat",
    labels: ["bug"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    closedAt: null,
    merged: false,
    url: `https://github.com/acme/widgets/issues/${number}`,
    resolutionRef: null,
    commentCount: 0,
    ...over,
  };
}

test("parseRepoRef accepts slugs, hosts, and URLs", () => {
  assert.deepEqual(parseRepoRef("acme/widgets"), {
    host: "github.com",
    owner: "acme",
    name: "widgets",
  });
  assert.deepEqual(parseRepoRef("https://github.com/acme/widgets.git"), {
    host: "github.com",
    owner: "acme",
    name: "widgets",
  });
  assert.throws(() => parseRepoRef("widgets"));
});

test("migrations bring a fresh db to the current version", () => {
  const store = Store.memory(repo);
  const version = store.raw.pragma("user_version", { simple: true });
  assert.equal(version, 1);
  store.close();
});

test("upsertThread inserts then updates in place", () => {
  const store = Store.memory(repo);
  store.upsertThread(makeThread(1));
  store.upsertThread(makeThread(1, { title: "Renamed", state: "closed" }));

  const got = store.getThread("issue:1");
  assert.equal(got?.title, "Renamed");
  assert.equal(got?.state, "closed");
  assert.deepEqual(got?.labels, ["bug"]);
  assert.equal(store.stats().threads, 1);
  store.close();
});

test("messages are replaced wholesale and stay ordered", () => {
  const store = Store.memory(repo);
  store.upsertThread(makeThread(2));

  const msg = (id: string, ord: number): Message => ({
    id,
    threadId: "issue:2",
    kind: "comment",
    author: "dev",
    body: `comment ${ord}`,
    createdAt: "2026-01-01T00:00:00Z",
    url: null,
    ord,
  });

  store.replaceMessages("issue:2", [msg("a", 0), msg("b", 1)]);
  store.replaceMessages("issue:2", [msg("c", 0)]);

  const got = store.getMessages("issue:2");
  assert.equal(got.length, 1);
  assert.equal(got[0]?.id, "c");
  store.close();
});

test("chunks stay in sync with the fts index", () => {
  const store = Store.memory(repo);
  store.upsertThread(makeThread(3));

  const ids = store.replaceChunks("issue:3", [
    { threadId: "issue:3", messageId: null, ord: 0, text: "ENOENT no such file", tokenEst: 5 },
    { threadId: "issue:3", messageId: null, ord: 1, text: "unrelated prose", tokenEst: 3 },
  ]);
  assert.equal(ids.length, 2);

  const hits = store.raw
    .prepare("SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ?")
    .all("ENOENT") as { rowid: number }[];
  assert.deepEqual(hits.map((h) => h.rowid), [ids[0]]);

  // Re-chunking must not leave orphaned fts rows behind.
  store.replaceChunks("issue:3", [
    { threadId: "issue:3", messageId: null, ord: 0, text: "totally different", tokenEst: 2 },
  ]);
  const after = store.raw
    .prepare("SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH ?")
    .get("ENOENT") as { n: number };
  assert.equal(after.n, 0);
  store.close();
});

test("deleting a thread cascades to messages, chunks, and vectors", () => {
  const store = Store.memory(repo);
  store.upsertThread(makeThread(4));
  store.replaceMessages("issue:4", [
    {
      id: "m1",
      threadId: "issue:4",
      kind: "comment",
      author: null,
      body: "x",
      createdAt: "2026-01-01T00:00:00Z",
      url: null,
      ord: 0,
    },
  ]);
  const [chunkId] = store.replaceChunks("issue:4", [
    { threadId: "issue:4", messageId: "m1", ord: 0, text: "x", tokenEst: 1 },
  ]);
  store.putVectors([{ chunkId: chunkId!, vector: new Float32Array([1, 0]) }]);

  store.deleteThread("issue:4");
  const s = store.stats();
  assert.equal(s.threads, 0);
  assert.equal(s.messages, 0);
  assert.equal(s.chunks, 0);
  assert.equal(s.vectors, 0);
  store.close();
});

test("vectors round-trip into a contiguous matrix", () => {
  const store = Store.memory(repo);
  store.upsertThread(makeThread(5));
  const ids = store.replaceChunks("issue:5", [
    { threadId: "issue:5", messageId: null, ord: 0, text: "a", tokenEst: 1 },
    { threadId: "issue:5", messageId: null, ord: 1, text: "b", tokenEst: 1 },
  ]);
  store.putVectors([
    { chunkId: ids[0]!, vector: new Float32Array([1, 2, 3]) },
    { chunkId: ids[1]!, vector: new Float32Array([4, 5, 6]) },
  ]);

  const loaded = store.loadVectorMatrix();
  assert.ok(loaded);
  assert.equal(loaded.dim, 3);
  assert.deepEqual([...loaded.ids], [ids[0], ids[1]]);
  assert.deepEqual([...loaded.matrix], [1, 2, 3, 4, 5, 6]);
  store.close();
});

test("cursors only move forward", () => {
  const store = Store.memory(repo);
  store.setCursor("issue", "2026-01-05T00:00:00Z");
  store.setCursor("issue", "2026-01-01T00:00:00Z");
  assert.equal(store.getCursor("issue"), "2026-01-05T00:00:00Z");
  assert.equal(store.getCursor("pr"), null);
  store.close();
});

test("staleThreadIds finds threads that changed since indexing", () => {
  const store = Store.memory(repo);
  store.upsertThread(makeThread(6));
  assert.deepEqual(store.staleThreadIds(), ["issue:6"]);

  store.markIndexed("issue:6", "2026-01-03T00:00:00Z");
  assert.deepEqual(store.staleThreadIds(), []);

  store.upsertThread(makeThread(6, { updatedAt: "2026-01-04T00:00:00Z" }));
  assert.deepEqual(store.staleThreadIds(), ["issue:6"]);
  store.close();
});

test("a read-only open refuses a schema it cannot read", () => {
  const dir = mkdtempSync(join(tmpdir(), "groundhog-schema-"));
  const previous = process.env["GROUNDHOG_DATA_DIR"];
  process.env["GROUNDHOG_DATA_DIR"] = dir;
  try {
    const store = Store.open(repo);
    store.upsertThread(makeThread(1));
    store.close();

    // Tampering goes through a raw handle: Store.open itself refuses the
    // versions being staged here.
    const setVersion = (version: number): void => {
      const raw = new Database(dbPath(repo));
      raw.pragma(`user_version = ${version}`);
      raw.close();
    };

    setVersion(99); // as if a future build wrote it
    assert.throws(() => Store.open(repo, { readonly: true }), /newer Groundhog/);

    setVersion(0); // as if an older build left it behind
    assert.throws(() => Store.open(repo, { readonly: true }), /older schema/);

    // A rejected open must not leave the handle open — on Windows that locks
    // the file, so the next command reports EBUSY instead of the real reason.
    setVersion(1);
    const reopened = Store.open(repo, { readonly: true });
    assert.equal(reopened.getThread("issue:1")?.number, 1);
    reopened.close();
  } finally {
    if (previous === undefined) delete process.env["GROUNDHOG_DATA_DIR"];
    else process.env["GROUNDHOG_DATA_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
