import { z } from "zod";
import type { Spec } from "../index";
import type { SpecAddIssue } from "./delta-090";

/**
 * A tool name every model provider accepts. A copy of plugin-sdk's
 * `PLUGIN_TOOL_NAME_PATTERN` (spec does not depend on plugin-sdk); a test in
 * apps/cli holds the two equal.
 */
export const PLUGIN_ENTRY_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** The most host tools one `{name, tools}` entry lists. */
export const MAX_PLUGIN_ENTRY_TOOLS = 64;

/**
 * A union of a plugin name and a `{name, tools}` entry that checks each element
 * against one form only: a string against the name, anything else against the
 * strict object. A plain union would answer a bad object with one generic union
 * error; this keeps the object's own path and message. It is still a
 * `ZodUnion`, so the JSON Schema describes both forms (`anyOf`).
 */
class EntryFormUnion<T extends readonly [z.ZodTypeAny, z.ZodTypeAny]> extends z.ZodUnion<T> {
  override _parse(input: z.ParseInput): z.ParseReturnType<this["_output"]> {
    const [nameForm, objectForm] = this._def.options;
    return (typeof input.data === "string" ? nameForm : objectForm)._parse(input);
  }
}

const nameForm = z.string().min(1);
const objectForm = z
  .object({
    name: z.string().min(1),
    tools: z
      .array(
        z
          .string()
          .regex(
            PLUGIN_ENTRY_TOOL_NAME_PATTERN,
            'plugins[].tools entries must be 1-64 letters, digits, "_" or "-"',
          ),
      )
      .max(
        MAX_PLUGIN_ENTRY_TOOLS,
        `plugins[].tools lists at most ${MAX_PLUGIN_ENTRY_TOOLS} host tools`,
      ),
  })
  .strict();

const entry: z.ZodUnion<[typeof nameForm, typeof objectForm]> = new EntryFormUnion({
  options: [nameForm, objectForm],
  typeName: z.ZodFirstPartyTypeKind.ZodUnion,
});

/**
 * The `plugins:` list (#522): installed marketplace plugins whose
 * contributions (tools, plus skill dirs) this bundle loads at boot, in load
 * order. Each entry is resolved against the pinned plugin registry, whose
 * Ed25519 supply chain guards install. An entry is either:
 *
 * - a plugin NAME: its tools may drive every host tool its manifest's
 *   `permissions.tools` asks for; or
 * - `{name, tools}`: they may drive only the host tools in both `tools` and
 *   the manifest's list (`tools: []` grants none).
 *
 * The `crewhaus run --plugins` flag overrides the list, keeping the spec's
 * `{name, tools}` entry for a name it lists. Carried on the codegen-serving
 * shapes whose boot path reads the registry (cli + channel).
 */
export const pluginsBlock = z.array(entry).optional();

/**
 * The one cross-field rule: a plugin whose entry is an object is listed once,
 * because two entries would disagree on what it may drive. A list of plain
 * names may repeat one; the loader keeps the first.
 */
export function pluginsIssues(data: Spec, custom: SpecAddIssue): void {
  if (!("plugins" in data) || !Array.isArray(data.plugins)) return;
  const entries = data.plugins;
  const nameOf = (e: (typeof entries)[number]): string => (typeof e === "string" ? e : e.name);
  const objectNames = new Set(entries.filter((e) => typeof e !== "string").map(nameOf));
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    const name = nameOf(e);
    if (seen.has(name) && objectNames.has(name)) {
      custom(
        ["plugins", i],
        `plugins[${i}] lists "${name}" again: list a plugin once when one of its entries is {name, tools}.`,
      );
    }
    seen.add(name);
  });
}
