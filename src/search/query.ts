/**
 * FTS5 query construction.
 *
 * Users type questions, not query syntax, so raw input is never passed through:
 * an unbalanced quote or a bare `#` is a syntax error, and issue trackers are
 * full of both. Every term is emitted as a quoted phrase, which is simultaneously
 * the escape mechanism and the way multi-token identifiers like
 * `Object.<anonymous>` keep matching as a unit.
 */

/** Function words that match everything and rank nothing. */
const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can",
  "did", "do", "does", "for", "from", "had", "has", "have", "how", "i", "if",
  "in", "is", "it", "its", "me", "my", "not", "of", "on", "or", "so", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "to", "was", "we", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "would", "you", "your", "am", "get", "got", "into", "just",
  "like", "some", "seems", "anyone", "hit", "before", "ever", "someone",
]);

export interface ParsedQuery {
  /** FTS5 MATCH expression, or null when nothing searchable remains. */
  match: string | null;
  /** Terms that survived filtering — used for highlighting and boosts. */
  terms: string[];
  /** Explicit "quoted phrases" the user asked for. */
  phrases: string[];
}

export function parseQuery(raw: string): ParsedQuery {
  const phrases: string[] = [];

  // Pull out explicit "quoted phrases" first so their spaces survive tokenizing.
  const withoutPhrases = raw.replace(/"([^"]+)"/g, (_, phrase: string) => {
    const cleaned = phrase.trim();
    if (cleaned) phrases.push(cleaned);
    return " ";
  });

  const terms: string[] = [];
  for (const rawTerm of withoutPhrases.split(/\s+/)) {
    // Keep internal punctuation (ENOENT, Object.<anonymous>, foo_bar, #1234),
    // drop the surrounding kind.
    const term = rawTerm.replace(/^[^\p{L}\p{N}#_]+|[^\p{L}\p{N}_>)\]]+$/gu, "");
    if (!term) continue;

    const bare = term.replace(/^#/, "");
    if (!bare) continue;
    // Stopwords go, unless the user typed an identifier that happens to look
    // like one (`This`, `Object`) — length and case are the tell.
    if (bare.length < 2) continue;
    if (STOPWORDS.has(bare.toLowerCase()) && bare === bare.toLowerCase()) continue;

    terms.push(bare);
  }

  const parts = [...phrases, ...terms].map(asPhrase);
  return {
    match: parts.length ? parts.join(" OR ") : null,
    terms,
    phrases,
  };
}

/**
 * Wraps a term as an FTS5 phrase. Doubling `"` is FTS5's own escape, so any
 * input becomes syntactically valid; the tokenizer then reduces the phrase to
 * the tokens it contains and requires them adjacent.
 */
function asPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Issue/PR references the user typed, e.g. "#1234" or "fixed in #12". */
export function referencedNumbers(raw: string): number[] {
  return [...raw.matchAll(/#(\d{1,7})\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0);
}
