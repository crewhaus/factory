/**
 * `PUT /api/h/:id/builders/plugins/:name` — use a granted plugin in one harness (#522).
 *
 * `plugins:` is the owner's (a security surface), so this is dry-run-first, like the MCP
 * connector form: the default call answers the diff, the spec name to type and the
 * spec's revision; `{"dryRun": false, "confirmName": "<spec name>", "expectedRev":
 * "<rev>"}` writes it through the one revision-guarded spec write. It always writes the
 * `{name, tools}` form, `tools: []` when none is chosen, because a bare name lets the
 * plugin drive every host tool its manifest asks for. A tool outside what the live
 * grant serves is refused. No CLI twin: edit `plugins:` in crewhaus.yaml.
 */
import { PLUGIN_NAME_RE } from "@crewhaus/control-contract";
import { parseYamlOnly } from "@crewhaus/spec-patch/commit";
import { HttpError } from "./http";
import { type M3Handler, requireTypedConfirm } from "./m3";
import { asksOf, liveGrantOf, readPluginGrants, servedOf, standingFrom } from "./plugin-grants";
import { readPluginInventory } from "./plugins";
import {
  commitSpecEdits,
  previewHomeEdits,
  readSpecFile,
  requireEditable,
  requireWholeSpec,
} from "./spec-edit";

/** The shapes whose bundles load `plugins:`. */
const PLUGIN_SHAPES = new Set(["cli", "channel"]);

type Entry = string | { readonly name: string; readonly tools: readonly string[] };

/** The spec's list with `entry` in place of every entry for its plugin, at the first one's place. */
export function withPluginEntry(current: readonly unknown[], entry: Entry & object): unknown[] {
  const out: unknown[] = [];
  let placed = false;
  for (const item of current) {
    const name =
      typeof item === "string"
        ? item
        : typeof item === "object" && item !== null
          ? (item as { name?: unknown }).name
          : undefined;
    if (name !== entry.name) {
      out.push(item);
      continue;
    }
    if (!placed) out.push(entry);
    placed = true;
  }
  if (!placed) out.push(entry);
  return out;
}

export const pluginUseWrite: M3Handler = async (ctx) => {
  const name = String(ctx.params["name"]);
  if (!PLUGIN_NAME_RE.test(name)) throw new HttpError(400, `"${name}" is not a plugin name`);
  if (ctx.hangarRoot === undefined || ctx.pluginsDir === undefined) {
    throw new HttpError(503, "plugin grants are not available on this server");
  }
  const file = readSpecFile(ctx);
  if (!file.present) {
    return {
      ok: false,
      code: "no_spec",
      reason: "this harness has no crewhaus.yaml to write into",
      verb: "crewhaus init",
    };
  }
  requireWholeSpec(file);
  if (!PLUGIN_SHAPES.has(file.target)) {
    throw new HttpError(
      409,
      `a ${file.target} harness does not load plugins: only cli and channel harnesses take plugins:`,
    );
  }
  // Checked with the schema this harness is built against; a read-only spec is refused here.
  const check = await requireEditable(ctx, file.text);
  const read = readPluginGrants(ctx.hangarRoot);
  if (!read.ok) throw new HttpError(503, `plugin grants cannot be read: ${read.reason}`);
  const row = readPluginInventory(ctx.pluginsDir, standingFrom(read.grants)).plugins.find(
    (p) => p.name === name,
  );
  const live = liveGrantOf(read.grants, name);
  if (row === undefined || live === undefined || row.problems.length > 0) {
    throw new HttpError(
      409,
      `"${name}" has no live grant: allow it in Settings › Plugins first (crewhaus plugins grant ${name})`,
    );
  }
  const served = servedOf(live, asksOf(row));
  const raw = ctx.body["tools"] ?? [];
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) {
    throw new HttpError(400, '"tools" must be a list of host tool names');
  }
  const tools = [...new Set(raw as string[])].sort();
  for (const tool of tools) {
    if (!served.tools.includes(tool)) {
      throw new HttpError(
        400,
        `"${name}" is not granted the host tool ${JSON.stringify(tool)}: grant it in Settings › Plugins first`,
      );
    }
  }
  let current: unknown[] = [];
  try {
    const plugins = (parseYamlOnly(file.text) as { plugins?: unknown }).plugins;
    current = Array.isArray(plugins) ? plugins : [];
  } catch (err) {
    throw new HttpError(409, `crewhaus.yaml does not parse: ${(err as Error).message}`);
  }
  const edits = [{ path: ["plugins"], value: withPluginEntry(current, { name, tools }) }];
  const preview = await previewHomeEdits(ctx, file.text, edits, check);
  if (!preview.ok) {
    return {
      ok: false,
      code: "edit_rejected",
      reason: preview.error ?? "the plugin entry does not apply",
      name,
      confirmName: file.specName,
    };
  }
  if (ctx.body["dryRun"] !== false) {
    return {
      ok: true,
      dryRun: true,
      name,
      tools,
      entries: preview.entries,
      diff: preview.diff,
      confirmName: file.specName,
      /** Send it back as `expectedRev` with the confirmation. */
      rev: file.rev,
      note: '`plugins` is the owner\'s: review the diff, then send {"dryRun": false, "confirmName": "<spec name>", "expectedRev": "<rev>"}.',
    };
  }
  requireTypedConfirm(ctx.body, file.specName);
  const committed = await commitSpecEdits(ctx, edits);
  return { ...committed, name, tools, action: "write" };
};
