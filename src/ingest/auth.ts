import { execFileSync } from "node:child_process";

let cached: string | null | undefined;

/**
 * Token resolution, in order: GITHUB_TOKEN, GH_TOKEN, then the `gh` CLI.
 * Returns null when nothing is available — unauthenticated requests still work
 * at GitHub's 60 req/h, which is enough to try Groundhog on a small repo.
 */
export function resolveToken(): string | null {
  if (cached !== undefined) return cached;

  const fromEnv = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (fromEnv) return (cached = fromEnv.trim());

  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (out) return (cached = out);
  } catch {
    // gh missing, logged out, or too slow — fall through to unauthenticated.
  }

  return (cached = null);
}

/** Test seam. */
export function resetTokenCache(): void {
  cached = undefined;
}
