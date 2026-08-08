import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseRepoRef, repoSlug } from "../types.ts";
import type { RepoRef } from "../types.ts";
import { dbPath, listIndexedRepos } from "../store/paths.ts";

/**
 * Works out which repo a command means, in the order a user would expect:
 * what they typed, then the repo they're standing in, then the only one they
 * have indexed.
 */
export function resolveRepo(explicit?: string): RepoRef {
  if (explicit) return parseRepoRef(explicit);

  const fromCwd = repoFromGitRemote();
  if (fromCwd && existsSync(dbPath(fromCwd))) return fromCwd;

  const indexed = listIndexedRepos();
  if (indexed.length === 1) return indexed[0]!;

  if (fromCwd) {
    throw new Error(
      `${repoSlug(fromCwd)} is not indexed yet. Run: groundhog index ${repoSlug(fromCwd)}`,
    );
  }
  if (indexed.length === 0) {
    throw new Error("Nothing indexed yet. Run: groundhog index <owner/repo>");
  }
  throw new Error(
    `Several repos are indexed — pass --repo <owner/repo>. Indexed: ${indexed
      .map(repoSlug)
      .join(", ")}`,
  );
}

/** The GitHub repo of the working directory, if it is a git checkout of one. */
export function repoFromGitRemote(cwd: string = process.cwd()): RepoRef | null {
  for (const remote of ["origin", "upstream"]) {
    try {
      const url = execFileSync("git", ["remote", "get-url", remote], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
        windowsHide: true,
      }).trim();
      if (!url) continue;
      // git@host:owner/name.git -> host/owner/name
      return parseRepoRef(url.replace(/^[^@]+@([^:]+):/, "$1/"));
    } catch {
      // not a checkout, no such remote, or an unparseable URL — try the next.
    }
  }
  return null;
}
