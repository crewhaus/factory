/**
 * `crewhaus hangar install|uninstall`: Home as an opt-in service that starts when you sign
 * in and keeps running with no window open, so its tick (attaching daemons, settling
 * commands, approver lists, notifications) and reboot recovery run without a browser.
 *
 * | System | File | Loaded with |
 * |---|---|---|
 * | macOS | `~/Library/LaunchAgents/ai.crewhaus.hangar.plist` (`RunAtLoad`, `KeepAlive {SuccessfulExit: false}`) | `launchctl bootstrap gui/<uid>` |
 * | Linux | `~/.config/systemd/user/crewhaus-hangar.service` (`Restart=on-failure`) | `systemctl --user enable --now` |
 * | Windows | — | refused: not available yet |
 *
 * The unit runs `<program> hangar serve --resident`, where the program is the chvm shim
 * (`${CHVM_DIR:-~/.chvm}/shims/crewhaus`) when it is there, else the `crewhaus` your PATH
 * finds, so switching versions never leaves the unit pointing at an old binary. Its output
 * goes to `<hangarRoot>/service/resident.log`. Install shows exactly the file it writes
 * and the commands it runs, then asks (`--yes` for scripts; with no terminal and no
 * `--yes` it writes nothing). A unit file it did not write (no marker line) is never
 * overwritten or removed. Uninstall stops the unit, removes only the file it wrote and
 * leaves every other file. Both are recorded as a receipt in Home's ledger.
 *
 * Side-effect free on import: the platform, home directory, user, environment, PATH
 * lookup, command runner, output and confirmation are all injected, and every command
 * line comes from a closed vocabulary, never from what a person typed.
 */
import { constants, accessSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT_FOR_ERROR } from "@crewhaus/control-contract";

/** The first line of every unit file this verb writes, after any XML header. */
export const PLIST_MARKER = "<!-- written by crewhaus hangar install -->";
export const UNIT_MARKER = "# written by crewhaus hangar install";

export const LAUNCHD_LABEL = "ai.crewhaus.hangar";
export const SYSTEMD_UNIT = "crewhaus-hangar.service";

export const WINDOWS_REFUSAL =
  "The always-on service isn't available on Windows yet. Run `crewhaus hangar` and keep it open.";

export type RunAnswer = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** What a receipt port answers: the receipt's id, or why none was written. */
export type ReceiptAnswer =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly message: string };

export type ServiceDeps = {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly uid: number;
  /** The OS user, for the linger hint. */
  readonly username: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Home's directory: the log lands under it. */
  readonly hangarRoot: string;
  /** The `crewhaus` the PATH resolves, as found (not resolved through links). */
  readonly which: (name: string) => string | undefined;
  readonly isExecutable?: (path: string) => boolean;
  readonly runner: (argv: readonly string[]) => RunAnswer | Promise<RunAnswer>;
  readonly write: (line: string) => void;
  readonly isTty: boolean;
  readonly confirm: (question: string) => Promise<boolean>;
  /**
   * Record the install or uninstall as a receipt in Home's ledger, around the work:
   * `effect` runs after the receipt is written and says how it ended.
   */
  readonly receipt: (
    kind: "legacy.hangarInstall" | "legacy.hangarUninstall",
    effect: () => Promise<boolean>,
  ) => Promise<ReceiptAnswer>;
};

export type ServiceResult = { readonly lines: readonly string[]; readonly exitCode: number };

export type ServicePlan = {
  readonly unitPath: string;
  readonly content: string;
  /** The program the unit runs, and where it came from. */
  readonly program: string;
  readonly programFrom: "chvm" | "path";
  /** The commands install runs, in order, from a closed vocabulary. */
  readonly commands: readonly (readonly string[])[];
  /** Lines said after the install. */
  readonly after: readonly string[];
};

const defaultIsExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Where the unit file lives on this system, or `undefined` where there is none. */
export function unitPathFor(platform: NodeJS.Platform, homedir: string): string | undefined {
  if (platform === "darwin")
    return join(homedir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (platform === "linux") return join(homedir, ".config", "systemd", "user", SYSTEMD_UNIT);
  return undefined;
}

/** The program the unit runs: the chvm shim, else PATH's `crewhaus`, else none. */
export function serviceProgram(
  deps: Pick<ServiceDeps, "env" | "homedir" | "which" | "isExecutable">,
): { readonly program: string; readonly from: "chvm" | "path" } | undefined {
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const chvmDir = deps.env["CHVM_DIR"] ?? join(deps.homedir, ".chvm");
  const shim = join(chvmDir, "shims", "crewhaus");
  if (existsSync(shim) && isExecutable(shim)) return { program: shim, from: "chvm" };
  const found = deps.which("crewhaus");
  return found !== undefined && found !== "" ? { program: found, from: "path" } : undefined;
}

/** The environment the unit carries: PATH as it is now, and Home's own two names when set. */
function unitEnv(env: Readonly<Record<string, string | undefined>>): Array<[string, string]> {
  const out: Array<[string, string]> = [["PATH", env["PATH"] ?? "/usr/bin:/bin"]];
  for (const name of ["CREWHAUS_HANGAR_ROOT", "CHVM_DIR"]) {
    const value = env[name];
    if (value !== undefined && value !== "") out.push([name, value]);
  }
  return out;
}

const xml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The launchd property list, every value escaped. */
export function plistContent(
  program: string,
  logPath: string,
  env: Array<[string, string]>,
): string {
  const args = [program, "hangar", "serve", "--resident"]
    .map((arg) => `    <string>${xml(arg)}</string>`)
    .join("\n");
  const vars = env
    .map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    PLIST_MARKER,
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(logPath)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    vars,
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** A value inside a systemd double-quoted word: backslash, quote and `%` escaped. */
const quoted = (text: string): string =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

/** The systemd user unit, every value quoted. */
export function systemdContent(
  program: string,
  logPath: string,
  env: Array<[string, string]>,
): string {
  return [
    UNIT_MARKER,
    "[Unit]",
    "Description=CrewHaus Home",
    "",
    "[Service]",
    `ExecStart=${quoted(program)} hangar serve --resident`,
    "Restart=on-failure",
    ...env.map(([name, value]) => `Environment=${quoted(`${name}=${value}`)}`),
    `StandardOutput=append:${logPath.replaceAll("%", "%%")}`,
    `StandardError=append:${logPath.replaceAll("%", "%%")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Whether a unit file carries the marker line this verb writes. */
export function carriesMarker(platform: NodeJS.Platform, text: string): boolean {
  const lines = text.split("\n");
  return platform === "darwin"
    ? lines[0]?.startsWith("<?xml") === true && lines[1] === PLIST_MARKER
    : lines[0] === UNIT_MARKER;
}

/** What install would write and run, or the refusal. Reads only. */
export function planInstall(
  deps: Pick<
    ServiceDeps,
    "platform" | "homedir" | "uid" | "username" | "env" | "hangarRoot" | "which" | "isExecutable"
  >,
):
  | { readonly ok: true; readonly plan: ServicePlan }
  | { readonly ok: false; readonly result: ServiceResult } {
  const unitPath = unitPathFor(deps.platform, deps.homedir);
  if (unitPath === undefined) {
    return {
      ok: false,
      result: { lines: [WINDOWS_REFUSAL], exitCode: EXIT_FOR_ERROR.unsupported },
    };
  }
  const found = serviceProgram(deps);
  if (found === undefined) {
    return {
      ok: false,
      result: {
        lines: [
          "No `crewhaus` to run the service with: install it with chvm (`npm i -g @crewhaus/chvm`, then `chvm install`), then run this again.",
        ],
        exitCode: EXIT_FOR_ERROR.unsupported,
      },
    };
  }
  const logPath = join(deps.hangarRoot, "service", "resident.log");
  const env = unitEnv(deps.env);
  if (deps.platform === "darwin") {
    return {
      ok: true,
      plan: {
        unitPath,
        content: plistContent(found.program, logPath, env),
        program: found.program,
        programFrom: found.from,
        commands: [["launchctl", "bootstrap", `gui/${deps.uid}`, unitPath]],
        after: [],
      },
    };
  }
  return {
    ok: true,
    plan: {
      unitPath,
      content: systemdContent(found.program, logPath, env),
      program: found.program,
      programFrom: found.from,
      commands: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT],
      ],
      after: [
        `On a computer nobody signs in to, run \`loginctl enable-linger ${deps.username}\` so Home starts at boot.`,
      ],
    },
  };
}

/** Whether the service is installed: a unit file carrying the marker. */
export function residentState(deps: Pick<ServiceDeps, "platform" | "homedir">): {
  readonly state: "absent" | "installed";
  readonly unitPath: string | undefined;
} {
  const unitPath = unitPathFor(deps.platform, deps.homedir);
  if (unitPath === undefined) return { state: "absent", unitPath };
  try {
    return carriesMarker(deps.platform, readFileSync(unitPath, "utf8"))
      ? { state: "installed", unitPath }
      : { state: "absent", unitPath };
  } catch {
    return { state: "absent", unitPath };
  }
}

/** Ask, or refuse when nobody can answer: `undefined` means go on. */
async function askFirst(
  deps: Pick<ServiceDeps, "isTty" | "confirm">,
  yes: boolean,
  question: string,
  lines: string[],
): Promise<ServiceResult | undefined> {
  if (yes) return undefined;
  if (!deps.isTty) {
    lines.push("Nothing was changed: there is no terminal to ask. Run it again with --yes.");
    return { lines, exitCode: EXIT_FOR_ERROR.invalid };
  }
  if (await deps.confirm(question)) return undefined;
  lines.push("Nothing was changed.");
  return { lines, exitCode: 0 };
}

const commandLine = (argv: readonly string[]): string => argv.join(" ");

/** `crewhaus hangar install [--yes]`. */
export async function install(
  deps: ServiceDeps,
  options: { readonly yes: boolean },
): Promise<ServiceResult> {
  const planned = planInstall(deps);
  if (!planned.ok) return planned.result;
  const { plan } = planned;
  const lines: string[] = [];
  let existing: string | undefined;
  try {
    existing = readFileSync(plan.unitPath, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== undefined && !carriesMarker(deps.platform, existing)) {
    return {
      lines: [
        `${plan.unitPath} is already there and was not written by \`crewhaus hangar install\`. Move it aside, then run this again.`,
      ],
      exitCode: EXIT_FOR_ERROR.conflict,
    };
  }
  // macOS keeps a loaded agent loaded: a reinstall unloads the one this verb wrote first.
  const commands: (readonly string[])[] =
    existing !== undefined && deps.platform === "darwin"
      ? [["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`], ...plan.commands]
      : [...plan.commands];
  lines.push(
    `This writes ${plan.unitPath}, which runs ${plan.program} (${plan.programFrom === "chvm" ? "the chvm shim, so a version switch keeps working" : "the crewhaus your PATH finds"}):`,
    "",
    ...plan.content
      .trimEnd()
      .split("\n")
      .map((line) => `  ${line}`),
    "",
    "Then it runs:",
    ...commands.map((argv) => `  ${commandLine(argv)}`),
  );
  for (const line of lines) deps.write(line);
  lines.length = 0;
  const refused = await askFirst(deps, options.yes, "Install the service?", lines);
  if (refused !== undefined) return refused;

  const reload = existing !== undefined && deps.platform === "darwin";
  const ran: string[] = [];
  const answer = await deps.receipt("legacy.hangarInstall", async () => {
    try {
      mkdirSync(dirname(plan.unitPath), { recursive: true });
      mkdirSync(join(deps.hangarRoot, "service"), { recursive: true, mode: 0o700 });
      writeFileSync(plan.unitPath, plan.content, { mode: 0o644 });
    } catch (err) {
      ran.push(
        `Could not write ${plan.unitPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    for (const [index, argv] of commands.entries()) {
      const result = await deps.runner(argv);
      // Unloading an agent that was not loaded is not a failure of the reinstall.
      if (result.code !== 0 && !(reload && index === 0)) {
        ran.push(
          `\`${commandLine(argv)}\` exited ${result.code}${result.stderr.trim() !== "" ? `: ${result.stderr.trim().split("\n")[0]}` : ""}`,
        );
        return false;
      }
    }
    return true;
  });
  lines.push(...ran);
  if (!answer.ok) {
    lines.push(`Nothing was installed: ${answer.message}`);
    return { lines, exitCode: 1 };
  }
  if (ran.length > 0) {
    lines.push(`The service is not running. Recorded as ${answer.id}.`);
    return { lines, exitCode: 1 };
  }
  lines.push(
    "Installed: Home now starts when you sign in and keeps running with no window open.",
    ...plan.after,
    `Recorded as ${answer.id}. Remove it with \`crewhaus hangar uninstall\`.`,
  );
  return { lines, exitCode: 0 };
}

/** `crewhaus hangar uninstall [--yes]`. */
export async function uninstall(
  deps: ServiceDeps,
  options: { readonly yes: boolean },
): Promise<ServiceResult> {
  const unitPath = unitPathFor(deps.platform, deps.homedir);
  if (unitPath === undefined)
    return { lines: [WINDOWS_REFUSAL], exitCode: EXIT_FOR_ERROR.unsupported };
  let existing: string | undefined;
  try {
    existing = readFileSync(unitPath, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing === undefined) {
    return { lines: ["The service isn't installed: nothing to remove."], exitCode: 0 };
  }
  if (!carriesMarker(deps.platform, existing)) {
    return {
      lines: [
        `${unitPath} was not written by \`crewhaus hangar install\`, so it is left as it is.`,
      ],
      exitCode: EXIT_FOR_ERROR.conflict,
    };
  }
  const stop: readonly string[] =
    deps.platform === "darwin"
      ? ["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]
      : ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT];
  const after: (readonly string[])[] =
    deps.platform === "darwin" ? [] : [["systemctl", "--user", "daemon-reload"]];
  const lines = [
    `This stops the service, removes ${unitPath} and leaves every other file. It runs:`,
    `  ${commandLine(stop)}`,
    ...after.map((argv) => `  ${commandLine(argv)}`),
  ];
  for (const line of lines) deps.write(line);
  lines.length = 0;
  const refused = await askFirst(deps, options.yes, "Remove the service?", lines);
  if (refused !== undefined) return refused;
  const notes: string[] = [];
  const answer = await deps.receipt("legacy.hangarUninstall", async () => {
    const stopped = await deps.runner(stop);
    // A unit that was not loaded has nothing to stop; the file still goes.
    if (stopped.code !== 0)
      notes.push(`\`${commandLine(stop)}\` exited ${stopped.code}; it was not running.`);
    try {
      rmSync(unitPath);
    } catch (err) {
      notes.push(
        `Could not remove ${unitPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    for (const argv of after) {
      const result = await deps.runner(argv);
      if (result.code !== 0) notes.push(`\`${commandLine(argv)}\` exited ${result.code}.`);
    }
    return true;
  });
  lines.push(...notes);
  if (!answer.ok) {
    lines.push(`Nothing was removed: ${answer.message}`);
    return { lines, exitCode: 1 };
  }
  if (existsSync(unitPath)) {
    lines.push(`The service is still installed. Recorded as ${answer.id}.`);
    return { lines, exitCode: 1 };
  }
  lines.push(
    "Removed: Home runs only while `crewhaus hangar` is open. Your data is where it was.",
    `Recorded as ${answer.id}.`,
  );
  return { lines, exitCode: 0 };
}

/**
 * The last boot's recovery report, read tolerantly for `hangar status`: a missing,
 * unreadable or unknown-version file is "no recovery report yet", never an error.
 */
export function readLastRecovery(hangarRoot: string):
  | {
      readonly at: string;
      readonly mode: string;
      readonly restarted: number;
      readonly skipped: number;
      readonly failed: number;
    }
  | undefined {
  try {
    const body = JSON.parse(
      readFileSync(join(hangarRoot, "service", "recovery.json"), "utf8"),
    ) as Record<string, unknown>;
    if (body["v"] !== 1 || typeof body["at"] !== "string") return undefined;
    const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
    return {
      at: body["at"],
      mode: typeof body["mode"] === "string" ? body["mode"] : "foreground",
      restarted: count(body["restarted"]),
      skipped: count(body["skipped"]),
      failed: count(body["failed"]),
    };
  } catch {
    return undefined;
  }
}
