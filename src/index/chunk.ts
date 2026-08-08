import type { Chunk, Message, Thread } from "../types.ts";

export interface ChunkOptions {
  /** Budget for the title+body head chunk. */
  headTokens?: number;
  /** Budget for packed comment chunks. */
  bodyTokens?: number;
  /** Keep bot comments (off by default — they are pure index noise). */
  keepBots?: boolean;
}

const DEFAULTS = { headTokens: 1200, bodyTokens: 800 } as const;

/** ~4 chars per token. Good enough for budgeting; nothing depends on exactness. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const BOT_LOGINS = new Set([
  "dependabot",
  "renovate",
  "codecov",
  "github-actions",
  "netlify",
  "vercel",
  "sonarcloud",
  "coveralls",
  "stale",
  "allcontributors",
  "changeset-bot",
  "socket-security",
  "pkg-pr-new",
  "codesandbox",
  "size-limit",
]);

export function isBot(author: string | null): boolean {
  if (!author) return false;
  const login = author.replace(/\[bot\]$/i, "").toLowerCase();
  return author.toLowerCase().endsWith("[bot]") || BOT_LOGINS.has(login);
}

/** Automated bodies that a human never needs to retrieve. */
const NOISE = [
  /^#+\s*(codecov|coverage) report/im,
  /automatically marked as stale/i,
  /^\s*\|\s*\[?codecov/im,
  /this pull request has been (automatically )?(closed|locked)/i,
  /^deploy preview for .* (ready|failed)/im,
];

function isNoise(body: string): boolean {
  return NOISE.some((re) => re.test(body));
}

/**
 * Turns a thread into retrievable chunks.
 *
 * Threads are not prose, so they are not split like prose: the opening post is
 * always its own chunk (most duplicate-bug matches are body-to-body), comments
 * pack together without being cut mid-comment, and fenced code stays whole
 * because a stack trace sliced in half matches nothing.
 */
export function chunkThread(
  thread: Thread,
  messages: Message[],
  opts: ChunkOptions = {},
): Omit<Chunk, "id">[] {
  const headTokens = opts.headTokens ?? DEFAULTS.headTokens;
  const bodyTokens = opts.bodyTokens ?? DEFAULTS.bodyTokens;

  const out: Omit<Chunk, "id">[] = [];
  const add = (text: string, messageId: string | null): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    out.push({
      threadId: thread.id,
      messageId,
      ord: out.length,
      text: trimmed,
      tokenEst: estimateTokens(trimmed),
    });
  };

  // 1. Head: title + opening post. Overflow continues as follow-on chunks
  //    rather than being discarded.
  const head = `#${thread.number} ${thread.title}\n\n${clean(thread.body)}`.trim();
  for (const part of splitText(head, headTokens)) add(part, null);

  // 2. Comments, packed greedily and never split across a comment boundary.
  let buffer: string[] = [];
  let bufferTokens = 0;
  let bufferOwner: string | null = null;

  const flush = (): void => {
    if (buffer.length) add(buffer.join("\n\n"), bufferOwner);
    buffer = [];
    bufferTokens = 0;
    bufferOwner = null;
  };

  for (const message of messages) {
    if (!opts.keepBots && isBot(message.author)) continue;
    const body = clean(message.body);
    if (!body || isNoise(body)) continue;

    const label = message.kind === "review" ? "review" : "comment";
    const text = `[${label} by ${message.author ?? "unknown"}]\n${body}`;
    const tokens = estimateTokens(text);

    if (tokens > bodyTokens) {
      // Oversized on its own: emit it as its own run of chunks.
      flush();
      for (const part of splitText(text, bodyTokens)) add(part, message.id);
      continue;
    }
    if (bufferTokens + tokens > bodyTokens) flush();

    if (buffer.length === 0) bufferOwner = message.id;
    buffer.push(text);
    bufferTokens += tokens;
  }
  flush();

  return out;
}

/** Strips markup that costs index space and returns no retrieval value. */
export function clean(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n");

  text = text.replace(/<!--[\s\S]*?-->/g, ""); // template comments
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // images → alt text
  text = text.replace(/data:[a-z/+-]+;base64,[A-Za-z0-9+/=]+/g, "[data]");

  // A reply that is mostly quoted text duplicates a chunk we already have.
  const lines = text.split("\n");
  const quoted = lines.filter((l) => /^\s*>/.test(l)).length;
  if (quoted > 3 && quoted / Math.max(lines.length, 1) > 0.5) {
    text = lines.filter((l) => !/^\s*>/.test(l)).join("\n");
  }

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Splits text to a token budget along the strongest available boundary:
 * fenced-code edges first, then blank lines, then single lines. Fences are only
 * broken when one alone exceeds the budget.
 */
export function splitText(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  const parts: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length) parts.push(current.join("\n\n"));
    current = [];
    currentTokens = 0;
  };

  for (const block of blocks(text)) {
    const tokens = estimateTokens(block);

    if (tokens > maxTokens) {
      flush();
      for (const piece of splitByLines(block, maxTokens)) parts.push(piece);
      continue;
    }
    if (currentTokens + tokens > maxTokens) flush();
    current.push(block);
    currentTokens += tokens;
  }
  flush();
  return parts.filter((p) => p.trim());
}

/** Fenced code blocks emerge whole; everything else splits on blank lines. */
function blocks(text: string): string[] {
  const out: string[] = [];
  const fence = /```[\s\S]*?(?:```|$)/g;
  let last = 0;

  for (const match of text.matchAll(fence)) {
    const start = match.index;
    out.push(...paragraphs(text.slice(last, start)));
    out.push(match[0]);
    last = start + match[0].length;
  }
  out.push(...paragraphs(text.slice(last)));
  return out.filter((b) => b.trim());
}

function paragraphs(text: string): string[] {
  return text.split(/\n{2,}/).filter((p) => p.trim());
}

function splitByLines(block: string, maxTokens: number): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const line of block.split("\n")) {
    const tokens = estimateTokens(line);
    if (currentTokens + tokens > maxTokens && current.length) {
      out.push(current.join("\n"));
      current = [];
      currentTokens = 0;
    }
    // A single line over budget is a minified blob; hard-cut it.
    if (tokens > maxTokens) {
      const size = maxTokens * 4;
      for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size));
      continue;
    }
    current.push(line);
    currentTokens += tokens;
  }
  if (current.length) out.push(current.join("\n"));
  return out;
}
