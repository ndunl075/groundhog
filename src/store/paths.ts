import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, existsSync, mkdirSync } from "node:fs";
import type { RepoRef } from "../types.ts";

/**
 * Per-platform data directory. `GROUNDHOG_DATA_DIR` overrides it, which is what
 * the tests and the portable .exe build use.
 */
export function dataDir(): string {
  const override = process.env["GROUNDHOG_DATA_DIR"];
  if (override) return override;

  if (process.platform === "win32") {
    const base =
      process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return join(base, "groundhog");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "groundhog");
  }
  const xdg = process.env["XDG_DATA_HOME"];
  return xdg ? join(xdg, "groundhog") : join(homedir(), ".local", "share", "groundhog");
}

export function repoDir(repo: RepoRef): string {
  return join(dataDir(), "repos", repo.host, repo.owner, repo.name);
}

export function dbPath(repo: RepoRef): string {
  return join(repoDir(repo), "index.db");
}

export function ensureRepoDir(repo: RepoRef): string {
  const dir = repoDir(repo);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Every repo with an index.db on disk, in host/owner/name order. */
export function listIndexedRepos(): RepoRef[] {
  const root = join(dataDir(), "repos");
  if (!existsSync(root)) return [];

  const repos: RepoRef[] = [];
  for (const host of dirsIn(root)) {
    for (const owner of dirsIn(join(root, host))) {
      for (const name of dirsIn(join(root, host, owner))) {
        if (existsSync(join(root, host, owner, name, "index.db"))) {
          repos.push({ host, owner, name });
        }
      }
    }
  }
  return repos;
}

function dirsIn(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
