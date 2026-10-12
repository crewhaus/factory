/**
 * A harness's identity — name, shape, model — read leniently.
 *
 * A fleet scan must not die on one stale spec. `parseSpec` is strict by
 * design (it is the compiler's front door), so this reads identity through
 * it when it can and falls back to a line scan when it cannot, marking the
 * result so the caller can say "unparseable" rather than silently reporting
 * a harness that will not build.
 *
 * The fallback is a LINE SCAN, not a YAML parse: it reads a top-level
 * `name:` / `target:` and an `agent.model:`, which is all a fleet table
 * needs, and nothing else. It is best-effort by construction — a spec that
 * fails `parseSpec` has no guaranteed structure left to rely on.
 *
 * Pure: text in, data out.
 */

import { collectSpecModels } from "@crewhaus/preflight";
import { parseSpec, parseSpecIssues } from "@crewhaus/spec";

export type SpecIdentity = {
  readonly name?: string;
  readonly target?: string;
  /** The primary serving model, when the spec names one. */
  readonly model?: string;
  /** False when `parseSpec` rejected the document. */
  readonly valid: boolean;
  /** The first diagnostic, when invalid — enough to say why without a report. */
  readonly firstIssue?: string;
  /** True when name/target came from the line-scan fallback. */
  readonly lenient: boolean;
};

/** A code unit `\s` matches: WhiteSpace or LineTerminator. */
function isRegExpSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** A code unit `.` does not match. */
const isLineBreak = (c: number): boolean =>
  c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;

/**
 * `text` without a ` # comment` running to its end: what
 * `text.replace(/\s+#.*$/, "")` returned, found in two scans. That pattern
 * tries every start inside a run of whitespace and, where no `#` follows the
 * run, rescans the rest of it from each before giving the start up, so a
 * long run inside a value was quadratic in its length; a spec is the
 * workspace's.
 */
export function withoutTrailingComment(text: string): string {
  // `.*$` cannot cross a line break, so the `#` comes after the last one.
  let lastBreak = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (isLineBreak(text.charCodeAt(i))) {
      lastBreak = i;
      break;
    }
  }
  let runStart = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isRegExpSpace(c)) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (c === 0x23 && runStart >= 0 && i > lastBreak) return text.slice(0, runStart);
    runStart = -1;
  }
  return text;
}

/** Strip a scalar's quotes and trailing comment — enough for the fallback. */
function scalar(raw: string): string | undefined {
  const value = withoutTrailingComment(raw.trim()).trim();
  const unquoted = /^(['"])(.*)\1$/.exec(value);
  const out = unquoted?.[2] ?? value;
  return out === "" ? undefined : out;
}

export function lineScan(text: string): { name?: string; target?: string; model?: string } {
  let name: string | undefined;
  let target: string | undefined;
  let model: string | undefined;
  for (const line of text.split("\n")) {
    const top = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (top !== null) {
      const key = top[1];
      const value = scalar(top[2] ?? "");
      if (key === "name" && name === undefined) name = value;
      if (key === "target" && target === undefined) target = value;
      continue;
    }
    const nested = /^\s{1,4}model:(.*)$/.exec(line);
    if (nested !== null && model === undefined) model = scalar(nested[1] ?? "");
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/** The model a fleet table shows: the agent's, else the first slot, sorted. */
function primaryModel(spec: unknown): string | undefined {
  const models = collectSpecModels(spec);
  for (const slot of models) {
    if (slot.sources.includes("agent.model")) return slot.model;
  }
  const sorted = [...models].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return sorted[0]?.model;
}

/** Read what a fleet table needs from spec text, strictly then leniently. */
export function readSpecIdentity(text: string): SpecIdentity {
  try {
    const spec = parseSpec(text) as unknown as Record<string, unknown>;
    const name = typeof spec["name"] === "string" ? spec["name"] : undefined;
    const target = typeof spec["target"] === "string" ? spec["target"] : undefined;
    const model = primaryModel(spec);
    return {
      ...(name !== undefined ? { name } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(model !== undefined ? { model } : {}),
      valid: true,
      lenient: false,
    };
  } catch {
    const scanned = lineScan(text);
    const issue = parseSpecIssues(text)[0];
    return {
      ...scanned,
      valid: false,
      ...(issue !== undefined
        ? {
            firstIssue:
              issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
          }
        : {}),
      lenient: true,
    };
  }
}
