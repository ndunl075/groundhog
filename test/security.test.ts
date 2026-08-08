import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseRepoRef } from "../src/types.ts";
import { repoDir, dataDir } from "../src/store/paths.ts";
import { GitHubForge } from "../src/ingest/github.ts";
import { isHostAllowed, assertHostAllowed, allowedHosts } from "../src/ingest/hosts.ts";
import { buildFilters } from "../src/search/bm25.ts";
import { parseQuery } from "../src/search/query.ts";

/**
 * A repo ref is attacker-reachable: it arrives as an MCP tool argument, which
 * may originate in an issue body, a web page, or anything else the caller was
 * reading. These two properties are what stop that being dangerous.
 */

test("a repo ref cannot escape the data directory", () => {
  const traversals = [
    "../../../../evil/pwned",
    "github.com/../../../etc/passwd",
    "a/..%2f..%2fb",
    "./../x",
    "a/../../b",
    ".././x",
    "github.com/./../../root/y",
  ];
  for (const input of traversals) {
    assert.throws(() => parseRepoRef(input), /Invalid|Cannot parse/, `accepted "${input}"`);
  }
});

test("path separators and dot segments are rejected outright", () => {
  for (const bad of ["..", ".", "a/..", "../b"]) {
    assert.throws(() => parseRepoRef(bad), /Invalid|Cannot parse/);
  }
});

test("every accepted ref stays inside the data directory", () => {
  const previous = process.env["GROUNDHOG_DATA_DIR"];
  process.env["GROUNDHOG_DATA_DIR"] = "/tmp/groundhog-root";
  try {
    for (const good of ["acme/widgets", "a-b/c.d", "Org_1/repo-2.x", "github.com/o/n"]) {
      // resolve() both sides: the env value and join() output differ in
      // separator style on Windows.
      const dir = resolve(repoDir(parseRepoRef(good)));
      assert.ok(
        dir.startsWith(resolve(dataDir())),
        `"${good}" resolved outside the data dir: ${dir}`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env["GROUNDHOG_DATA_DIR"];
    else process.env["GROUNDHOG_DATA_DIR"] = previous;
  }
});

test("ordinary repo refs still parse", () => {
  assert.deepEqual(parseRepoRef("vitejs/vite"), {
    host: "github.com",
    owner: "vitejs",
    name: "vite",
  });
  assert.deepEqual(parseRepoRef("https://github.com/sindresorhus/execa.git"), {
    host: "github.com",
    owner: "sindresorhus",
    name: "execa",
  });
  assert.deepEqual(parseRepoRef("git@github.com:a/b.git"), {
    host: "github.com",
    owner: "a",
    name: "b",
  });
});

test("the GitHub token is never sent to an unapproved host", () => {
  // The whole point: requests carry Authorization, so the destination is
  // allowlisted rather than merely sanitized.
  const evil = { host: "evil.example.com", owner: "owner", name: "repo" };
  assert.throws(() => new GitHubForge(evil, "ghp_secret"), /Refusing to contact/);

  assert.doesNotThrow(
    () => new GitHubForge({ host: "github.com", owner: "a", name: "b" }, "ghp_secret"),
  );
});

test("the refusal explains how to allow a real Enterprise host", () => {
  try {
    assertHostAllowed("ghe.mycorp.com", {});
    assert.fail("should have thrown");
  } catch (err) {
    assert.match((err as Error).message, /GROUNDHOG_ALLOWED_HOSTS=ghe\.mycorp\.com/);
  }
});

test("an explicitly allowed host is accepted, case-insensitively", () => {
  const env = { GROUNDHOG_ALLOWED_HOSTS: "ghe.mycorp.com, other.internal" };
  assert.ok(isHostAllowed("ghe.mycorp.com", env));
  assert.ok(isHostAllowed("GHE.MyCorp.com", env));
  assert.ok(isHostAllowed("other.internal", env));
  assert.ok(!isHostAllowed("evil.example.com", env));

  // github.com is always allowed, with or without the env var.
  assert.ok(isHostAllowed("github.com", {}));
  assert.ok(allowedHosts({}).includes("github.com"));
});

test("search filters go into SQL as bound parameters, never as text", () => {
  const injection = `x'; DROP TABLE thread; --`;
  const { clause, params } = buildFilters({ author: injection, labels: [injection] });

  assert.ok(!clause.includes("DROP"), "user text leaked into the SQL string");
  assert.ok(!clause.includes(injection));
  assert.ok(params.some((p) => String(p).includes("DROP")), "should be a bound parameter");
  assert.equal((clause.match(/\?/g) ?? []).length, params.length);
});

test("query text cannot break out of the FTS5 match expression", () => {
  for (const attack of [`" OR 1=1 --`, `a" NEAR(b`, `"""`, `*`, `^`]) {
    const parsed = parseQuery(attack);
    if (!parsed.match) continue;
    // Every emitted term is a quoted phrase; internal quotes are doubled.
    const stripped = parsed.match.replace(/""/g, "");
    const quotes = (stripped.match(/"/g) ?? []).length;
    assert.equal(quotes % 2, 0, `unbalanced quotes for ${attack}: ${parsed.match}`);
  }
});
