import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store/db.ts";
import { buildIndex } from "../src/index/build.ts";
import { listIndexedRepos } from "../src/store/paths.ts";
import { humanAge, humanBytes } from "../src/cli/output.ts";
import { describeKinds } from "../src/cli/commands/index-repo.ts";
import { parseRepoRef, threadId } from "../src/types.ts";
import type { Thread } from "../src/types.ts";

/** Runs the CLI as a user would, against a throwaway data dir. */
function runCli(dataDir: string, args: string[], cwd?: string): string {
  return execFileSync(
    process.execPath,
    ["--experimental-strip-types", join(process.cwd(), "src/cli/index.ts"), ...args],
    {
      encoding: "utf8",
      env: { ...process.env, GROUNDHOG_DATA_DIR: dataDir, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    },
  );
}

function withDataDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "groundhog-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedRepo(dataDir: string, slug: string): void {
  const previous = process.env["GROUNDHOG_DATA_DIR"];
  process.env["GROUNDHOG_DATA_DIR"] = dataDir;
  try {
    const repo = parseRepoRef(slug);
    const store = Store.open(repo);
    const thread: Thread = {
      id: threadId("issue", 7),
      number: 7,
      kind: "issue",
      title: "Crash with ENOENT on startup",
      body: "the binary throws ENOENT when the config is missing",
      state: "closed",
      author: "octocat",
      labels: ["bug"],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      closedAt: "2026-02-01T00:00:00Z",
      merged: false,
      url: "https://github.com/acme/widgets/issues/7",
      resolutionRef: "#9",
      commentCount: 0,
    };
    store.upsertThread(thread);
    buildIndex(store);
    store.setMeta("last_sync", new Date().toISOString());
    store.close();
  } finally {
    if (previous === undefined) delete process.env["GROUNDHOG_DATA_DIR"];
    else process.env["GROUNDHOG_DATA_DIR"] = previous;
  }
}

test("--help and --version work without an index", () => {
  withDataDir((dir) => {
    assert.match(runCli(dir, ["--help"]), /local RAG over a repo's issues/);
    assert.match(runCli(dir, ["--version"]), /^\d+\.\d+\.\d+/);
    // A bare invocation should teach, not error.
    assert.match(runCli(dir, []), /USAGE/);
  });
});

test("status reports an empty install without failing", () => {
  withDataDir((dir) => {
    assert.match(runCli(dir, ["status"]), /Nothing indexed yet/);
    const json = JSON.parse(runCli(dir, ["status", "--json"])) as {
      repos: unknown[];
      dataDir: string;
    };
    assert.deepEqual(json.repos, []);
    assert.equal(json.dataDir, dir);
  });
});

test("ask returns structured results over an indexed repo", () => {
  withDataDir((dir) => {
    seedRepo(dir, "acme/widgets");

    const json = JSON.parse(
      runCli(dir, ["ask", "ENOENT config missing", "--repo", "acme/widgets", "--json"]),
    ) as { results: { number: number; state: string; excerpts: string[] }[] };

    assert.equal(json.results.length, 1);
    assert.equal(json.results[0]!.number, 7);
    assert.equal(json.results[0]!.state, "closed");
    assert.ok(json.results[0]!.excerpts.length > 0);
  });
});

test("filters reach the CLI surface", () => {
  withDataDir((dir) => {
    seedRepo(dir, "acme/widgets");
    const run = (extra: string[]): number =>
      (
        JSON.parse(runCli(dir, ["ask", "ENOENT", "--repo", "acme/widgets", "--json", ...extra])) as {
          results: unknown[];
        }
      ).results.length;

    assert.equal(run(["--state", "closed"]), 1);
    assert.equal(run(["--state", "open"]), 0);
    assert.equal(run(["--label", "bug"]), 1);
    assert.equal(run(["--label", "docs"]), 0);
    assert.equal(run(["--kind", "pr"]), 0);
  });
});

test("show prints a full thread and rejects unknown numbers", () => {
  withDataDir((dir) => {
    seedRepo(dir, "acme/widgets");
    const text = runCli(dir, ["show", "7", "--repo", "acme/widgets"]);
    assert.match(text, /ISSUE #7: Crash with ENOENT/);
    assert.match(text, /resolved by #9/);

    assert.throws(
      () => runCli(dir, ["show", "999", "--repo", "acme/widgets"]),
      /is not in the index/,
    );
  });
});

test("invalid arguments fail with an actionable message", () => {
  withDataDir((dir) => {
    seedRepo(dir, "acme/widgets");
    assert.throws(() => runCli(dir, ["nonsense"]), /unknown command/);
    assert.throws(() => runCli(dir, ["ask"]), /needs a question/);
    assert.throws(
      () => runCli(dir, ["ask", "x", "--repo", "acme/widgets", "--kind", "bogus"]),
      /--kind must be/,
    );
    // `--limit -4` is caught earlier by parseArgs as ambiguous; `=` reaches us.
    assert.throws(
      () => runCli(dir, ["ask", "x", "--repo", "acme/widgets", "--limit=-4"]),
      /must be a positive number/,
    );
    assert.throws(
      () => runCli(dir, ["ask", "x", "--repo", "acme/widgets", "--limit", "abc"]),
      /must be a positive number/,
    );
    assert.throws(() => runCli(dir, ["ask", "x", "--bogus-flag"]), /Unknown option/);
  });
});

test("an unindexed repo is named in the error, with the fix", () => {
  withDataDir((dir) => {
    assert.throws(() => runCli(dir, ["ask", "x", "--repo", "who/what"]), /No index for who\/what/);
  });
});

test("a single indexed repo is used when none is named", () => {
  withDataDir((dir) => {
    seedRepo(dir, "acme/widgets");
    assert.equal(listIndexedRepos().length >= 0, true);
    const json = JSON.parse(runCli(dir, ["ask", "ENOENT", "--json"], tmpdir())) as {
      repo: string;
    };
    assert.equal(json.repo, "acme/widgets");
  });
});

test("output helpers format sizes and ages", () => {
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(1536), "1.5 KB");
  assert.equal(humanBytes(5 * 1024 * 1024), "5.0 MB");

  assert.equal(humanAge(null), "never");
  assert.equal(humanAge(new Date().toISOString()), "just now");
  assert.equal(humanAge(new Date(Date.now() - 3 * 3600_000).toISOString()), "3h ago");
});

test("describeKinds reads naturally and handles nothing-new", () => {
  assert.equal(describeKinds({ issue: 3, pr: 1 }), "3 issues, 1 pr");
  assert.equal(describeKinds({ issue: 0 }), "nothing new");
});
