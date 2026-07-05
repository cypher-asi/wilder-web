// Shared number/time formatting helpers used across the desktop dashboards
// and the mobile shell (single home; don't re-copy these per screen).

/** Thousands-separated MILD/count formatting ("12,340"). */
export function fmtMild(n: number): string {
  return n.toLocaleString("en-US");
}

/** Compact large numbers for volume columns ("1.53M", "84.2K", "912"). */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

/** Compact relative age: seconds -> minutes -> hours -> days, then a short
 * date once older than a week (e.g. "Jul 3"). */
export function formatAge(atMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - atMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(atMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
