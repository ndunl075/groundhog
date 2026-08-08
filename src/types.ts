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

/** Parses "owner/repo", "github.com/owner/repo", or a full GitHub URL. */
export function parseRepoRef(input: string): RepoRef {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);

  if (parts.length === 2) {
    return { host: "github.com", owner: parts[0]!, name: parts[1]! };
  }
  if (parts.length >= 3 && parts[0]!.includes(".")) {
    return { host: parts[0]!, owner: parts[1]!, name: parts[2]! };
  }
  throw new Error(
    `Cannot parse "${input}" as a repo. Expected owner/repo or a repo URL.`,
  );
}
