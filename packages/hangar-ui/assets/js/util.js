/**
 * Pure helpers shared by every Hangar view. This module is deliberately
 * DOM-free and side-effect-free so the same file runs in the browser (as a
 * plain ES module) and under `bun test` (imported directly by the package's
 * unit tests). Anything time-dependent takes an explicit `nowMs`.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Window for the "Recently active" smart group. */
export const RECENT_ACTIVITY_MS = 48 * HOUR_MS;

/** Default transcript retention used for the TTL countdown column. */
export const DEFAULT_SESSION_TTL_DAYS = 30;

/** Parse an ISO timestamp to epoch ms, or null when absent/invalid. */
export function parseTs(iso) {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** "just now" / "5m ago" / "3h ago" / "6d ago" / "in 2h"; "—" when unknown. */
export function fmtRelativeTime(iso, nowMs) {
  const ts = typeof iso === "number" ? iso : parseTs(iso);
  if (ts === null) return "—";
  const diff = nowMs - ts;
  const abs = Math.abs(diff);
  let label;
  if (abs < 45_000) return "just now";
  if (abs < HOUR_MS) label = `${Math.round(abs / MINUTE_MS)}m`;
  else if (abs < DAY_MS) label = `${Math.round(abs / HOUR_MS)}h`;
  else label = `${Math.round(abs / DAY_MS)}d`;
  return diff >= 0 ? `${label} ago` : `in ${label}`;
}

/** Format a dollar figure; "—" for null/undefined/NaN. */
export function fmtUsd(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  if (Math.abs(value) >= 1000) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toFixed(2)}`;
}

/** Format a 0..1 rate as a percentage; "—" when unknown. */
export function fmtPct(rate) {
  if (typeof rate !== "number" || Number.isNaN(rate)) return "—";
  // one decimal max, and 0.55*100's float dust must still read "55%"
  const pct = Math.round(rate * 1000) / 10;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** Format an integer count; "—" when unknown. */
export function fmtCount(n) {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "—";
}

/** Last `segments` path components of a directory, for row subtitles. */
export function dirTail(dir, segments = 2) {
  if (typeof dir !== "string" || dir === "") return "";
  const parts = dir.split(/[\\/]+/).filter((p) => p !== "");
  return parts.slice(-segments).join("/");
}

/** Truncate a string to `max` chars with an ellipsis. */
export function clampText(s, max = 80) {
  const str = String(s ?? "");
  return str.length <= max ? str : `${str.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * TTL countdown for a session transcript: `updatedAt` + `ttlDays` versus
 * now. Returns `{ expired, msLeft, label }` — label reads "expires in 12d",
 * "expires in 4h", or "expired".
 */
export function ttlCountdown(updatedAtIso, nowMs, ttlDays = DEFAULT_SESSION_TTL_DAYS) {
  const ts = parseTs(updatedAtIso);
  if (ts === null) return { expired: false, msLeft: null, label: "—" };
  const msLeft = ts + ttlDays * DAY_MS - nowMs;
  if (msLeft <= 0) return { expired: true, msLeft, label: "expired" };
  const label =
    msLeft >= DAY_MS
      ? `expires in ${Math.ceil(msLeft / DAY_MS)}d`
      : msLeft >= HOUR_MS
        ? `expires in ${Math.ceil(msLeft / HOUR_MS)}h`
        : "expires in <1h";
  return { expired: false, msLeft, label };
}

/**
 * Tolerant comparator: null/undefined/"" sort last, numbers numerically,
 * everything else case-insensitively as strings.
 */
export function compareValues(a, b) {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a).toLowerCase();
  const bs = String(b).toLowerCase();
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * Stable sort of `rows` by `getter(row)` in direction `dir` ("asc"|"desc").
 * Pinned rows always sort first regardless of key (registry pin semantics).
 */
export function sortRows(rows, getter, dir = "asc") {
  const sign = dir === "desc" ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      const pin = (y.row.pinned === true ? 1 : 0) - (x.row.pinned === true ? 1 : 0);
      if (pin !== 0) return pin;
      const c = compareValues(getter(x.row), getter(y.row));
      return c !== 0 ? sign * c : x.i - y.i;
    })
    .map((x) => x.row);
}

/**
 * Normalize one `/api/harnesses` feed into flat row objects the Library can
 * render. Tolerant by design: the server may send a bare array or
 * `{ harnesses: [...] }`, and every field falls back rather than throwing.
 */
export function normalizeRows(feed) {
  const list = Array.isArray(feed)
    ? feed
    : feed && Array.isArray(feed.harnesses)
      ? feed.harnesses
      : [];
  return list.map((r) => {
    const src = r && typeof r === "object" ? r : {};
    const caps = Array.isArray(src.capabilities) ? src.capabilities.map(String) : [];
    return {
      id: typeof src.id === "string" ? src.id : "",
      dir: typeof src.dir === "string" ? src.dir : "",
      specName:
        typeof src.specName === "string" && src.specName !== ""
          ? src.specName
          : typeof src.name === "string"
            ? src.name
            : "",
      target: typeof src.target === "string" ? src.target : "",
      model: typeof src.model === "string" ? src.model : null,
      groups: Array.isArray(src.groups) ? src.groups.map(String) : [],
      tags: Array.isArray(src.tags) ? src.tags.map(String) : [],
      pinned: src.pinned === true,
      notes: typeof src.notes === "string" ? src.notes : "",
      missingSince: typeof src.missingSince === "string" ? src.missingSince : null,
      lastSeen: typeof src.lastSeen === "string" ? src.lastSeen : null,
      lastActivityAt:
        typeof src.lastActivityAt === "string"
          ? src.lastActivityAt
          : typeof src.lastSeen === "string"
            ? src.lastSeen
            : null,
      sessions: typeof src.sessions === "number" ? src.sessions : (src.sessionCount ?? null),
      spend7dUsd: typeof src.spend7dUsd === "number" ? src.spend7dUsd : null,
      lastEval: src.lastEval && typeof src.lastEval === "object" ? src.lastEval : null,
      capabilities: caps,
      budgeted: typeof src.budgeted === "boolean" ? src.budgeted : caps.includes("budget"),
      cachedAt: typeof src.cachedAt === "string" ? src.cachedAt : null,
    };
  });
}

/**
 * Eval-health derivation for the red/green dot. The dot is ALWAYS paired
 * with text (color-blind-safe invariant), so this returns both.
 *   state: "pass" | "fail" | "unknown" | "none"
 */
export function evalHealth(lastEval) {
  if (!lastEval || typeof lastEval !== "object") return { state: "none", label: "no evals" };
  const rate = typeof lastEval.passRate === "number" ? lastEval.passRate : null;
  const pct = rate !== null ? fmtPct(rate) : "—";
  if (lastEval.healthy === true) return { state: "pass", label: pct };
  if (lastEval.healthy === false) return { state: "fail", label: pct };
  return { state: "unknown", label: pct };
}

/** True when a Library row warrants a "needs attention" flag in M1 terms. */
export function needsAttention(row) {
  if (row.missingSince !== null && row.missingSince !== undefined) return true;
  return evalHealth(row.lastEval).state === "fail";
}

/** The one-sentence fleet rollup, e.g. "12 harnesses · 2 need attention". */
export function rollupLine(rows) {
  const n = rows.length;
  const parts = [`${n} ${n === 1 ? "harness" : "harnesses"}`];
  const attention = rows.filter((r) => needsAttention(r)).length;
  if (attention > 0) parts.push(`${attention} need${attention === 1 ? "s" : ""} attention`);
  return parts.join(" · ");
}

/** The computed (never stored) smart groups, in display order. */
export const SMART_GROUPS = [
  { id: "failing-evals", label: "Failing evals" },
  { id: "unbudgeted", label: "Unbudgeted" },
  { id: "has-thredz", label: "Has Thredz" },
  { id: "recently-active", label: "Recently active" },
  { id: "ungrouped", label: "Ungrouped" },
  { id: "missing", label: "Missing" },
];

/** Membership test for one smart group against one normalized row. */
export function smartGroupMatch(id, row, nowMs) {
  switch (id) {
    case "failing-evals":
      return evalHealth(row.lastEval).state === "fail";
    case "unbudgeted":
      return row.budgeted !== true;
    case "has-thredz":
      return row.capabilities.includes("thredz");
    case "recently-active": {
      const ts = parseTs(row.lastActivityAt);
      return ts !== null && nowMs - ts <= RECENT_ACTIVITY_MS && nowMs - ts >= 0;
    }
    case "ungrouped":
      return row.groups.length === 0;
    case "missing":
      return row.missingSince !== null && row.missingSince !== undefined;
    default:
      return false;
  }
}

/** All smart groups with their member rows (client-side, from row data). */
export function deriveSmartGroups(rows, nowMs) {
  return SMART_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    rows: rows.filter((r) => smartGroupMatch(g.id, r, nowMs)),
  }));
}

/**
 * SVG path string for a mini trend line ("M x y L x y …"). Returns "" for
 * fewer than two finite points. Pure string math — the caller puts it in a
 * `<path d>` attribute, so nothing here can inject markup.
 */
export function sparklinePath(values, width = 120, height = 28, pad = 2) {
  const pts = (Array.isArray(values) ? values : []).filter(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
  if (pts.length < 2) return "";
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min;
  const innerW = width - 2 * pad;
  const innerH = height - 2 * pad;
  const step = innerW / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = pad + i * step;
    const y = range === 0 ? height / 2 : pad + (1 - (v - min) / range) * innerH;
    return `${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100}`;
  });
  return `M${coords[0]} L${coords.slice(1).join(" L")}`;
}

/**
 * Rectangles for a mini bar chart (7-day spend). Returns
 * `[{ x, y, w, h }]` in SVG user units; zero values keep a 0.5px baseline
 * sliver so "no spend" days are visibly present, not missing data.
 */
export function barRects(values, width = 140, height = 36, gap = 3) {
  const vals = (Array.isArray(values) ? values : []).map((v) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0,
  );
  const n = vals.length;
  if (n === 0) return [];
  const barW = (width - gap * (n - 1)) / n;
  const max = Math.max(...vals);
  return vals.map((v, i) => {
    const h = max > 0 && v > 0 ? Math.max(1, (v / max) * (height - 1)) : 0.5;
    const round = (x) => Math.round(x * 100) / 100;
    return { x: round(i * (barW + gap)), y: round(height - h), w: round(barW), h: round(h) };
  });
}
