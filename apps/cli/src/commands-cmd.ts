/**
 * `crewhaus commands list|show`: the receipts every change is recorded under, read from a
 * harness's command ledger (or Home's, for a change to Home itself). Reads only.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type CommandReceipt, EXIT_FOR_ERROR, isId } from "@crewhaus/control-contract";
import type { ControlService } from "@crewhaus/control-service";
import { HARNESS_ID_RE, openHangarRegistry, slugOf } from "@crewhaus/harness-registry";
import { directControl } from "./daemon-cmd";
import { parseFamilyArgs as parseArgs } from "./family-args";
import type { CliFamily } from "./verbs";

export const CLI_FAMILY = {
  verb: "commands",
  since: "0.9.0",
  sub: {
    list: { flags: { harness: "value", limit: "value", json: "boolean" } },
    show: { flags: { harness: "value", json: "boolean" } },
  },
} as const satisfies CliFamily;

export type CommandsDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** The control service; the CLI's direct one by default, opened only when needed. */
  readonly control?: () => ControlService;
};

const USAGE = [
  "usage: crewhaus commands list --harness <h> [--limit n] [--json]",
  "       crewhaus commands show <cmd_> [--harness <h>] [--json]",
  "  The receipts every change is recorded under, newest first. <h> is a harness id,",
  "  its name, or its directory.",
];

function flagsOf(sub: "list" | "show", argv: readonly string[]) {
  const label = `commands ${sub}`;
  const args = parseArgs(label, argv, CLI_FAMILY.sub[sub].flags);
  const values: Record<string, string> = {};
  for (const [name, list] of args.values) values[name] = list[0] as string;
  return { positional: args.positional, values, json: args.booleans.has("json") };
}

/** A harness by its id, its slug, or its directory. */
function harnessDirOf(deps: CommandsDeps, raw: string): string | undefined {
  const env = { ...(deps.env ?? process.env), CREWHAUS_NO_REGISTRY: "1" };
  let entries: { id: string; dir: string; specName: string; slug?: string }[] = [];
  try {
    entries = openHangarRegistry({ env }).list() as typeof entries;
  } catch {
    entries = [];
  }
  if (HARNESS_ID_RE.test(raw)) return entries.find((e) => e.id === raw)?.dir;
  const bySlug = entries.find((e) => (e.slug ?? slugOf(e.specName)) === raw);
  if (bySlug !== undefined) return bySlug.dir;
  const dir = isAbsolute(raw) ? raw : resolve(deps.cwd ?? process.cwd(), raw);
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined;
}

function line(receipt: CommandReceipt): string {
  return `${receipt.id}  ${receipt.state.padEnd(9)}  ${receipt.kind}  ${receipt.acceptedAt}`;
}

export async function runCommandsCommand(
  argv: readonly string[],
  deps: CommandsDeps = {},
): Promise<{ readonly lines: readonly string[]; readonly exitCode: number }> {
  const sub = argv[0];
  if (
    sub === undefined ||
    sub === "--help" ||
    sub === "-h" ||
    argv.includes("--help") ||
    argv.includes("-h")
  ) {
    return { lines: USAGE, exitCode: 0 };
  }
  if (sub !== "list" && sub !== "show") {
    throw new Error(
      `unknown commands verb "${sub}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
    );
  }
  const args = flagsOf(sub, argv.slice(1));
  const harness = args.values["harness"];
  const dir = harness === undefined ? undefined : harnessDirOf(deps, harness);
  if (harness !== undefined && dir === undefined) {
    return {
      lines: [`commands ${sub}: no harness "${harness}". Run \`crewhaus harness list\`.`],
      exitCode: EXIT_FOR_ERROR.not_found,
    };
  }
  const control =
    deps.control?.() ?? directControl({ ...(deps.env !== undefined ? { env: deps.env } : {}) });
  if (sub === "list") {
    if (dir === undefined) {
      return {
        lines: ["commands list: name the harness with --harness <h>"],
        exitCode: EXIT_FOR_ERROR.invalid,
      };
    }
    const limit = args.values["limit"] === undefined ? 50 : Number(args.values["limit"]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return {
        lines: ["commands list: --limit is a whole number from 1 to 500"],
        exitCode: EXIT_FOR_ERROR.invalid,
      };
    }
    const page = control.commands.list({ harness: dir }, { limit });
    if (args.json) return { lines: [JSON.stringify(page.items, null, 2)], exitCode: 0 };
    if (page.items.length === 0)
      return { lines: ["Nothing has been asked of this harness yet."], exitCode: 0 };
    return {
      lines: [
        ...page.items.map(line),
        ...(page.next !== undefined ? [`(the newest ${limit}; pass --limit for more)`] : []),
      ],
      exitCode: 0,
    };
  }
  const id = args.positional[0];
  if (id === undefined || !isId("cmd", id)) {
    return { lines: ["commands show: name a command, cmd_…"], exitCode: EXIT_FOR_ERROR.invalid };
  }
  const receipt =
    (dir !== undefined ? control.commands.get({ harness: dir }, id) : undefined) ??
    control.commands.get("workspace", id);
  if (receipt === undefined) {
    return {
      lines: [
        `commands show: no command ${id}${dir === undefined ? " in Home's own record; pass --harness <h>" : " here"}`,
      ],
      exitCode: EXIT_FOR_ERROR.not_found,
    };
  }
  return {
    lines: args.json
      ? [JSON.stringify(receipt, null, 2)]
      : [line(receipt), `  target ${receipt.target}`, `  via ${receipt.via}`],
    exitCode: 0,
  };
}
