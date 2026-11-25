/**
 * `crewhaus workspace <verb>`: a harness's workspaces (#516, module brief 333), read from the
 * records its runs write. Reads only: nothing is fetched from a code host, and both verbs
 * work with Home stopped.
 *
 * | Verb | What |
 * |---|---|
 * | `list` | each item's workspace: its branch, and where its pull request is |
 * | `show <wi>` | one workspace: its checks, its publish attempts, its pull request |
 *
 * A check's output, and the acceptance check's reasons, are text a project or a model wrote:
 * control characters are left out before they are printed.
 */
import {
  EXIT_FOR_ERROR,
  type ErrorCode,
  type WorkPrView,
  type WorkPublishView,
  type WorkspaceView,
  isId,
} from "@crewhaus/control-contract";
import { terminalSafe } from "@crewhaus/run-inspect";
import { openWorkStore } from "@crewhaus/tool-work/work-items";
import {
  type BindingsFile,
  readBindings,
  workspaceSummaries,
  workspaceView,
} from "@crewhaus/tool-work/workspace";
import { type DaemonCommandOptions, resolveHarness } from "./daemon-cmd";
import { parseFamilyArgs as parseArgs } from "./family-args";
import type { CliFamily } from "./verbs";

const COMMON = { harness: "value", json: "boolean" } as const;

export const CLI_FAMILY = {
  verb: "workspace",
  since: "0.9.0",
  sub: {
    list: { flags: COMMON },
    show: { flags: COMMON },
  },
} as const satisfies CliFamily;

type Sub = keyof typeof CLI_FAMILY.sub;

export type WorkspaceCmdDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
};

export type WorkspaceOutput = { readonly lines: readonly string[]; readonly exitCode: number };

const USAGE = [
  "usage: crewhaus workspace list [--harness <h>] [--json]",
  "       crewhaus workspace show <wi> [--harness <h>] [--json]",
  "  The isolated checkouts a harness makes its changes in, and the pull requests they became.",
  "  <h> is a harness id or its directory; without it, the current directory.",
];

class Refused extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
  ) {
    super(message);
  }
}

/** The bindings the harness's last boot wrote; unreadable reads as none. */
function bindingsOf(dir: string): BindingsFile | undefined {
  try {
    return readBindings(dir);
  } catch {
    return undefined;
  }
}

/** A pull request in words. */
export function pullWords(pull: WorkPrView): string {
  const named = `pull request #${pull.pr}`;
  switch (pull.state) {
    case "merged":
      return `${named} merged${pull.changed === true ? " with changes by a maintainer" : ""}`;
    case "closed":
      return `${named} closed without merging`;
    case "reverted":
      return `${named} reverted`;
    default:
      return pull.review === "changes-requested"
        ? `${named} has changes requested`
        : pull.review === "approved"
          ? `${named} approved, in review`
          : `${named} in review`;
  }
}

const many = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** A publish attempt in words. */
export function attemptWords(attempt: WorkPublishView): string {
  const size =
    attempt.files !== undefined
      ? ` (${many(attempt.files, "file")}, ${many(attempt.lines ?? 0, "line")})`
      : "";
  switch (attempt.state) {
    case "done":
      return `published as pull request #${attempt.pr ?? "?"}${size}`;
    case "failed":
      return `not published${attempt.code !== undefined ? `: ${attempt.code}` : ""}${size}`;
    case "unknown":
      return "not confirmed by the code host yet";
    case "not-done":
      return "did not reach the code host";
    default:
      return "being published";
  }
}

function verdictWords(attempt: WorkPublishView | undefined): string | undefined {
  const v = attempt?.verdict;
  return v === undefined ? undefined : `checks ${v.checks}, acceptance ${v.acceptance}`;
}

const indented = (text: string): string[] =>
  text
    .trimEnd()
    .split("\n")
    .map((l) => `    ${l}`);

function showLines(view: WorkspaceView): string[] {
  const out = [
    `${view.work}  ${view.state}  ${view.binding}`,
    `  branch ${view.branch}`,
    ...(view.baseSha !== undefined ? [`  from ${view.baseSha}`] : []),
    ...(view.headSha !== undefined ? [`  at ${view.headSha}`] : []),
    ...(view.wip === true ? ["  uncommitted work was kept as a commit on the branch"] : []),
    ...(view.outcome !== undefined ? [`  ${pullWords(view.outcome)}`] : []),
  ];
  if (view.checks !== undefined) {
    out.push("  Checks:");
    for (const c of view.checks) {
      out.push(`    ${c.passed ? "passed" : `failed (exit ${c.exit})`}  ${c.name}`);
    }
  }
  const verdict = verdictWords(view.attempts.at(-1));
  if (verdict !== undefined) out.push(`  Last verdict: ${verdict}`);
  if (view.reasons !== undefined) out.push("  Why:", ...indented(view.reasons));
  if (view.attempts.length > 0) {
    out.push("  Attempts:");
    for (const a of view.attempts) out.push(`    ${a.at}  ${attemptWords(a)}`);
  }
  for (const log of view.logs ?? []) out.push(`  Log of ${log.name}:`, ...indented(log.text));
  return out;
}

export async function runWorkspaceCommand(
  argv: readonly string[],
  deps: WorkspaceCmdDeps = {},
): Promise<WorkspaceOutput> {
  const sub = argv[0];
  if (sub === undefined || sub === "--help" || sub === "-h") return { lines: USAGE, exitCode: 0 };
  if (!Object.hasOwn(CLI_FAMILY.sub, sub)) {
    throw new Error(
      `unknown workspace verb "${sub}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
    );
  }
  if (argv.includes("--help") || argv.includes("-h")) return { lines: USAGE, exitCode: 0 };
  try {
    return runVerb(sub as Sub, argv.slice(1), deps);
  } catch (err) {
    if (err instanceof Refused) {
      return { lines: [terminalSafe(err.message)], exitCode: EXIT_FOR_ERROR[err.code] ?? 1 };
    }
    throw err;
  }
}

function runVerb(verb: Sub, rest: readonly string[], deps: WorkspaceCmdDeps): WorkspaceOutput {
  const label = `workspace ${verb}`;
  const args = parseArgs(label, rest, CLI_FAMILY.sub[verb].flags);
  const json = args.booleans.has("json");
  const opts: DaemonCommandOptions = {
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
  };
  const { dir } = resolveHarness(args.values.get("harness")?.[0], opts);
  const bindings = bindingsOf(dir);

  if (verb === "list") {
    if (args.positional.length > 0) {
      throw new Refused("workspace list: unexpected argument", "invalid");
    }
    const items = workspaceSummaries(dir, bindings !== undefined ? { bindings } : {});
    if (json) return { lines: [JSON.stringify({ items }, null, 2)], exitCode: 0 };
    if (items.length === 0) {
      return {
        lines: [
          bindings === undefined
            ? "This harness delivers no work to a repository. Declare one under repositories in its crewhaus.yaml."
            : "No workspace yet. A run opens one when it starts on an accepted item.",
        ],
        exitCode: 0,
      };
    }
    return {
      lines: items.map((w) =>
        terminalSafe(
          [
            w.work,
            w.state.padEnd(6),
            w.binding,
            w.branch,
            w.outcome !== undefined
              ? pullWords(w.outcome)
              : w.publish === "unknown"
                ? "publish not confirmed yet"
                : "not published",
          ].join("  "),
        ),
      ),
      exitCode: 0,
    };
  }

  const wi = args.positional[0];
  if (wi === undefined || !isId("wi", wi)) {
    throw new Refused("workspace show: name a work item, wi_ and 26 characters", "invalid");
  }
  if (args.positional.length > 1)
    throw new Refused("workspace show: unexpected argument", "invalid");
  const view = workspaceView(dir, wi, {
    content: true,
    ...(bindings !== undefined ? { bindings } : {}),
  });
  if (view === undefined) {
    const known = openWorkStore(dir).get(wi);
    throw new Refused(
      "ok" in known
        ? `workspace show: no work item ${wi} in ${dir}`
        : `workspace show: ${wi} has no workspace yet. A run opens one when it starts on the item.`,
      "not_found",
    );
  }
  if (json) return { lines: [JSON.stringify({ workspace: view }, null, 2)], exitCode: 0 };
  return { lines: showLines(view).map(terminalSafe), exitCode: 0 };
}
