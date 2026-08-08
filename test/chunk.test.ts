import test from "node:test";
import assert from "node:assert/strict";
import { chunkThread, clean, splitText, isBot, estimateTokens } from "../src/index/chunk.ts";
import { buildIndex } from "../src/index/build.ts";
import { Store } from "../src/store/db.ts";
import { parseRepoRef, threadId } from "../src/types.ts";
import type { Message, Thread } from "../src/types.ts";

const repo = parseRepoRef("acme/widgets");

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: threadId("issue", 1),
    number: 1,
    kind: "issue",
    title: "Crash on startup",
    body: "It throws ENOENT.",
    state: "open",
    author: "octocat",
    labels: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    merged: false,
    url: "https://x/1",
    resolutionRef: null,
    commentCount: 0,
    ...over,
  };
}

function message(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    threadId: "issue:1",
    kind: "comment",
    author: "dev",
    body: "some comment",
    createdAt: "2026-01-01T00:00:00Z",
    url: null,
    ord: 0,
    ...over,
  };
}

test("head chunk carries the number, title, and body", () => {
  const chunks = chunkThread(thread(), []);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.text, /#1 Crash on startup/);
  assert.match(chunks[0]!.text, /ENOENT/);
  assert.equal(chunks[0]!.messageId, null);
  assert.equal(chunks[0]!.ord, 0);
});

test("bot comments are dropped unless kept explicitly", () => {
  const messages = [
    message({ id: "a", author: "dependabot[bot]", body: "Bumps lodash" }),
    message({ id: "b", author: "human", body: "real insight here" }),
  ];
  const text = chunkThread(thread(), messages)
    .map((c) => c.text)
    .join("\n");
  assert.match(text, /real insight/);
  assert.doesNotMatch(text, /Bumps lodash/);

  const kept = chunkThread(thread(), messages, { keepBots: true })
    .map((c) => c.text)
    .join("\n");
  assert.match(kept, /Bumps lodash/);
});

test("isBot recognises suffixes and known logins", () => {
  assert.ok(isBot("renovate[bot]"));
  assert.ok(isBot("codecov"));
  assert.ok(!isBot("octocat"));
  assert.ok(!isBot(null));
});

test("CI noise is filtered out", () => {
  const chunks = chunkThread(thread(), [
    message({ id: "a", body: "# Codecov Report\nMerging #1 will increase coverage." }),
  ]);
  assert.equal(chunks.length, 1); // head only
});

test("comments pack together but never split mid-comment", () => {
  const messages = Array.from({ length: 6 }, (_, i) =>
    message({ id: `m${i}`, body: "x".repeat(1000) }),
  );
  const chunks = chunkThread(thread(), messages, { bodyTokens: 800 });

  // 1000 chars ≈ 250 tokens, so ~3 comments per 800-token chunk.
  const commentChunks = chunks.filter((c) => c.messageId !== null);
  assert.ok(commentChunks.length >= 2 && commentChunks.length <= 4);
  for (const c of commentChunks) assert.ok(c.tokenEst <= 800);
  // Every comment survives somewhere.
  const marks = chunks.filter((c) => c.text.includes("comment by dev")).length;
  assert.ok(marks >= 2);
});

test("a fenced code block stays whole when it fits the budget", () => {
  const trace = "```\n" + Array.from({ length: 20 }, (_, i) => `  at frame${i} (a.js:${i})`).join("\n") + "\n```";
  const parts = splitText(`intro paragraph\n\n${trace}\n\noutro paragraph`, 200);
  const whole = parts.find((p) => p.includes("at frame0"));
  assert.ok(whole);
  assert.match(whole, /at frame19/); // not cut in half
});

test("splitText respects the budget and loses nothing", () => {
  const text = Array.from({ length: 40 }, (_, i) => `paragraph number ${i} with filler text`).join("\n\n");
  const parts = splitText(text, 40);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(estimateTokens(p) <= 40, `chunk over budget: ${estimateTokens(p)}`);
  for (let i = 0; i < 40; i++) {
    assert.ok(parts.some((p) => p.includes(`paragraph number ${i} `)), `lost paragraph ${i}`);
  }
});

test("an over-budget single line is hard-cut rather than dropped", () => {
  const parts = splitText("a".repeat(5000), 100);
  assert.ok(parts.length > 1);
  assert.equal(parts.join("").length, 5000);
});

test("clean strips template comments, images, and heavy quoting", () => {
  assert.equal(clean("before <!-- template --> after"), "before  after");
  assert.equal(clean("![a screenshot](http://x/y.png)"), "a screenshot");

  const quoteHeavy = "> q1\n> q2\n> q3\n> q4\n> q5\nmy actual reply";
  assert.equal(clean(quoteHeavy), "my actual reply");

  // Light quoting is context, not noise — keep it.
  const lightQuote = "> the one line I'm answering\nhere is why\nand more\nand more\nand more";
  assert.match(clean(lightQuote), /the one line/);
});

test("buildIndex chunks stale threads and skips fresh ones", () => {
  const store = Store.memory(repo);
  store.upsertThread(thread());
  store.replaceMessages("issue:1", [message()]);

  const first = buildIndex(store);
  assert.equal(first.threads, 1);
  assert.ok(first.chunks >= 1);

  const second = buildIndex(store);
  assert.equal(second.threads, 0); // nothing stale

  store.upsertThread(thread({ updatedAt: "2026-02-01T00:00:00Z", body: "new body" }));
  const third = buildIndex(store);
  assert.equal(third.threads, 1);

  const rows = store.raw.prepare("SELECT text FROM chunk").all() as { text: string }[];
  assert.ok(rows.some((r) => r.text.includes("new body")));
  assert.equal(store.stats().chunks, rows.length);
  store.close();
});

test("buildIndex --force re-chunks everything", () => {
  const store = Store.memory(repo);
  store.upsertThread(thread());
  buildIndex(store);
  assert.equal(buildIndex(store, { force: true }).threads, 1);
  store.close();
});
