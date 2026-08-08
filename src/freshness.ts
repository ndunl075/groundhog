/**
 * How old an index is, and whether that should be said out loud.
 *
 * A tracker search is only as good as its last sync: the issue you are hitting
 * today is exactly the one most likely to have been filed this week. Staleness
 * is therefore surfaced everywhere results are, rather than left for the user
 * to wonder about.
 */

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface Freshness {
  lastSync: string | null;
  ageMs: number | null;
  stale: boolean;
  /** Human phrasing, e.g. "3 days ago" or "never". */
  label: string;
}

export function freshnessOf(lastSync: string | null, now: number = Date.now()): Freshness {
  if (!lastSync) {
    return { lastSync: null, ageMs: null, stale: true, label: "never" };
  }

  const at = new Date(lastSync).getTime();
  if (!Number.isFinite(at)) {
    return { lastSync, ageMs: null, stale: true, label: "unknown" };
  }

  const ageMs = Math.max(0, now - at);
  return {
    lastSync,
    ageMs,
    stale: ageMs > STALE_AFTER_MS,
    label: describeAge(ageMs),
  };
}

export function describeAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** One line telling the user what to do about it, or null when it's fresh. */
export function staleNotice(freshness: Freshness, repoSlug?: string): string | null {
  if (!freshness.stale) return null;
  const target = repoSlug ? ` ${repoSlug}` : "";

  return freshness.lastSync === null
    ? `This index has never been synced. Run: groundhog sync${target}`
    : `Index last synced ${freshness.label} — newer threads are missing. Run: groundhog sync${target}`;
}
