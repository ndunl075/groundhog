/** Core domain types. Shared by every layer; depends on nothing. */

export type ThreadKind = "issue" | "pr" | "discussion";

export type MessageKind = "comment" | "review" | "review_comment";

/** open | closed | merged — normalized across forges. */
export type ThreadState = "open" | "closed" | "merged";

export interface RepoRef {
  /** Forge hostname, e.g. "github.com". */
  host: string;
  owner: string;
  name: string;
}

export interface Thread {
  /** Stable within a repo: `${kind}:${number}`. */
  id: string;
  number: number;
  kind: ThreadKind;
  title: string;
  body: string;
  state: ThreadState;
  author: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  merged: boolean;
  url: string;
  /** PR or commit that resolved this thread, when the forge reports one. */
  resolutionRef: string | null;
  commentCount: number;
}

export interface Message {
  id: string;
  threadId: string;
  kind: MessageKind;
  author: string | null;
  body: string;
  createdAt: string;
  url: string | null;
  /** Position within the thread. */
  ord: number;
}

export interface Chunk {
  /** Assigned by SQLite on insert; 0 before the row exists. */
  id: number;
  threadId: string;
  messageId: string | null;
  ord: number;
  text: string;
  tokenEst: number;
}

export function repoSlug(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function threadId(kind: ThreadKind, number: number): string {
  return `${kind}:${number}`;
}

/**
 * Owner and repo names become path segments under the data directory, so they
 * are validated rather than trusted. Without this, "../../.." walks out of the
 * data dir — and a repo ref can arrive from an MCP argument, which may
 * originate in content nobody vetted.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/;

function checkSegment(value: string, what: string, input: string): string {
  if (value === "." || value === ".." || !SEGMENT.test(value)) {
    throw new Error(`Invalid ${what} "${value}" in "${input}".`);
  }
  return value;
}

/** Parses "owner/repo", "github.com/owner/repo", or a full GitHub URL. */
export function parseRepoRef(input: string): RepoRef {
  const trimmed = input
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") // scheme
    .replace(/^[^@/]+@/, "") // git@ / user@
    // SCP form `host:owner/name` -> `host/owner/name`, while leaving a real
    // `host:8080/owner/name` port alone.
    .replace(/^([^/:]+):(?!\d+(?:\/|$))/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);

  const build = (host: string, owner: string, name: string): RepoRef => {
    if (host === ".." || !HOSTNAME.test(host) || host.includes("..")) {
      throw new Error(`Invalid host "${host}" in "${input}".`);
    }
    return {
      host,
      owner: checkSegment(owner, "owner", input),
      name: checkSegment(name, "repo name", input),
    };
  };

  if (parts.length === 2) return build("github.com", parts[0]!, parts[1]!);
  if (parts.length >= 3 && parts[0]!.includes(".")) {
    return build(parts[0]!, parts[1]!, parts[2]!);
  }
  throw new Error(
    `Cannot parse "${input}" as a repo. Expected owner/repo or a repo URL.`,
  );
}
