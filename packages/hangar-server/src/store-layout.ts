/**
 * Where a harness keeps its knowledge stores, and who owns its wiki.
 *
 * The one layout rule every reader in this package shares. `wiki-store` and
 * `continuity-store` nest their files under the spec name (`wiki/<spec>/…`,
 * `state/<spec>/…`), which is what a live harness has; older trees carry the
 * flat shape (`wiki/…`, `state/…`). The choice is made per STORE, never per
 * file: a write always lands in the store this rule picks, so a read that
 * mixed the two would show a file the next save does not touch.
 *
 * Not exported from the package index. Reads only: nothing here creates,
 * rebuilds or rewrites a file.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readSpecHeader } from "@crewhaus/harness-inventory";
import { SPEC_FILENAMES } from "@crewhaus/harness-supervisor";
import { SAFE_SEGMENT_RE } from "./constants";
import { resolveInside } from "./safety";
import { scanThredzBlock } from "./thredz";

/** What marks a directory as a wiki store. */
export const WIKI_STORE_PROBE: readonly string[] = ["articles", "index.json"];
/** What marks a directory as a continuity store. */
export const STATE_STORE_PROBE: readonly string[] = [
  "focus.md",
  "goals.yaml",
  "plans",
  "handoff.md",
];

/** The shape both `memory-store` and `wiki-store` accept as a spec name. */
const STORE_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** True when a spec name may be handed to a store constructor. */
export function isStoreName(name: string): boolean {
  return STORE_NAME_RE.test(name) && !/^\.+$/.test(name);
}

/**
 * The harness's spec text: the first spec file that exists, read through
 * containment. A spec file that exists and cannot be read answers undefined
 * rather than falling through to the next name, because the next name is not
 * the file this harness runs from.
 */
export function readHarnessSpec(dir: string): string | undefined {
  for (const name of SPEC_FILENAMES) {
    try {
      lstatSync(join(dir, name));
    } catch {
      continue;
    }
    const path = resolveInside(dir, [name]);
    if (path === undefined) return undefined;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The name the stores scope their files under: the spec's, else the dir's. */
export function liveSpecName(dir: string): string {
  const name = readSpecHeader(readHarnessSpec(dir) ?? "").name;
  return typeof name === "string" && name !== "" ? name : basename(dir);
}

/**
 * The store directory for one area: spec-scoped when the name is usable and
 * any probe exists there, else flat when any probe exists there, else
 * undefined. `segments` is harness-relative, ready for per-file containment.
 */
export function liveStore(
  dir: string,
  area: string,
  specName: string,
  probe: readonly string[],
): { readonly segments: readonly string[]; readonly layout: "spec-scoped" | "flat" } | undefined {
  const holdsStore = (segments: readonly string[]): boolean => {
    const root = resolveInside(dir, segments);
    return root !== undefined && probe.some((p) => existsSync(join(root, p)));
  };
  if (isStoreName(specName) && SAFE_SEGMENT_RE.test(specName)) {
    const segments = [".crewhaus", area, specName];
    if (holdsStore(segments)) return { segments, layout: "spec-scoped" };
  }
  const segments = [".crewhaus", area];
  return holdsStore(segments) ? { segments, layout: "flat" } : undefined;
}

/** The chosen wiki store's segments for a harness, when it has one. */
export function liveWikiSegments(dir: string): readonly string[] | undefined {
  return liveStore(dir, "wiki", liveSpecName(dir), WIKI_STORE_PROBE)?.segments;
}

/**
 * `index.json`'s slug map, from either shape: the store's
 * `{version, articles: {...}}` or the bare map older trees carry. null when
 * the value holds no map at all.
 */
export function wikiIndexArticles(raw: unknown): Record<string, Record<string, unknown>> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const holder = (raw as Record<string, unknown>)["articles"] ?? raw;
  if (typeof holder !== "object" || holder === null || Array.isArray(holder)) return null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [slug, entry] of Object.entries(holder as Record<string, unknown>)) {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      out[slug] = entry as Record<string, unknown>;
    }
  }
  return out;
}

/** Where a harness's wiki lives. `unknown` means its spec could not say. */
export type WikiAuthority = "local" | "thredz" | "unknown";

/** The targets whose emitted bundles keep their wiki in Thredz. */
const THREDZ_WIKI_TARGETS: ReadonlySet<string> = new Set(["cli", "channel", "managed", "crew"]);

/**
 * Who owns this harness's wiki, from its spec alone. A missing API key does
 * not change the answer: the wiki still belongs to Thredz, and a local write
 * would land in a store the agent does not read. `research` carries the
 * `thredz:` block without acting on it, so its wiki stays local.
 */
export function wikiAuthorityOf(dir: string): WikiAuthority {
  const yamlText = readHarnessSpec(dir);
  if (yamlText === undefined) return "unknown";
  if (!scanThredzBlock(yamlText).declared) return "local";
  const target = readSpecHeader(yamlText).target;
  if (target !== undefined && THREDZ_WIKI_TARGETS.has(target)) return "thredz";
  return target === "research" ? "local" : "unknown";
}
