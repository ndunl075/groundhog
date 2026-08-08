import type { Message, RepoRef, Thread, ThreadKind } from "../types.ts";
import { threadId } from "../types.ts";
import { ForgeError } from "./types.ts";
import type { FetchOptions, Forge, IngestedThread } from "./types.ts";
import { resolveToken } from "./auth.ts";
import { assertHostAllowed } from "./hosts.ts";

/** Page sizes chosen to stay well under GitHub's GraphQL node-cost limits. */
const THREADS_PER_PAGE = 25;
const COMMENTS_PER_THREAD = 40;
const REVIEWS_PER_PR = 20;

const ISSUE_FIELDS = `
  number title body url createdAt updatedAt closedAt
  state
  author { login }
  labels(first: 20) { nodes { name } }
  comments(first: ${COMMENTS_PER_THREAD}) {
    totalCount
    pageInfo { hasNextPage }
    nodes { id author { login } body createdAt url }
  }
  timelineItems(last: 5, itemTypes: [CLOSED_EVENT]) {
    nodes {
      ... on ClosedEvent {
        closer {
          ... on PullRequest { number }
          ... on Commit { oid }
        }
      }
    }
  }
`;

const PR_FIELDS = `
  number title body url createdAt updatedAt closedAt
  state merged mergedAt
  author { login }
  labels(first: 20) { nodes { name } }
  comments(first: ${COMMENTS_PER_THREAD}) {
    totalCount
    pageInfo { hasNextPage }
    nodes { id author { login } body createdAt url }
  }
  reviews(first: ${REVIEWS_PER_PR}) {
    nodes { id author { login } body state createdAt url }
  }
`;

const DISCUSSION_FIELDS = `
  number title body url createdAt updatedAt
  author { login }
  labels(first: 20) { nodes { name } }
  answer { url }
  comments(first: ${COMMENTS_PER_THREAD}) {
    totalCount
    pageInfo { hasNextPage }
    nodes {
      id author { login } body createdAt url
      replies(first: 10) { nodes { id author { login } body createdAt url } }
    }
  }
`;

const CONNECTION: Record<ThreadKind, { field: string; fields: string }> = {
  issue: { field: "issues", fields: ISSUE_FIELDS },
  pr: { field: "pullRequests", fields: PR_FIELDS },
  discussion: { field: "discussions", fields: DISCUSSION_FIELDS },
};

export class GitHubForge implements Forge {
  readonly host: string;
  private readonly repo: RepoRef;
  private readonly token: string | null;
  private kinds: ThreadKind[] | null = null;

  constructor(repo: RepoRef, token: string | null = resolveToken()) {
    // Checked at construction, before any code path can reach a request: every
    // request carries the token.
    assertHostAllowed(repo.host);
    this.repo = repo;
    this.host = repo.host;
    this.token = token;
  }

  private get graphqlUrl(): string {
    return this.host === "github.com"
      ? "https://api.github.com/graphql"
      : `https://${this.host}/api/graphql`;
  }

  private get restBase(): string {
    return this.host === "github.com"
      ? "https://api.github.com"
      : `https://${this.host}/api/v3`;
  }

  async supportedKinds(): Promise<ThreadKind[]> {
    if (this.kinds) return this.kinds;

    const data = await this.graphql<{
      repository: { hasDiscussionsEnabled: boolean; hasIssuesEnabled: boolean } | null;
    }>(
      `query($owner: String!, $name: String!) {
         repository(owner: $owner, name: $name) {
           hasIssuesEnabled
           hasDiscussionsEnabled
         }
       }`,
      { owner: this.repo.owner, name: this.repo.name },
    );

    if (!data.repository) {
      throw new ForgeError(
        `Repository ${this.repo.owner}/${this.repo.name} not found, or the token cannot see it.`,
        404,
      );
    }

    const kinds: ThreadKind[] = [];
    if (data.repository.hasIssuesEnabled) kinds.push("issue");
    kinds.push("pr"); // always available
    if (data.repository.hasDiscussionsEnabled) kinds.push("discussion");
    return (this.kinds = kinds);
  }

  async *fetchThreads(
    kind: ThreadKind,
    opts: FetchOptions = {},
  ): AsyncGenerator<IngestedThread> {
    const conn = CONNECTION[kind];
    const query = `
      query($owner: String!, $name: String!, $cursor: String) {
        rateLimit { remaining resetAt }
        repository(owner: $owner, name: $name) {
          ${conn.field}(first: ${THREADS_PER_PAGE},
                        orderBy: { field: UPDATED_AT, direction: DESC },
                        after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { ${conn.fields} }
          }
        }
      }`;

    let cursor: string | null = null;
    let yielded = 0;

    for (;;) {
      // Both annotations are load-bearing: without them TS chases `cursor`
      // through the response type and gives up (TS7022).
      const data: GraphQLPage = await this.graphql<GraphQLPage>(query, {
        owner: this.repo.owner,
        name: this.repo.name,
        cursor,
      });

      const connection: GraphQLConnection | undefined = data.repository?.[conn.field];
      if (!connection) return;

      for (const node of connection.nodes) {
        if (!node) continue;
        // Newest-first ordering means the first old node ends the walk.
        if (opts.since && node.updatedAt <= opts.since) return;

        const thread = this.toThread(kind, node);
        const messages = this.toMessages(kind, thread.id, node);
        const truncated = node.comments?.pageInfo?.hasNextPage ?? false;

        const complete = truncated
          ? mergeMessages(messages, await this.backfillComments(kind, thread.id, node.number))
          : messages;

        yield { thread, messages: complete, truncated };
        if (opts.max && ++yielded >= opts.max) return;
      }

      if (!connection.pageInfo.hasNextPage) return;
      cursor = connection.pageInfo.endCursor;
    }
  }

  // ---- mapping -------------------------------------------------------------

  private toThread(kind: ThreadKind, node: GraphQLNode): Thread {
    const merged = node.merged === true;
    const state = merged
      ? "merged"
      : node.state === "CLOSED" || node.closedAt
        ? "closed"
        : "open";

    return {
      id: threadId(kind, node.number),
      number: node.number,
      kind,
      title: node.title ?? "",
      body: node.body ?? "",
      state,
      author: node.author?.login ?? null,
      labels: (node.labels?.nodes ?? []).map((l) => l?.name).filter(isString),
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      closedAt: node.closedAt ?? node.mergedAt ?? null,
      merged,
      url: node.url,
      resolutionRef: resolutionRef(node),
      commentCount: node.comments?.totalCount ?? 0,
    };
  }

  private toMessages(kind: ThreadKind, tid: string, node: GraphQLNode): Message[] {
    const out: Message[] = [];
    const push = (
      raw: GraphQLComment | null | undefined,
      msgKind: Message["kind"],
    ): void => {
      if (!raw?.body?.trim()) return;
      out.push({
        id: raw.id,
        threadId: tid,
        kind: msgKind,
        author: raw.author?.login ?? null,
        body: raw.body,
        createdAt: raw.createdAt,
        url: raw.url ?? null,
        ord: out.length,
      });
    };

    for (const c of node.comments?.nodes ?? []) {
      push(c, "comment");
      // Discussion replies are nested one level under their parent comment.
      for (const r of c?.replies?.nodes ?? []) push(r, "comment");
    }

    if (kind === "pr") {
      // Review bodies only — inline nitpicks cost far more nodes than they add.
      for (const r of node.reviews?.nodes ?? []) push(r, "review");
    }

    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    out.forEach((m, i) => (m.ord = i));
    return out;
  }

  /**
   * REST is simpler than nested GraphQL pagination for the rare long thread.
   *
   * Paging starts at 1 rather than trying to skip what GraphQL already
   * returned: the two APIs number comments differently, and for a PR the
   * inline batch also contains reviews, so any offset arithmetic silently
   * loses comments. mergeMessages drops the resulting overlap instead.
   */
  private async backfillComments(
    kind: ThreadKind,
    tid: string,
    number: number,
  ): Promise<Message[]> {
    if (kind === "discussion") return []; // no REST equivalent; GraphQL page is enough
    const path = `/repos/${this.repo.owner}/${this.repo.name}/issues/${number}/comments`;
    const out: Message[] = [];

    for (let page = 1; page <= 20; page++) {
      const batch = await this.rest<RestComment[]>(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const c of batch) {
        if (!c.body?.trim()) continue;
        out.push({
          id: c.node_id ?? String(c.id),
          threadId: tid,
          kind: "comment",
          author: c.user?.login ?? null,
          body: c.body,
          createdAt: c.created_at,
          url: c.html_url ?? null,
          ord: 0,
        });
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  // ---- transport -----------------------------------------------------------

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "groundhog",
    };
    if (this.token) h["authorization"] = `Bearer ${this.token}`;
    return h;
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.request(this.graphqlUrl, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    const payload = (await res.json()) as {
      data?: T & { rateLimit?: { remaining: number; resetAt: string } };
      errors?: { message: string; type?: string }[];
    };

    if (payload.errors?.length) {
      // A disabled feature reads as NOT_FOUND on the connection, not an outage.
      const fatal = payload.errors.filter((e) => e.type !== "NOT_FOUND");
      if (fatal.length) {
        throw new ForgeError(fatal.map((e) => e.message).join("; "));
      }
    }
    if (!payload.data) throw new ForgeError("GitHub returned no data.");

    const rl = payload.data.rateLimit;
    if (rl && rl.remaining < 50) await sleepUntil(rl.resetAt);

    return payload.data;
  }

  private async rest<T>(path: string): Promise<T> {
    const res = await this.request(`${this.restBase}${path}`, {
      headers: this.headers(),
    });
    return (await res.json()) as T;
  }

  /** Single retry point: auth errors, rate limits, and transient 5xx. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, init);

      if (res.status === 401) {
        throw new ForgeError(
          "GitHub rejected the token (401). Set GITHUB_TOKEN or run `gh auth login`.",
          401,
        );
      }
      if (res.status === 404) {
        throw new ForgeError(
          `Not found: ${this.repo.owner}/${this.repo.name}. Private repos need a token with \`repo\` scope.`,
          404,
        );
      }

      const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1");
      if ((res.status === 403 || res.status === 429) && remaining === 0) {
        const reset = res.headers.get("x-ratelimit-reset");
        await sleepUntil(reset ? new Date(Number(reset) * 1000).toISOString() : null);
        continue;
      }

      if (res.status >= 500 && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        throw new ForgeError(`GitHub ${res.status}: ${await res.text()}`, res.status);
      }
      return res;
    }
  }
}

// ---- helpers ---------------------------------------------------------------

/**
 * Combines the inline GraphQL messages with the REST backfill.
 *
 * The two overlap by design — GraphQL and REST return the same comments under
 * the same node ids, and `message.id` is a primary key, so appending blindly
 * makes the whole thread fail to store. First writer wins, since the GraphQL
 * batch is the one carrying reviews.
 */
export function mergeMessages(primary: Message[], extra: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of [...primary, ...extra]) {
    if (!byId.has(message.id)) byId.set(message.id, message);
  }

  const merged = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  merged.forEach((message, i) => (message.ord = i));
  return merged;
}

function resolutionRef(node: GraphQLNode): string | null {
  if (node.answer?.url) return node.answer.url;
  if (node.merged) return `merged`;
  for (const item of node.timelineItems?.nodes ?? []) {
    const closer = item?.closer;
    if (closer?.number) return `#${closer.number}`;
    if (closer?.oid) return closer.oid.slice(0, 8);
  }
  return null;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function sleepUntil(iso: string | null): Promise<void> {
  if (!iso) return sleep(60_000);
  const ms = new Date(iso).getTime() - Date.now() + 1000;
  if (ms > 0) {
    process.stderr.write(
      `groundhog: GitHub rate limit reached, waiting ${Math.ceil(ms / 1000)}s\n`,
    );
    await sleep(Math.min(ms, 15 * 60_000));
  }
}

// ---- GraphQL response shapes ----------------------------------------------

interface GraphQLComment {
  id: string;
  author?: { login: string } | null;
  body?: string;
  createdAt: string;
  url?: string | null;
  replies?: { nodes: (GraphQLComment | null)[] } | null;
}

interface GraphQLNode {
  number: number;
  title?: string;
  body?: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  mergedAt?: string | null;
  state?: string;
  merged?: boolean;
  author?: { login: string } | null;
  labels?: { nodes: ({ name: string } | null)[] } | null;
  answer?: { url: string } | null;
  comments?: {
    totalCount: number;
    pageInfo?: { hasNextPage: boolean };
    nodes: (GraphQLComment | null)[];
  } | null;
  reviews?: { nodes: (GraphQLComment | null)[] } | null;
  timelineItems?: {
    nodes: ({ closer?: { number?: number; oid?: string } | null } | null)[];
  } | null;
}

interface GraphQLConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string };
  nodes: (GraphQLNode | null)[];
}

interface GraphQLPage {
  repository?: Record<string, GraphQLConnection> | null;
}

interface RestComment {
  id: number;
  node_id?: string;
  user?: { login: string } | null;
  body?: string;
  created_at: string;
  html_url?: string;
}
