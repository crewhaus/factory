/**
 * The compile-side leak scanner (#514): runs a spec through every exit the
 * compiler has and looks for a planted marker or a control-plane id in what
 * comes out. A test imports this; `.` does not, so a bundle never loads it. The
 * compiler worker sits above this package, so its exits are scanned in its own
 * test.
 */
import { projectLoop, renderBundleReadme } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { compile, lower } from "./index";

export { ABSENT_CORPUS } from "./absent-corpus";

/** One place compiled output leaves the compiler: a name to report, and its text. */
export type CompiledExit = { readonly exit: string; readonly text: string };

/**
 * Every exit for one spec: `files:<path>` from `compile()`, `eval:<path>` for
 * the eval-entry variant, `emit-ir` in the form `crewhaus compile --emit-ir`
 * prints, the `loop` projection and the bundle `readme`.
 */
export function compiledExits(yaml: string): ReadonlyArray<CompiledExit> {
  const ir = lower(parseSpec(yaml));
  return [
    ...compile(yaml).files.map((f) => ({ exit: `files:${f.path}`, text: f.content })),
    ...compile(yaml, { evalEntry: true }).files.map((f) => ({
      exit: `eval:${f.path}`,
      text: f.content,
    })),
    { exit: "emit-ir", text: JSON.stringify(ir, null, 2) },
    { exit: "loop", text: JSON.stringify(projectLoop(ir)) },
    { exit: "readme", text: renderBundleReadme(ir) },
  ];
}

/** The exits whose text contains `needle`. */
export function exitHits(yaml: string, needle: string | RegExp): ReadonlyArray<CompiledExit> {
  return compiledExits(yaml).filter(({ text }) =>
    typeof needle === "string" ? text.includes(needle) : text.search(needle) !== -1,
  );
}

/** Throws, naming each spec and exit, when any spec's output contains `marker`. */
export function expectNoMarker(
  specs: Readonly<Record<string, string>>,
  marker: string | RegExp,
): void {
  const leaks: string[] = [];
  for (const [name, yaml] of Object.entries(specs)) {
    for (const { exit } of exitHits(yaml, marker)) leaks.push(`${name} → ${exit}`);
  }
  if (leaks.length > 0) {
    throw new Error(`marker ${String(marker)} reached a compile exit: ${leaks.join(", ")}`);
  }
}

/**
 * Any control-plane id: the shared control core's prefixes and the people
 * module's. Every id body is 16 hex characters or a 26-character ULID, and the
 * `{16,}` keeps emitted words such as `run_failed` out. No `g` flag, so it holds
 * no state between calls.
 */
export const CONTROL_PLANE_ID_RE =
  /\b(?:hrn|dep|run|sess|appr|dec|rule|cmd|prn|grt|inv|crd|lnk|dev|wi|att|con|crs|chg|psn|pcl|pgr|ppj|pso|piv|pex|per|spc)_[0-9A-Za-z]{16,}/;
