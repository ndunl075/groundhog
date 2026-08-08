import test from "node:test";
import assert from "node:assert/strict";
import { freshnessOf, describeAge, staleNotice, STALE_AFTER_MS } from "../src/freshness.ts";
import { normalizeTime, syncCommand } from "../src/schedule/index.ts";

const NOW = Date.parse("2026-08-08T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

test("a never-synced index counts as stale", () => {
  const f = freshnessOf(null, NOW);
  assert.equal(f.stale, true);
  assert.equal(f.label, "never");
  assert.equal(f.ageMs, null);
  assert.match(staleNotice(f, "acme/widgets")!, /never been synced/);
});

test("freshness flips at the staleness threshold, not before", () => {
  const fresh = freshnessOf(ago(STALE_AFTER_MS - 60_000), NOW);
  assert.equal(fresh.stale, false);
  assert.equal(staleNotice(fresh), null);

  const stale = freshnessOf(ago(STALE_AFTER_MS + 60_000), NOW);
  assert.equal(stale.stale, true);
  assert.match(staleNotice(stale, "acme/widgets")!, /groundhog sync acme\/widgets/);
});

test("ages read the way a person would say them", () => {
  assert.equal(describeAge(30_000), "just now");
  assert.equal(describeAge(5 * 60_000), "5m ago");
  assert.equal(describeAge(3 * 3600_000), "3h ago");
  assert.equal(describeAge(24 * 3600_000), "1 day ago");
  assert.equal(describeAge(9 * 24 * 3600_000), "9 days ago");
});

test("a clock skewed into the future does not report a negative age", () => {
  const f = freshnessOf(new Date(NOW + 60_000).toISOString(), NOW);
  assert.equal(f.ageMs, 0);
  assert.equal(f.stale, false);
});

test("an unparseable timestamp is treated as stale, not as fresh", () => {
  const f = freshnessOf("not a date", NOW);
  assert.equal(f.stale, true);
  assert.equal(f.label, "unknown");
});

test("normalizeTime accepts sane times and rejects the rest", () => {
  assert.equal(normalizeTime("9:05"), "09:05");
  assert.equal(normalizeTime("23:59"), "23:59");
  assert.equal(normalizeTime(" 07:00 "), "07:00");

  assert.throws(() => normalizeTime("24:00"), /not a valid time/);
  assert.throws(() => normalizeTime("09:60"), /not a valid time/);
  assert.throws(() => normalizeTime("9am"), /24-hour time/);
  assert.throws(() => normalizeTime(""), /24-hour time/);
});

test("the scheduled command re-invokes this same Groundhog", () => {
  const { exe, args } = syncCommand();
  // Resolved from the running process, not from PATH: the scheduler runs in a
  // different environment where an npm/nvm shim may not resolve.
  assert.equal(exe, process.execPath);
  assert.deepEqual(args.slice(-2), ["sync", "--all"]);
});
