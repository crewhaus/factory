/**
 * `@crewhaus/ir/policy`: one home for the revision digests a build is known by. A spec's
 * source revision, its policy revision, its intent digest and the digest of the files a
 * build runs from are each computed here and nowhere else, so compile, activation and
 * every later check compare like with like.
 *
 * A subpath, not part of `.`: the IR's main entry stays free of `node:` imports, and this
 * module needs `node:crypto`.
 */
import { createHash } from "node:crypto";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` properties dropped. A value
 * JSON cannot hold faithfully throws.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new RangeError("ir/policy: canonical JSON has no non-finite number");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`ir/policy: canonical JSON cannot hold a ${typeof value}`);
  }
}

/**
 * The revision of a spec's source text: `sha256:<64 hex>`. Line endings are normalized
 * (CRLF/CR to LF) and a single trailing newline is ignored, so the same spec checked out on
 * Windows, or re-saved by an editor that adds a final newline, keeps its revision. Nothing
 * else is normalized: whitespace and comments inside a spec can change behaviour (block
 * scalars carry indentation into instructions).
 */
export function specRevision(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return `sha256:${sha256Hex(normalized)}`;
}

/** The digest of a spec's `intent:` block, or `undefined` when the spec has none. */
export function intentDigest(block: unknown): string | undefined {
  if (block === undefined) return undefined;
  return `sha256:${sha256Hex(canonicalJson(block))}`;
}

/**
 * The IR keys whose values are the harness's policy. Later areas extend the list; every
 * entry is read by {@link policyMaterialOf}.
 */
export const POLICY_KEYS = ["permissions"] as const;

/**
 * The policy a lowered IR carries, as canonical JSON of the {@link POLICY_KEYS} it holds.
 * A key the IR does not carry is left out, so a spec that never declares one keeps one
 * policy revision for as long as it declares none.
 */
export function policyMaterialOf(ir: unknown): string {
  const record = typeof ir === "object" && ir !== null ? (ir as Record<string, unknown>) : {};
  const material: Record<string, unknown> = {};
  for (const key of POLICY_KEYS) {
    if (record[key] !== undefined) material[key] = record[key];
  }
  return canonicalJson(material);
}

/** `sha256:` over {@link policyMaterialOf}: the policy revision a build is activated under. */
export function policyRevision(ir: unknown): string {
  return `sha256:${sha256Hex(policyMaterialOf(ir))}`;
}

/** One input of a build. */
export type BuildFile = {
  /** Posix, relative to the harness; a synthetic entry (`extends:<spec>`) names itself. */
  readonly path: string;
  /** Hex sha256 of the bytes, or `null` when the file is absent. */
  readonly sha256: string | null;
  /** A symbolic link's own text; a link is recorded, never followed. */
  readonly link?: string;
};

/**
 * The manifest a build digest is taken over: one line per file, sorted by path,
 * `<sha256 | absent | link:<target>>  <path>`, each ending in a newline. The order of the
 * input does not matter.
 */
export function bundleManifestText(files: readonly BuildFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let text = "";
  for (const file of sorted) {
    const value =
      file.link !== undefined ? `link:${file.link}` : file.sha256 === null ? "absent" : file.sha256;
    text += `${value}  ${file.path}\n`;
  }
  return text;
}

/** `sha256:` over {@link bundleManifestText}: what a deployment record says it runs. */
export function bundleDigest(files: readonly BuildFile[]): string {
  return `sha256:${sha256Hex(bundleManifestText(files))}`;
}
