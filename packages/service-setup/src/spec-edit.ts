/**
 * Comment-preserving edits to a harness's `crewhaus.yaml`.
 *
 * Setup writes exactly ONE spec field: `thredz.space`. It has to, because the
 * compiler bakes that value in as a LITERAL — it becomes the synthesized MCP
 * child's `THREDZ_DEFAULT_SPACE`, so an env ref would not survive lowering
 * the way `thredz.api_key` does. Everything else setup learns is a secret and
 * goes to `.env`.
 *
 * `@crewhaus/spec-patch` is the repo's YAML write-back tool and is
 * deliberately NOT used here: its `OPTIMIZABLE_PATHS` excludes the
 * `["thredz"]` prefix precisely so that `optimize --write-back` and the
 * Hangar spec editor can never rewrite anything under it. Reaching past that
 * guard from a library would weaken it for every other caller. Instead this
 * module edits the `yaml` Document directly — the same CST-preserving
 * mechanism spec-patch uses — and touches one documented key.
 *
 * A spec author who inlined a literal `thredz.api_key` gets no help from this
 * module: setup refuses to add a space beside a plaintext credential, matching
 * Hangar's refusal to proxy such a spec at all.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { type Document, type YAMLMap, isMap, parseDocument } from "yaml";
import { ServiceSetupError } from "./types";

/** What a spec edit did. */
export type SpecEditResult = {
  readonly file: string;
  readonly path: string;
  readonly outcome: "set" | "unchanged";
  /** The value now in the file — a slug, never a secret. */
  readonly value: string;
};

/**
 * Set `thredz.space` to `slug`, preserving comments, key order and the rest
 * of the document byte-for-byte.
 *
 * Returns `unchanged` when the file already says exactly this, so a re-run is
 * a no-op rather than a rewrite. Refuses when there is no `thredz:` block to
 * scope (setup would be inventing memory configuration the author did not
 * ask for) or when the block is one of the shorthand forms, since collapsing
 * `thredz: $KEY` into a map would silently restructure the author's spec.
 */
export function setThredzSpace(specPath: string, slug: string): SpecEditResult {
  const doc = parseDocument(readFileSync(specPath, "utf8"));
  const file = basename(specPath);
  const verdict = inspectThredzSpace(doc, file, slug);

  if (verdict.kind === "refused") {
    throw new ServiceSetupError("harness", verdict.reason, { fix: verdict.fix });
  }
  if (verdict.kind === "unchanged") {
    return { file, path: "thredz.space", outcome: "unchanged", value: slug };
  }

  verdict.block.set("space", slug);
  writeFileSync(specPath, String(doc), "utf8");
  return { file, path: "thredz.space", outcome: "set", value: slug };
}

/**
 * Render what {@link setThredzSpace} WOULD do, without touching the file.
 *
 * It reports the REFUSALS too, not just the happy path. A dry run whose
 * output implies success where the apply will throw is worse than no dry run
 * at all — it is the one output an operator reads specifically to decide
 * whether to proceed. Both functions therefore route through the same
 * {@link inspectThredzSpace} verdict, so they cannot drift.
 */
export function previewThredzSpace(specPath: string, slug: string): string {
  const doc = parseDocument(readFileSync(specPath, "utf8"));
  const file = basename(specPath);
  const verdict = inspectThredzSpace(doc, file, slug);

  if (verdict.kind === "refused") return `cannot set thredz.space — ${verdict.reason}`;
  if (verdict.kind === "unchanged") return `thredz.space already reads "${slug}"`;
  const current = verdict.block.get("space");
  return `thredz.space: ${current === undefined ? "(unset)" : String(current)} → "${slug}"`;
}

/** One verdict, shared by the apply and its dry run. */
type ThredzSpaceVerdict =
  | { readonly kind: "refused"; readonly reason: string; readonly fix: string }
  | { readonly kind: "unchanged" }
  | { readonly kind: "set"; readonly block: YAMLMap };

/**
 * Decide what setting `thredz.space` on this document would do — pure, and
 * the single source of truth for every refusal.
 */
function inspectThredzSpace(doc: Document, file: string, slug: string): ThredzSpaceVerdict {
  const thredz = doc.get("thredz");

  if (thredz === undefined || thredz === null || thredz === false) {
    return {
      kind: "refused",
      reason: `${file} has no thredz: block to scope`,
      fix: "add a thredz: block with an api_key ref before provisioning a wiki space",
    };
  }
  if (typeof thredz === "boolean" || typeof thredz === "string") {
    // Name the FORM, never the value. In the string shorthand the scalar IS
    // the Thredz API key (`thredz: $KEY` is documented as "THE one
    // argument"), and the schema accepts a literal there — so echoing it
    // would print a live credential to stdout, into scrollback and CI logs.
    // The sibling refusal below already withholds an inlined `api_key`; this
    // is the same rule, and the shorthand is the easier one to overlook.
    const form = typeof thredz === "boolean" ? `thredz: ${String(thredz)}` : "thredz: <value>";
    return {
      kind: "refused",
      reason: `${file} uses the thredz shorthand (\`${form}\`), which has nowhere to put a space`,
      fix: "expand it to the object form — `thredz:\\n  api_key: $YOUR_KEY_VAR` — then re-run",
    };
  }
  if (!isMap(thredz)) {
    return {
      kind: "refused",
      reason: `${file}'s thredz: block is not a mapping`,
      fix: "make thredz: a mapping with an api_key key",
    };
  }

  const inlineKey = thredz.get("api_key");
  if (typeof inlineKey === "string" && !inlineKey.startsWith("$")) {
    return {
      kind: "refused",
      reason: `${file} inlines a literal thredz.api_key — setup will not add configuration beside a plaintext credential`,
      fix: "move the key into a $UPPER_SNAKE env ref and put the value in .env, then re-run",
    };
  }

  return thredz.get("space") === slug ? { kind: "unchanged" } : { kind: "set", block: thredz };
}
