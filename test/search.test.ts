import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.ts";
import { buildIndex } from "../src/index/build.ts";
import { search, searchBm25, parseQuery, referencedNumbers } from "../src/search/index.ts";
import { errorNeedles, looksLikeChangeQuery, rollup } from "../src/search/rollup.ts";
import { parseRepoRef, threadId } from "../src/types.ts";
import type { Thread } from "../src/types.ts";

const repo = parseRepoRef("acme/widgets");

function seed(store: Store, over: Partial<Thread> & { number: number }): Thread {
  const t: Thread = {
    id: threadId(over.kind ?? "issue", over.number),
    kind: "issue",
    title: "",
    body: "",
    state: "open",
    author: "octocat",
    labels: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    closedAt: null,
    merged: false,
    url: `https://x/${over.number}`,
    resolutionRef: null,
    commentCount: 0,
    ...over,
  } as Thread;
  store.upsertThread(t);
  return t;
}

function corpus(): Store {
  const store = Store.memory(repo);
  seed(store, {
    number: 1,
    title: "Crash on startup with ENOENT",
    body: "Running the CLI throws Error: ENOENT: no such file or directory, open 'config.json'.",
    state: "closed",
    resolutionRef: "#5",
    labels: ["bug"],
  });
  seed(store, {
    number: 2,
    title: "Docs: explain the config file",
    body: "The readme should describe where config.json lives.",
    labels: ["docs"],
  });
  seed(store, {
    number: 3,
    title: "Hydration mismatch in production build",
    body: "Text content does not match server-rendered HTML after upgrading.",
    labels: ["bug"],
  });
  seed(store, {
    number: 4,
    kind: "pr",
    title: "Refactor the config loader",
    body: "Changed how config.json is resolved so ENOENT surfaces earlier.",
    state: "merged",
    merged: true,
    resolutionRef: "merged",
  });
  buildIndex(store);
  return store;
}

test("parseQuery drops stopwords and quotes every term", () => {
  const parsed = parseQuery("has anyone hit this ENOENT bug before");
  assert.equal(parsed.terms.includes("ENOENT"), true);
  assert.equal(parsed.terms.includes("has"), false);
  assert.equal(parsed.terms.includes("this"), false);
  assert.match(parsed.match!, /"ENOENT"/);
});

test("parseQuery survives input that is not valid FTS5 syntax", () => {
  for (const bad of ['unbalanced " quote', "NEAR(", "a AND OR b", "*", "^^^", "#123"]) {
    const store = corpus();
    assert.doesNotThrow(() => searchBm25(store, bad));
    store.close();
  }
});

test("parseQuery keeps explicit phrases intact", () => {
  const parsed = parseQuery('why does "text content does not match" happen');
  assert.deepEqual(parsed.phrases, ["text content does not match"]);
  assert.match(parsed.match!, /"text content does not match"/);
});

test("an all-stopword query returns nothing rather than everything", () => {
  const store = corpus();
  assert.equal(parseQuery("what is it").match, null);
  assert.deepEqual(search(store, "what is it"), []);
  store.close();
});

test("referencedNumbers extracts issue references", () => {
  assert.deepEqual(referencedNumbers("dupe of #1234 and #7"), [1234, 7]);
  assert.deepEqual(referencedNumbers("no refs"), []);
});

test("search finds the thread that quotes the error", () => {
  const store = corpus();
  const hits = search(store, "ENOENT no such file");
  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.thread.number, 1);
  store.close();
});

test("results carry the matching chunks as evidence", () => {
  const store = corpus();
  const hits = search(store, "hydration mismatch server-rendered");
  assert.equal(hits[0]!.thread.number, 3);
  assert.ok(hits[0]!.chunks.length > 0);
  assert.ok(hits[0]!.chunks[0]!.excerpt);
  store.close();
});

test("filters are applied before ranking", () => {
  const store = corpus();

  const prs = search(store, "config", { filters: { kind: "pr" } });
  assert.ok(prs.every((h) => h.thread.kind === "pr"));
  assert.ok(prs.length > 0);

  const docs = search(store, "config", { filters: { labels: ["docs"] } });
  assert.deepEqual(docs.map((h) => h.thread.number), [2]);

  const open = search(store, "config", { filters: { state: "open" } });
  assert.ok(open.every((h) => h.thread.state === "open"));

  const none = search(store, "config", { filters: { since: "2027-01-01T00:00:00Z" } });
  assert.deepEqual(none, []);
  store.close();
});

test("a resolved thread outranks an unresolved one on an equal match", () => {
  const store = Store.memory(repo);
  seed(store, { number: 1, title: "Widget explodes", body: "the widget explodes on load" });
  seed(store, {
    number: 2,
    title: "Widget explodes",
    body: "the widget explodes on load",
    state: "closed",
    resolutionRef: "#9",
  });
  buildIndex(store);

  const hits = search(store, "widget explodes on load");
  assert.equal(hits[0]!.thread.number, 2);
  assert.ok(hits[0]!.score > hits[1]!.score);
  store.close();
});

test("boosts can be turned off", () => {
  const store = Store.memory(repo);
  seed(store, { number: 1, title: "Widget explodes", body: "the widget explodes on load" });
  seed(store, {
    number: 2,
    title: "Widget explodes",
    body: "the widget explodes on load",
    state: "closed",
    resolutionRef: "#9",
  });
  buildIndex(store);

  const raw = search(store, "widget explodes on load", { raw: true });
  assert.equal(raw[0]!.score, raw[1]!.score);
  store.close();
});

test("errorNeedles picks identifiers, not prose", () => {
  const needles = errorNeedles(parseQuery("ENOENT TypeError Object.assign broken widget"));
  assert.ok(needles.includes("ENOENT"));
  assert.ok(needles.includes("TypeError"));
  assert.ok(needles.includes("Object.assign"));
  assert.ok(!needles.includes("broken"));
});

test("looksLikeChangeQuery routes change questions toward PRs", () => {
  assert.ok(looksLikeChangeQuery(parseQuery("why was the loader refactored")));
  assert.ok(!looksLikeChangeQuery(parseQuery("crash on startup ENOENT")));
});

test("a thread matching in several chunks outranks a single lucky hit", () => {
  const store = Store.memory(repo);
  seed(store, { number: 1, title: "Sporadic timeout", body: "timeout happens" });
  seed(store, {
    number: 2,
    title: "Sporadic timeout",
    body: "timeout happens",
  });
  store.replaceMessages("issue:2", [
    {
      id: "c1",
      threadId: "issue:2",
      kind: "comment",
      author: "dev",
      body: "another timeout report, timeout again on the same path",
      createdAt: "2026-01-02T00:00:00Z",
      url: null,
      ord: 0,
    },
  ]);
  buildIndex(store);

  const hits = search(store, "sporadic timeout");
  assert.equal(hits[0]!.thread.number, 2);
  assert.ok(hits[0]!.chunks.length > 1);
  store.close();
});

test("recency decay is mild and breaks ties only", () => {
  const store = Store.memory(repo);
  seed(store, { number: 1, title: "Flaky test", body: "flaky test on CI", updatedAt: "2020-01-01T00:00:00Z" });
  seed(store, { number: 2, title: "Flaky test", body: "flaky test on CI", updatedAt: "2026-08-01T00:00:00Z" });
  buildIndex(store);

  const hits = search(store, "flaky test on CI");
  assert.equal(hits[0]!.thread.number, 2);
  // Mild: the stale thread keeps at least 85% of its score.
  assert.ok(hits[1]!.score / hits[0]!.score > 0.8);
  store.close();
});

test("rollup drops threads deleted between retrieval and ranking", () => {
  const store = corpus();
  const parsed = parseQuery("ENOENT");
  const hits = searchBm25(store, "ENOENT");
  assert.ok(hits.length > 0);

  store.deleteThread("issue:1");
  const rolled = rollup(store, hits, parsed);
  assert.ok(rolled.every((h) => h.thread.id !== "issue:1"));
  store.close();
});
