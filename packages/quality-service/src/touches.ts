/**
 * What a change touches, read off the difference between the file before and after:
 * the change surfaces (prompts, tools, retrieval, routing, budgets, criteria, cases),
 * whether a protected bar or criterion moves, whether the spec's `intent:` moves, and
 * whether a security surface moves or spending can rise.
 *
 * `security` asks the same two questions Home asks of a direct spec edit: does any
 * changed path lie on one of spec-patch's `SECURITY_SURFACES` (`surfaceFor`), and does
 * `escalationFor` ask for the security edit permission (a raise of spending, a loosened
 * protected bar). A change that touches a protected bar, the intent or a security
 * surface needs the owner to adopt it; any other needs a maintainer.
 */
import type { ChangeSurface } from "@crewhaus/control-contract";
import {
  type GradersConfig,
  boundSpecsOf,
  criterionDigest,
  loosening,
  parseGradersConfig,
} from "@crewhaus/eval-grader";
import { escalationFor, protectedBarChange, surfaceFor } from "@crewhaus/spec-patch";
import { parse as parseYaml } from "yaml";
import type { ChangeTouches } from "./store";

/** Which surface a spec path belongs to, by the first segment that names one. */
const SURFACE_SEGMENTS: ReadonlyArray<readonly [ChangeSurface, ReadonlyArray<string>]> = [
  [
    "prompts",
    ["instructions", "system", "system_prompt", "prompt", "few_shot", "examples", "persona"],
  ],
  [
    "tools",
    ["tools", "tool_config", "mcp", "mcp_servers", "permissions", "plugins", "hooks", "skills"],
  ],
  ["retrieval", ["retrieval", "rag", "knowledge", "memory", "continuity", "wiki", "index"]],
  [
    "routing",
    [
      "model",
      "model_pool",
      "model_tiers",
      "model_fallbacks",
      "fallbacks",
      "routing",
      "circuit_breaker",
    ],
  ],
  [
    "budgets",
    ["budget", "limits", "max_tokens", "max_tool_iterations", "thinking", "compaction", "timeout"],
  ],
];

/** The surface a path's segments belong to, or `undefined` for none. */
export function surfaceOfPath(segments: ReadonlyArray<string>): ChangeSurface | undefined {
  for (const segment of segments) {
    for (const [surface, names] of SURFACE_SEGMENTS) {
      if (names.includes(segment)) return surface;
    }
  }
  return undefined;
}

const isContainer = (v: unknown): v is Record<string, unknown> | unknown[] =>
  typeof v === "object" && v !== null;

function entriesOf(v: Record<string, unknown> | unknown[]): Array<[string, unknown]> {
  return Array.isArray(v)
    ? v.map((item, i): [string, unknown] => [String(i), item])
    : Object.entries(v);
}

/** Every path inside a value, the value's own path included. */
function everyPath(value: unknown, at: readonly string[], out: string[][]): void {
  out.push([...at]);
  if (!isContainer(value)) return;
  for (const [key, child] of entriesOf(value)) everyPath(child, [...at, key], out);
}

/**
 * Every place two parsed documents differ, as segment lists. Where a value is added,
 * removed or replaced by one of another shape, every path inside it counts, and the
 * place itself.
 */
export function changedPaths(before: unknown, after: unknown): string[][] {
  const out: string[][] = [];
  const walk = (a: unknown, b: unknown, at: readonly string[]): void => {
    const bothMaps = isContainer(a) && isContainer(b) && !Array.isArray(a) && !Array.isArray(b);
    const bothLists = Array.isArray(a) && Array.isArray(b);
    if (bothMaps || bothLists) {
      const left = new Map(entriesOf(a as Record<string, unknown>));
      const right = new Map(entriesOf(b as Record<string, unknown>));
      for (const key of new Set([...left.keys(), ...right.keys()])) {
        const path = [...at, key];
        if (!left.has(key)) everyPath(right.get(key), path, out);
        else if (!right.has(key)) everyPath(left.get(key), path, out);
        else walk(left.get(key), right.get(key), path);
      }
      return;
    }
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    everyPath(a, at, out);
    everyPath(b, at, out);
  };
  walk(before, after, []);
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = p.join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseOrThrow(text: string, which: string): unknown {
  try {
    return parseYaml(text);
  } catch (err) {
    throw new Error(`the ${which} spec does not parse: ${(err as Error).message}`);
  }
}

/** What a spec change touches, from the spec's text before and after. */
export function touchesOf(beforeYaml: string, afterYaml: string): ChangeTouches {
  const before = parseOrThrow(beforeYaml, "current");
  const after = parseOrThrow(afterYaml, "proposed");
  const paths = changedPaths(before, after);
  const surfaces = new Set<ChangeSurface>();
  for (const path of paths) {
    const surface = surfaceOfPath(path);
    if (surface !== undefined) surfaces.add(surface);
  }
  const security =
    paths.some((path) => path.length > 0 && surfaceFor(path) !== undefined) ||
    escalationFor(before, after).some((e) => e.needs === "h.spec.edit.security");
  const protectedMoved =
    protectedBarChange(before, after) !== undefined ||
    paths.some((path) => path.includes("protected"));
  const intent = paths.some((path) => path[0] === "intent");
  return { surfaces: [...surfaces].sort(), protected: protectedMoved, intent, security };
}

function protectedDigests(config: GradersConfig): Map<string, string> {
  return new Map(
    (config.criteria ?? [])
      .filter((c) => c.protected === true)
      .map((c) => [c.id, criterionDigest(c, boundSpecsOf(config, c))]),
  );
}

/** What a graders change touches: the criteria, and whether a protected one moves. */
export function touchesOfGraders(beforeYaml: string, afterYaml: string): ChangeTouches {
  const before = parseGradersConfig(beforeYaml).config;
  const after = parseGradersConfig(afterYaml).config;
  const was = protectedDigests(before);
  const now = protectedDigests(after);
  const moved =
    loosening(before, after).length > 0 ||
    [...was].some(([id, digest]) => now.get(id) !== digest) ||
    [...now].some(([id, digest]) => was.get(id) !== digest);
  return { surfaces: ["criteria"], protected: moved, intent: false, security: false };
}

/** What a dataset change touches: its cases. */
export function touchesOfCases(): ChangeTouches {
  return { surfaces: ["cases"], protected: false, intent: false, security: false };
}

/** Who may adopt a change: the owner when it touches a protected bar, the intent or a
 *  security surface; a maintainer otherwise. */
export function requiredClassFor(touches: ChangeTouches): "maintainer" | "owner" {
  return touches.protected || touches.intent || touches.security ? "owner" : "maintainer";
}
