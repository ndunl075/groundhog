import type { Store } from "../store/db.ts";
import { estimateTokens } from "../index/chunk.ts";
import type { Thread } from "../types.ts";
import type { ThreadHit } from "../search/types.ts";

export interface EvidenceItem {
  thread: Thread;
  score: number;
  excerpts: string[];
}

export interface PackedEvidence {
  items: EvidenceItem[];
  tokensUsed: number;
  /** True when the budget cut off threads or excerpts that would have fit otherwise. */
  truncated: boolean;
}

export interface PackOptions {
  /** Total token budget for the packed evidence. */
  budget?: number;
  /** Cap on a single excerpt. */
  excerptTokens?: number;
  /** Extra excerpts a single thread may contribute in the depth pass. */
  maxExcerptsPerThread?: number;
}

const DEFAULTS = {
  budget: 4000,
  excerptTokens: 120,
  maxExcerptsPerThread: 4,
} as const;

/**
 * Turns ranked threads into evidence.
 *
 * Groundhog runs no LLM — whoever called it is the model. So the output is
 * quotes and citations, never a summary.
 *
 * The budget fills breadth-first: every thread gets its best excerpt before any
 * thread gets a second. Five relevant issues beat one issue quoted at length,
 * because the question is almost always "has anyone hit this", not "tell me
 * everything about this one".
 */
export function packEvidence(
  store: Store,
  hits: ThreadHit[],
  opts: PackOptions = {},
): PackedEvidence {
  const budget = opts.budget ?? DEFAULTS.budget;
  const excerptTokens = opts.excerptTokens ?? DEFAULTS.excerptTokens;
  const maxPerThread = opts.maxExcerptsPerThread ?? DEFAULTS.maxExcerptsPerThread;

  const items: EvidenceItem[] = [];
  let used = 0;
  let truncated = false;

  // Breadth pass: header + best excerpt per thread.
  for (const hit of hits) {
    const header = estimateTokens(headerLine(hit.thread));
    const excerpt = excerptFor(store, hit, 0, excerptTokens);
    const cost = header + (excerpt ? estimateTokens(excerpt) : 0);

    if (used + cost > budget) {
      truncated = true;
      break;
    }
    used += cost;
    items.push({
      thread: hit.thread,
      score: hit.score,
      excerpts: excerpt ? [excerpt] : [],
    });
  }

  // Depth pass: spend what's left on the highest-ranked threads first.
  for (let depth = 1; depth < maxPerThread; depth++) {
    let addedAny = false;
    for (let i = 0; i < items.length; i++) {
      const hit = hits[i]!;
      if (depth >= hit.chunks.length) continue;

      const excerpt = excerptFor(store, hit, depth, excerptTokens);
      if (!excerpt) continue;
      if (items[i]!.excerpts.includes(excerpt)) continue;

      const cost = estimateTokens(excerpt);
      if (used + cost > budget) {
        truncated = true;
        return { items, tokensUsed: used, truncated };
      }
      used += cost;
      items[i]!.excerpts.push(excerpt);
      addedAny = true;
    }
    if (!addedAny) break;
  }

  return { items, tokensUsed: used, truncated };
}

function excerptFor(
  store: Store,
  hit: ThreadHit,
  index: number,
  maxTokens: number,
): string | null {
  const chunk = hit.chunks[index];
  if (!chunk) return null;

  // FTS snippets are already query-centred; fall back to the chunk head.
  const raw = chunk.excerpt?.trim() || store.getChunks([chunk.chunkId]).get(chunk.chunkId)?.text;
  if (!raw) return null;

  const collapsed = raw.replace(/\s+/g, " ").trim();
  const limit = maxTokens * 4;
  return collapsed.length > limit ? `${collapsed.slice(0, limit).trimEnd()}…` : collapsed;
}

export function headerLine(thread: Thread): string {
  const parts = [`#${thread.number}`, thread.kind, thread.state];
  if (thread.resolutionRef && thread.resolutionRef !== "merged") {
    parts.push(`resolved by ${thread.resolutionRef}`);
  }
  parts.push(`${thread.commentCount} comments`);
  parts.push(thread.updatedAt.slice(0, 10));
  return parts.join(" · ");
}

/** Plain-text rendering, for MCP tool results and piped CLI output. */
export function renderEvidence(packed: PackedEvidence): string {
  if (packed.items.length === 0) return "No matching threads.";

  const blocks = packed.items.map((item) => {
    const lines = [
      `${headerLine(item.thread)}`,
      item.thread.title,
      item.thread.url,
      ...item.excerpts.map((e) => `  "${e}"`),
    ];
    return lines.join("\n");
  });

  const out = blocks.join("\n\n");
  return packed.truncated ? `${out}\n\n[more matches omitted — raise the limit or narrow the query]` : out;
}

/** Full reconstructed thread, for `groundhog show` and `get_thread`. */
export function renderThread(store: Store, thread: Thread): string {
  const messages = store.getMessages(thread.id);
  const head = [
    `${thread.kind.toUpperCase()} #${thread.number}: ${thread.title}`,
    `${thread.state}${thread.resolutionRef ? ` · resolved by ${thread.resolutionRef}` : ""} · opened by ${thread.author ?? "unknown"} on ${thread.createdAt.slice(0, 10)}`,
    thread.labels.length ? `labels: ${thread.labels.join(", ")}` : null,
    thread.url,
    "",
    thread.body.trim() || "(no description)",
  ].filter((l) => l !== null);

  const body = messages.map(
    (m) =>
      `\n--- ${m.kind} by ${m.author ?? "unknown"} on ${m.createdAt.slice(0, 10)} ---\n${m.body.trim()}`,
  );

  return [...head, ...body].join("\n");
}
