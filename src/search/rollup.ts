import type { Store } from "../store/db.ts";
import type { ChunkHit, ThreadHit } from "./types.ts";
import type { ParsedQuery } from "./query.ts";

/**
 * Weight of the 2nd, 3rd, … best chunk in a thread. A thread that matches in
 * several places is more likely to be the one you want than a thread that
 * matched once by luck, but the tail must not overpower a strong single hit.
 */
const TAIL_DAMPING = 0.4;

/** Tracker-native rank adjustments — see ARCHITECTURE.md §8. */
const BOOST = {
  resolved: 1.15,
  exactError: 1.3,
  prIntent: 1.1,
  /** Total decay applied to a thread two years stale. */
  maxRecencyPenalty: 0.15,
} as const;

const RECENCY_WINDOW_MS = 24 * 30 * 24 * 60 * 60 * 1000;

export interface RollupOptions {
  limit?: number;
  now?: number;
  /** Disable the tracker-native boosts; used by tests and `--raw`. */
  boost?: boolean;
}

/**
 * Collapses chunk hits into thread hits, then applies signals that only an
 * issue tracker has: whether the thread was actually resolved, whether it
 * quotes the exact error you pasted, and how stale it is.
 */
export function rollup(
  store: Store,
  hits: ChunkHit[],
  parsed: ParsedQuery,
  opts: RollupOptions = {},
): ThreadHit[] {
  if (hits.length === 0) return [];

  const byThread = new Map<string, ChunkHit[]>();
  for (const hit of hits) {
    const list = byThread.get(hit.threadId);
    if (list) list.push(hit);
    else byThread.set(hit.threadId, [hit]);
  }

  const threads = store.getThreads([...byThread.keys()]);
  const useBoost = opts.boost !== false;
  const now = opts.now ?? Date.now();
  const wantsPr = looksLikeChangeQuery(parsed);
  const needles = useBoost ? errorNeedles(parsed) : [];
  const texts = needles.length ? store.getChunks(hits.map((h) => h.chunkId)) : null;

  const out: ThreadHit[] = [];
  for (const [threadId, chunks] of byThread) {
    const thread = threads.get(threadId);
    if (!thread) continue; // thread deleted between retrieval and roll-up

    chunks.sort((a, b) => b.score - a.score);
    let score = chunks[0]!.score;
    for (let i = 1; i < chunks.length; i++) {
      score += chunks[i]!.score * TAIL_DAMPING ** i;
    }

    if (useBoost) {
      if (thread.state !== "open" && thread.resolutionRef) score *= BOOST.resolved;
      if (wantsPr && thread.kind === "pr") score *= BOOST.prIntent;

      if (texts) {
        const exact = chunks.some((c) => {
          const text = texts.get(c.chunkId)?.text;
          return text ? needles.some((n) => text.includes(n)) : false;
        });
        if (exact) score *= BOOST.exactError;
      }

      score *= recencyFactor(thread.updatedAt, now);
    }

    out.push({ thread, score, chunks });
  }

  out.sort((a, b) => b.score - a.score);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/**
 * Terms worth matching character-for-character: error class names, screaming
 * constants like ENOENT, and anything the user explicitly quoted. Ordinary
 * words are excluded — BM25 already scored those, and boosting them twice just
 * rewards verbosity.
 */
export function errorNeedles(parsed: ParsedQuery): string[] {
  const needles = parsed.phrases.filter((p) => p.length >= 4);
  for (const term of parsed.terms) {
    if (term.length < 4) continue;
    const isScreaming = /^[A-Z][A-Z0-9_]{3,}$/.test(term);
    const isErrorClass = /^[A-Za-z_$][\w$]*(Error|Exception)$/.test(term);
    const isDotted = /^[\w$]+(\.[\w$<>]+){1,}$/.test(term);
    if (isScreaming || isErrorClass || isDotted) needles.push(term);
  }
  return needles;
}

/** "why was this changed", "who refactored X" — questions PRs answer. */
export function looksLikeChangeQuery(parsed: ParsedQuery): boolean {
  const text = [...parsed.terms, ...parsed.phrases].join(" ").toLowerCase();
  return /\b(chang(e|ed|es)|refactor(ed)?|revert(ed)?|remov(e|ed)|renam(e|ed)|introduc(e|ed)|implement(ed)?)\b/.test(
    text,
  );
}

/** Linear decay to a floor, so old-but-relevant threads still surface. */
function recencyFactor(updatedAt: string, now: number): number {
  const age = now - new Date(updatedAt).getTime();
  if (!Number.isFinite(age) || age <= 0) return 1;
  const ratio = Math.min(1, age / RECENCY_WINDOW_MS);
  return 1 - BOOST.maxRecencyPenalty * ratio;
}
