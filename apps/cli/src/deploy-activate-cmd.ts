/**
 * `crewhaus deploy activate` and `crewhaus deploy list`: the deployment records of one
 * harness. A compile prepares a deployment; activating one makes it the build the harness
 * runs, and every automatic start (a crash restart, `manager.autoCompile`) runs only it.
 *
 * Activation is a command: its receipt is written to the harness's own ledger before
 * anything is checked, through the same control service Home uses, and a refused
 * activation gate exits 55 like a refused start.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXIT_FOR_ERROR,
  EXIT_FOR_REJECTED_RECEIPT,
  type ReceiptEffect,
} from "@crewhaus/control-contract";
import { type LedgerRecord, readDeployments } from "@crewhaus/control-records";
import {
  AREA_RUNTIMES,
  type Settlement,
  activateDeployment,
  activationGates,
  currentLocalIdentity,
  ensureHarnessIdentity,
  outcomeOf,
  wireControl,
  withOwnStartTime,
} from "@crewhaus/control-service";
import { openHangarRegistry, resolveHangarRoot } from "@crewhaus/harness-registry";
import { createProcessOps } from "@crewhaus/harness-supervisor";

export type DeployActivateOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly now?: () => number;
};

export type DeployActivateResult = { readonly lines: readonly string[]; readonly exitCode: number };

export const DEPLOY_ACTIVATE_USAGE: readonly string[] = [
  "usage:",
  "  crewhaus deploy activate [<dep>] [--harness <hrn|dir>] [--environment <name>]",
  "       [--no-autostart] [--json]      make a prepared build the one this harness runs",
  "                                      (default: the newest prepared). A protected",
  "                                      --environment needs its approval quorum.",
  "  crewhaus deploy list [--harness <hrn|dir>] [--json]",
  "                                      this harness's deployments, newest first",
];

type Flags = {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
};

const VALUE_FLAGS = new Set(["harness", "environment"]);
const BOOLEAN_FLAGS = new Set(["no-autostart", "json", "help"]);

function parse(argv: readonly string[]): Flags {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`deploy: --${name} needs a value`);
      }
      flags.set(name, value);
      i++;
    } else {
      throw new Error(`deploy: unknown flag --${name}`);
    }
  }
  return { positional, flags };
}

/** The harness a verb acts on: `--harness` (an `hrn_` id or a directory), else the cwd. */
function resolveHarnessDir(
  flag: string | true | undefined,
  options: DeployActivateOptions,
): { readonly dir: string; readonly registryId?: string } {
  const env = options.env ?? process.env;
  let registry: ReturnType<typeof openHangarRegistry> | undefined;
  try {
    registry = openHangarRegistry({ env });
  } catch {
    registry = undefined;
  }
  if (typeof flag === "string" && /^hrn_[0-9a-f]{16}$/.test(flag)) {
    const entry = registry?.get(flag);
    if (entry === undefined) {
      throw new Error(`no registered harness matches "${flag}" — see \`crewhaus harness list\``);
    }
    return { dir: entry.dir, registryId: entry.id };
  }
  const dir = resolve(options.cwd ?? process.cwd(), typeof flag === "string" ? flag : ".");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`deploy: no harness directory at ${dir}`);
  }
  const registryId = registry?.get(dir)?.id;
  return { dir, ...(registryId !== undefined ? { registryId } : {}) };
}

function newestPrepared(records: readonly LedgerRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i] as LedgerRecord;
    if (record["state"] === "prepared") return String(record["id"]);
  }
  return undefined;
}

function rowLine(record: LedgerRecord): string {
  const artifact = (record["artifact"] ?? {}) as { digest?: unknown; entry?: unknown };
  const when = record["activatedAt"] ?? record["preparedAt"] ?? "";
  const environment =
    typeof record["environment"] === "string" ? ` [${record["environment"]}]` : "";
  const digest = typeof artifact.digest === "string" ? artifact.digest.slice(0, 19) : "";
  return `  ${String(record["id"])}  ${String(record["state"]).padEnd(10)}${environment}  ${digest}  ${String(when)}`;
}

/** `crewhaus deploy list`. Reads only. */
export function deployList(
  argv: readonly string[],
  options: DeployActivateOptions = {},
): DeployActivateResult {
  const args = parse(argv);
  if (args.flags.has("help")) return { lines: DEPLOY_ACTIVATE_USAGE, exitCode: 0 };
  const { dir } = resolveHarnessDir(args.flags.get("harness"), options);
  const read = readDeployments(dir);
  if (read.state === "unreadable") {
    return { lines: [`the deployment records can't be read: ${read.reason}`], exitCode: 1 };
  }
  const records = read.state === "present" ? [...read.records].reverse() : [];
  if (args.flags.has("json")) {
    return {
      lines: [
        JSON.stringify(
          {
            harnessDir: dir,
            records,
            active: read.state === "present" ? (read.active?.["id"] ?? null) : null,
            anomalies: read.state === "present" ? read.anomalies : [],
          },
          null,
          2,
        ),
      ],
      exitCode: 0,
    };
  }
  if (records.length === 0) {
    return {
      lines: [
        "No deployments here yet. Compile the harness (crewhaus compile crewhaus.yaml -o dist) to prepare one.",
      ],
      exitCode: 0,
    };
  }
  const lines = [`deployments in ${dir} (newest first):`, ...records.map(rowLine)];
  if (read.state === "present") {
    for (const anomaly of read.anomalies) lines.push(`  ⚠ ${anomaly}`);
  }
  return { lines, exitCode: 0 };
}

/** `crewhaus deploy activate`: a receipted command in the harness's own ledger. */
export async function deployActivate(
  argv: readonly string[],
  options: DeployActivateOptions = {},
): Promise<DeployActivateResult> {
  const args = parse(argv);
  if (args.flags.has("help")) return { lines: DEPLOY_ACTIVATE_USAGE, exitCode: 0 };
  if (args.positional.length > 1) throw new Error("deploy activate: at most one <dep>");
  const { dir, registryId } = resolveHarnessDir(args.flags.get("harness"), options);
  const read = readDeployments(dir);
  if (read.state === "unreadable") {
    return { lines: [`the deployment records can't be read: ${read.reason}`], exitCode: 1 };
  }
  const dep =
    args.positional[0] ?? (read.state === "present" ? newestPrepared(read.records) : undefined);
  if (dep === undefined) {
    return {
      lines: ["Nothing to activate: no prepared build here. Compile the harness first."],
      exitCode: 1,
    };
  }
  const environmentFlag = args.flags.get("environment");
  const environment = typeof environmentFlag === "string" ? environmentFlag : undefined;
  const autostart = !args.flags.has("no-autostart");

  const identity = ensureHarnessIdentity(dir, registryId);
  if (!identity.ok) {
    return { lines: [`harness.json can't be written: ${identity.reason}`], exitCode: 1 };
  }
  const env = options.env ?? process.env;
  const control = wireControl(
    {
      hangarRoot: resolveHangarRoot(env),
      supervisorFor: () => undefined,
      drainRequest: () => async () => undefined,
      identity: currentLocalIdentity(),
      ...(options.now !== undefined ? { now: options.now } : {}),
      probe: withOwnStartTime(createProcessOps()),
    },
    { mode: "direct" },
  );
  try {
    await control.commands.recover({ harness: dir });
  } catch {
    // Recovery is the writer's courtesy to the last crash, never a gate on this verb.
  }
  const target = `${identity.id}/deployment/${dep}`;
  type Outcome = { readonly lines: readonly string[]; readonly json: unknown };
  const answer = await control.commands.submit<Outcome>(
    {
      kind: "deployments.activate",
      target,
      ledger: { harness: dir },
      via: "cli",
      body: { dep, ...(environment !== undefined ? { environment } : {}), autostart },
    },
    async (receipt) => {
      const activated = await activateDeployment({
        harnessDir: dir,
        dep,
        actor: receipt.actor,
        cmd: receipt.id,
        gates: activationGates(AREA_RUNTIMES),
        ...(environment !== undefined ? { environment } : {}),
        autostart,
        ...(registryId !== undefined ? { registryId } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      if (activated.ok) {
        const effects: ReceiptEffect[] = [{ kind: "deployment", status: "done", ref: target }];
        const settle: Settlement = { state: "succeeded", effects };
        return {
          settle,
          value: {
            lines: [
              `activated ${dep}${environment !== undefined ? ` in ${environment}` : ""} — automatic starts run this build`,
              ...activated.superseded.map((id) => `  superseded ${id}`),
            ],
            json: { ok: true, deployment: activated.record, superseded: activated.superseded },
          },
        };
      }
      const code =
        activated.code === "interrupted" || activated.code === "cancelled"
          ? "internal"
          : activated.code;
      return {
        settle: { state: "rejected", outcome: outcomeOf(code) },
        value: {
          lines: [
            `not activated: ${activated.message}`,
            ...(activated.verb !== undefined ? [`  ${activated.verb}`] : []),
          ],
          json: {
            ok: false,
            code: activated.code,
            message: activated.message,
            current: activated.current ?? null,
            verb: activated.verb ?? null,
          },
        },
      };
    },
  );
  if (!answer.ok) {
    return {
      lines: [`not done — ${answer.refusal.message}`],
      exitCode: EXIT_FOR_ERROR[answer.refusal.code],
    };
  }
  const value = answer.replayed ? undefined : answer.value;
  const { id, state } = answer.receipt;
  if (args.flags.has("json")) {
    return {
      lines: [JSON.stringify({ ...((value?.json as object) ?? {}), receipt: id, state }, null, 2)],
      exitCode: state === "succeeded" ? 0 : state === "rejected" ? EXIT_FOR_REJECTED_RECEIPT : 1,
    };
  }
  const lines = value?.lines ?? [];
  if (state === "succeeded") return { lines: [...lines, `Done (${id})`], exitCode: 0 };
  if (state === "rejected") {
    return { lines: [...lines, `Not done (${id})`], exitCode: EXIT_FOR_REJECTED_RECEIPT };
  }
  return { lines: [...lines, `Not done (${id})`], exitCode: 1 };
}
