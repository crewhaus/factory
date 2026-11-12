/**
 * The 0.8.0 article parser, copied verbatim from `packages/wiki-store/src/index.ts`
 * at the `v0.8.0` tag (`git show v0.8.0:packages/wiki-store/src/index.ts`), with the
 * helpers it calls. The mixed-versions test runs it over an article this release
 * writes, so an older reader is known to read an operator-written article and drop
 * only `author`. Do not edit the bodies.
 */
import YAML from "yaml";
import {
  UNKNOWN_TIMESTAMP,
  type WikiArticle,
  type WikiArticleStatus,
  type WikiCreatedBy,
  WikiStoreError,
} from "../index";

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,127}$/;

/** A calendar date: ECMAScript reads a date-only form as UTC midnight. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A date-time as `Date#toISOString` writes it, or as RFC 3339 and ISO 8601
 * allow it by hand: a `T`, `t` or space between date (group 1) and time
 * (group 2), a `.` or `,` before the fraction, and an offset that is `Z`,
 * `±hh:mm`, `±hhmm` or `±hh` (groups 3–6), or none. Linear: no quantifier is
 * nested or overlapping.
 */
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?)(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?$/;

/**
 * `value` as an ISO-8601 timestamp, or {@link UNKNOWN_TIMESTAMP}. A timestamp
 * is printed in list rows and sorted on, and a file on disk (which any agent
 * with a write tool can edit) could put any text there, so only a timestamp
 * is kept, written the one way `Date.parse` reads the same everywhere: `T`,
 * `.`, and `Z` or `±hh:mm`. A date-time without an offset is read as UTC — a
 * `Z` is appended — never as the host's local time, which is what
 * `Date.parse` would do with it. The result is its own normal form.
 */
function isoTimestampOr(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_TIMESTAMP;
  let iso: string | undefined;
  if (ISO_DATE.test(value)) iso = value;
  else {
    const m = value.match(DATE_TIME);
    if (m !== null) {
      const [, date, time, z, sign, hh, mm] = m;
      const zone = z !== undefined || sign === undefined ? "Z" : `${sign}${hh}:${mm ?? "00"}`;
      iso = `${date}T${(time ?? "").replace(",", ".")}${zone}`;
    }
  }
  return iso !== undefined && !Number.isNaN(Date.parse(iso)) ? iso : UNKNOWN_TIMESTAMP;
}

const ARTICLE_STATUSES: ReadonlyArray<WikiArticleStatus> = [
  "draft",
  "published",
  "review",
  "archived",
];

/** Parse an article file. Throws `WikiStoreError` on a malformed file. */
export function parseArticle(raw: string): WikiArticle {
  if (!raw.startsWith("---\n")) {
    throw new WikiStoreError("article file is missing its YAML frontmatter block");
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    throw new WikiStoreError("article frontmatter block is unterminated (no closing ---)");
  }
  const yamlText = raw.slice(4, end + 1);
  const rest = raw.slice(end + 4);
  const body = rest.replace(/^\r?\n+/, "").trimEnd();
  let fm: unknown;
  try {
    fm = YAML.parse(yamlText);
  } catch (err) {
    throw new WikiStoreError(
      `article frontmatter is not valid YAML: ${(err as Error).message}`,
      err,
    );
  }
  if (typeof fm !== "object" || fm === null) {
    throw new WikiStoreError("article frontmatter must be a YAML mapping");
  }
  const v = fm as Record<string, unknown>;
  const strArr = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((t): t is string => typeof t === "string") : [];
  if (typeof v["slug"] !== "string" || !SLUG_REGEX.test(v["slug"])) {
    throw new WikiStoreError("article frontmatter has a missing/invalid slug");
  }
  if (typeof v["title"] !== "string" || v["title"] === "") {
    throw new WikiStoreError(`article "${v["slug"]}" frontmatter has a missing title`);
  }
  if (typeof v["version"] !== "number" || !Number.isInteger(v["version"]) || v["version"] < 1) {
    throw new WikiStoreError(`article "${v["slug"]}" frontmatter has a missing/invalid version`);
  }
  const status = ARTICLE_STATUSES.includes(v["status"] as WikiArticleStatus)
    ? (v["status"] as WikiArticleStatus)
    : "published";
  const createdByRaw = v["createdBy"];
  let createdBy: WikiCreatedBy | undefined;
  if (typeof createdByRaw === "object" && createdByRaw !== null) {
    const cb = createdByRaw as Record<string, unknown>;
    if (typeof cb["sessionId"] === "string") {
      createdBy = {
        sessionId: cb["sessionId"],
        ...(typeof cb["agentIdentity"] === "string" ? { agentIdentity: cb["agentIdentity"] } : {}),
      };
    }
  }
  return {
    slug: v["slug"],
    title: v["title"],
    tags: strArr(v["tags"]),
    confidence: clamp01(typeof v["confidence"] === "number" ? v["confidence"] : 0.5),
    verified: v["verified"] === true,
    version: v["version"],
    sources: strArr(v["sources"]),
    ...(typeof v["supersedes"] === "number" ? { supersedes: v["supersedes"] } : {}),
    ...(createdBy !== undefined ? { createdBy } : {}),
    status,
    createdAt: isoTimestampOr(v["createdAt"]),
    updatedAt: isoTimestampOr(v["updatedAt"]),
    body,
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
