/**
 * `crewhaus plugins grants [<name>]`, `crewhaus plugins grant <name> …` and
 * `crewhaus plugins revoke <name>` (#522): what each installed plugin asks for, what
 * its owner granted, and what Home serves it; and the owner's grant and revoke.
 *
 * A grant or revoke is a workspace command: a receipt in Home's own ledger, written
 * through the control service the way `crewhaus retire` writes one, with the same code
 * Home's `plugins.grant` operation runs (`@crewhaus/hangar-server`'s plugin grants). A
 * request that names something the plugin does not ask for, a harness Home does not
 * know, or a generation that is not the live grant's, is refused before any receipt.
 *
 * Lists are comma-separated, the CLI's convention (`--plugins a,b`): the flag parser
 * keeps the last of a repeated flag, so `--panes a --panes b` would grant only `b`.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { PLUGIN_EVENT_FAMILIES, PLUGIN_READS } from "@crewhaus/control-contract";
import { outcomeOf } from "@crewhaus/control-service";
import {
  type GrantOutcome,
  type PluginGrantInput,
  type PluginRow,
  expectHolds,
  grantPlugin,
  grantProblem,
  liveGrantOf,
  pluginReviewOf,
  readPluginGrants,
  readPluginInventory,
  revokePlugin,
  standingFrom,
} from "@crewhaus/hangar-server/plugin-grants";
import { openHangarRegistry, resolveHangarRoot } from "@crewhaus/harness-registry";
import { type DaemonCommandOptions, directControl } from "./daemon-cmd";

export type PluginsGrantResult = { readonly lines: readonly string[]; readonly exitCode: number };

export type PluginsGrantOptions = {
  readonly pluginsDir: string;
  /** The seams the daemon verbs take: env, clock, identity. */
  readonly opts?: DaemonCommandOptions;
};

/** The state words Home shows, never colour alone. */
export const PLUGIN_STATE_WORDS: Readonly<Record<string, string>> = {
  waiting: "Waiting for your OK",
  allowed: "Allowed",
  "asks-for-more": "Asks for more",
  revoked: "Revoked",
};

const refuse = (line: string): PluginsGrantResult => ({ lines: [line], exitCode: 1 });

/**
 * A comma-separated flag value as a list: absent is `[]`; an empty item is refused,
 * naming the flag, so `--panes a,,b` never quietly grants two.
 */
export function parseListFlag(
  flag: string,
  value: string | boolean | undefined,
): { readonly ok: true; readonly items: string[] } | { readonly ok: false; readonly why: string } {
  if (value === undefined) return { ok: true, items: [] };
  if (typeof value !== "string") return { ok: false, why: `--${flag} needs a value` };
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => item === "")) {
    return { ok: false, why: `--${flag} ${JSON.stringify(value)} has an empty item` };
  }
  return { ok: true, items: [...new Set(items)] };
}

type Env = Readonly<Record<string, string | undefined>>;

function envOf(o: PluginsGrantOptions): Env {
  return o.opts?.env ?? process.env;
}

function registryOf(env: Env) {
  try {
    return openHangarRegistry({ env: env as Record<string, string | undefined> });
  } catch {
    return undefined;
  }
}

const realOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

function inventoryOf(o: PluginsGrantOptions, hangarRoot: string) {
  const read = readPluginGrants(hangarRoot);
  if (!read.ok) return { ok: false as const, why: `plugin grants cannot be read: ${read.reason}` };
  const plugins = readPluginInventory(o.pluginsDir, standingFrom(read.grants)).plugins;
  return { ok: true as const, grants: read.grants, plugins };
}

const listed = (values: readonly string[] | "all"): string =>
  values === "all" ? "all" : values.length === 0 ? "none" : values.join(", ");

/** `crewhaus plugins grants [<name>]`: each plugin, its state word, what it asks and what is served. Reads only. */
export function pluginGrantsCommand(
  name: string | undefined,
  o: PluginsGrantOptions,
): PluginsGrantResult {
  const env = envOf(o);
  const hangarRoot = resolveHangarRoot(env as Record<string, string | undefined>);
  const read = inventoryOf(o, hangarRoot);
  if (!read.ok) return refuse(read.why);
  const harnesses = (registryOf(env)?.list() ?? []).map((e) => ({ id: e.id, dir: e.dir }));
  const rows = name === undefined ? read.plugins : read.plugins.filter((p) => p.name === name);
  if (name !== undefined && rows.length === 0) {
    return refuse(`no plugin "${name}" is installed: crewhaus plugins install ${name}`);
  }
  if (rows.length === 0) {
    return { lines: ["No plugins installed: crewhaus plugins install <name>"], exitCode: 0 };
  }
  const lines: string[] = [];
  for (const row of rows) {
    if (row.problems.length > 0) {
      lines.push(`${row.name}  cannot be granted: ${row.problems.join("; ")}`);
      continue;
    }
    const review = pluginReviewOf(row, read.grants.get(row.name), harnesses, () => true);
    const word = PLUGIN_STATE_WORDS[review.state] ?? review.state;
    lines.push(
      `${row.name} ${row.version}  ${word}${review.gen === null ? "" : ` (generation ${review.gen})`}`,
    );
    for (const [label, set] of [
      ["asks", review.asks],
      ["served", review.served],
    ] as const) {
      lines.push(
        `  ${label}: harnesses ${listed(set.harnesses)}; panes ${listed(set.panes)}; events ${listed(set.events)}; reads ${listed(set.reads)}; origins ${listed(set.net)}; host tools ${listed(set.tools)}`,
      );
    }
    if (review.envNames.length > 0)
      lines.push(`  reads these settings: ${review.envNames.join(", ")}`);
  }
  return { lines, exitCode: 0 };
}

export type GrantFlags = {
  readonly harness?: string | boolean;
  readonly allHarnesses?: boolean;
  readonly panes?: string | boolean;
  readonly events?: string | boolean;
  readonly reads?: string | boolean;
  readonly net?: string | boolean;
  readonly tools?: string | boolean;
  readonly expect?: string | boolean;
};

/** The harness ids a `--harness <id|dir>[,…]` value names, by id or by directory. */
function harnessIdsOf(
  items: readonly string[],
  entries: readonly { readonly id: string; readonly dir: string }[],
): { readonly ok: true; readonly ids: string[] } | { readonly ok: false; readonly why: string } {
  const ids: string[] = [];
  for (const item of items) {
    const byId = entries.find((e) => e.id === item);
    const byDir = byId ?? entries.find((e) => realOr(e.dir) === realOr(item));
    if (byDir === undefined) {
      return {
        ok: false,
        why: `no harness ${JSON.stringify(item)} is registered: crewhaus harness list`,
      };
    }
    if (!ids.includes(byDir.id)) ids.push(byDir.id);
  }
  return { ok: true, ids };
}

function outcomeLine(
  name: string,
  outcome: GrantOutcome,
  verb: "granted" | "revoked",
): PluginsGrantResult {
  if (outcome.ok) {
    return {
      lines: [`${verb} ${name} (generation ${outcome.gen})`],
      exitCode: 0,
    };
  }
  if (outcome.code === "stale") {
    return refuse(
      outcome.gen === null
        ? `${name} has no live grant now: run it again without --expect`
        : `${name}'s grant is at generation ${outcome.gen} now: run it again with --expect ${outcome.gen}`,
    );
  }
  if (outcome.code === "no-live-grant") return refuse(`${name} has no live grant to remove`);
  return refuse(`the grant was not written: ${outcome.reason}`);
}

/** `crewhaus plugins grant <name> …`: one workspace receipt and one grant row, or a refusal. */
export async function pluginGrantCommand(
  name: string,
  flags: GrantFlags,
  o: PluginsGrantOptions,
): Promise<PluginsGrantResult> {
  const env = envOf(o);
  const hangarRoot = resolveHangarRoot(env as Record<string, string | undefined>);
  const lists: Record<string, string[]> = {};
  for (const [flag, value] of [
    ["harness", flags.harness],
    ["panes", flags.panes],
    ["events", flags.events],
    ["reads", flags.reads],
    ["net", flags.net],
    ["tools", flags.tools],
  ] as const) {
    const parsed = parseListFlag(flag, value);
    if (!parsed.ok) return refuse(parsed.why);
    lists[flag] = parsed.items;
  }
  if (flags.allHarnesses === true && (lists["harness"] ?? []).length > 0) {
    return refuse("--all-harnesses and --harness name the harnesses twice: give one");
  }
  for (const event of lists["events"] ?? []) {
    if (!(PLUGIN_EVENT_FAMILIES as readonly string[]).includes(event)) {
      return refuse(
        `--events ${JSON.stringify(event)} is not one of ${PLUGIN_EVENT_FAMILIES.join(", ")}`,
      );
    }
  }
  for (const kind of lists["reads"] ?? []) {
    if (!(PLUGIN_READS as readonly string[]).includes(kind)) {
      return refuse(`--reads ${JSON.stringify(kind)} is not one of ${PLUGIN_READS.join(", ")}`);
    }
  }
  let expect: number | undefined;
  if (flags.expect !== undefined) {
    const n = typeof flags.expect === "string" ? Number(flags.expect) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 1) {
      return refuse(`--expect ${JSON.stringify(flags.expect)} is not a generation (1, 2, …)`);
    }
    expect = n;
  }
  const registry = registryOf(env);
  const entries = (registry?.list() ?? []).map((e) => ({ id: e.id, dir: e.dir }));
  const harnesses = harnessIdsOf(lists["harness"] ?? [], entries);
  if (!harnesses.ok) return refuse(harnesses.why);
  const read = inventoryOf(o, hangarRoot);
  if (!read.ok) return refuse(read.why);
  const row: PluginRow | undefined = read.plugins.find((p) => p.name === name);
  if (row === undefined) {
    return refuse(`no plugin "${name}" is installed: crewhaus plugins install ${name}`);
  }
  const grant: PluginGrantInput = {
    harnesses: flags.allHarnesses === true ? "all" : harnesses.ids,
    panes: lists["panes"] ?? [],
    events: lists["events"] ?? [],
    reads: lists["reads"] ?? [],
    net: lists["net"] ?? [],
    tools: lists["tools"] ?? [],
    ...(expect !== undefined ? { expect } : {}),
  };
  const problem = grantProblem(row, grant, new Set(entries.map((e) => e.id)));
  if (problem !== undefined) return refuse(problem);
  const live = liveGrantOf(read.grants, name);
  if (!expectHolds(live, expect)) {
    return outcomeLine(
      name,
      { ok: false, code: "stale", gen: live?.gen ?? null, current: null },
      "granted",
    );
  }
  const control = directControl(o.opts ?? {});
  const answer = await control.commands.submit<GrantOutcome>(
    { kind: "plugins.grant", ledger: "workspace", via: "cli", body: grant },
    async (receipt) => {
      const outcome = await grantPlugin(hangarRoot, {
        row,
        grant,
        by: receipt.actor,
        cmd: receipt.id,
      });
      return { settle: settleOf(outcome), value: outcome };
    },
  );
  if (!answer.ok) return refuse(answer.refusal.message);
  if (answer.replayed) return refuse("this grant was already submitted");
  if (answer.value === undefined) return refuse("the grant did not run");
  const done = outcomeLine(name, answer.value, "granted");
  return done.exitCode === 0
    ? { ...done, lines: [...done.lines, `receipt ${answer.receipt.id}`] }
    : done;
}

function settleOf(outcome: GrantOutcome) {
  if (outcome.ok) return { state: "succeeded" as const };
  if (outcome.code === "io") return { state: "failed" as const, outcome: outcomeOf("unavailable") };
  return {
    state: "rejected" as const,
    outcome: outcomeOf(outcome.code === "stale" ? "precondition_failed" : "conflict"),
  };
}

/** `crewhaus plugins revoke <name>`: one receipt and one row, or a refusal when there is no live grant. */
export async function pluginRevokeCommand(
  name: string,
  o: PluginsGrantOptions,
): Promise<PluginsGrantResult> {
  const env = envOf(o);
  const hangarRoot = resolveHangarRoot(env as Record<string, string | undefined>);
  const read = inventoryOf(o, hangarRoot);
  if (!read.ok) return refuse(read.why);
  if (!read.plugins.some((p) => p.name === name)) {
    return refuse(`no plugin "${name}" is installed: crewhaus plugins install ${name}`);
  }
  if (liveGrantOf(read.grants, name) === undefined) {
    return refuse(`${name} has no live grant to remove`);
  }
  const control = directControl(o.opts ?? {});
  const answer = await control.commands.submit<GrantOutcome>(
    { kind: "plugins.revoke", ledger: "workspace", via: "cli", body: {} },
    async (receipt) => {
      const outcome = await revokePlugin(hangarRoot, {
        plugin: name,
        by: receipt.actor,
        cmd: receipt.id,
      });
      return { settle: settleOf(outcome), value: outcome };
    },
  );
  if (!answer.ok) return refuse(answer.refusal.message);
  if (answer.replayed) return refuse("this revoke was already submitted");
  if (answer.value === undefined) return refuse("the revoke did not run");
  const done = outcomeLine(name, answer.value, "revoked");
  return done.exitCode === 0
    ? { ...done, lines: [...done.lines, `receipt ${answer.receipt.id}`] }
    : done;
}

/** The one entry `runPlugins` calls for `grants`, `grant` and `revoke`. */
export async function runPluginGrants(
  action: "grants" | "grant" | "revoke",
  args: {
    readonly positional: readonly string[];
    readonly flags: Readonly<Record<string, string | boolean | undefined>>;
  },
  pluginsDir: string,
  opts?: DaemonCommandOptions,
): Promise<PluginsGrantResult> {
  const o: PluginsGrantOptions = { pluginsDir, ...(opts !== undefined ? { opts } : {}) };
  const name = args.positional[0];
  if (args.positional.length > 1) {
    return refuse(
      `crewhaus plugins ${action} takes one plugin name, not ${args.positional.length}`,
    );
  }
  if (action === "grants") return pluginGrantsCommand(name, o);
  if (typeof name !== "string") return refuse(`missing <name>: crewhaus plugins ${action} <name>`);
  if (action === "revoke") return await pluginRevokeCommand(name, o);
  const f = args.flags;
  return await pluginGrantCommand(
    name,
    {
      ...(f["harness"] !== undefined ? { harness: f["harness"] } : {}),
      ...(f["all-harnesses"] === true ? { allHarnesses: true } : {}),
      ...(f["panes"] !== undefined ? { panes: f["panes"] } : {}),
      ...(f["events"] !== undefined ? { events: f["events"] } : {}),
      ...(f["reads"] !== undefined ? { reads: f["reads"] } : {}),
      ...(f["net"] !== undefined ? { net: f["net"] } : {}),
      ...(f["tools"] !== undefined ? { tools: f["tools"] } : {}),
      ...(f["expect"] !== undefined ? { expect: f["expect"] } : {}),
    },
    o,
  );
}
