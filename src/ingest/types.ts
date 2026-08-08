import type { Message, Thread, ThreadKind } from "../types.ts";

/** A thread plus its messages, as returned by a forge adapter. */
export interface IngestedThread {
  thread: Thread;
  messages: Message[];
  /** True when the forge paginated out comments we did not fetch. */
  truncated: boolean;
}

export interface FetchOptions {
  /** Stop once threads older than this ISO timestamp are reached. */
  since?: string | undefined;
  /** Hard cap on threads yielded, for `--limit`. */
  max?: number | undefined;
}

/**
 * The seam for supporting forges beyond GitHub. Adapters yield threads newest
 * first so callers can stop as soon as they cross the sync cursor.
 */
export interface Forge {
  readonly host: string;
  /** Kinds this forge/repo actually has, e.g. discussions may be disabled. */
  supportedKinds(): Promise<ThreadKind[]>;
  fetchThreads(kind: ThreadKind, opts: FetchOptions): AsyncGenerator<IngestedThread>;
}

export class ForgeError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ForgeError";
    this.status = status;
  }
}
