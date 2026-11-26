/**
 * Which repositories this harness delivers to, from the active build. The boot registrar
 * ({@link bindWorkspaceRepositories}) keeps the bundle's `repositories` block in module
 * state, so a worktree's own `crewhaus.yaml` is never read, and writes two things at boot:
 *
 * - `.crewhaus/workspaces/<binding>/` (0700) for each binding, before any run starts, so a
 *   run's protected roots already name the git directory a clone made later in that run
 *   will use;
 * - `.crewhaus/run/control/work/bindings.json` (0600), the one place Home reads a binding
 *   from: the resolved settings, and the NAME of the variable that holds the token. Never
 *   a token, and never the declared intent.
 *
 * The declared intent stays in this module's state for the acceptance check alone. Nothing
 * here exports it but {@link acceptanceIntent}, which the tools hand to the judge.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { ensureDirContained, openForReadSync, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { workDirOf } from "../work-items/index";

/** One repository binding, as the compiler resolved it. */
export type RepositoryBinding = {
  readonly name: string;
  readonly host: "github";
  readonly repo: string;
  readonly base: string;
  readonly branchPrefix: string;
  readonly checks: readonly (readonly string[])[];
  readonly checkTimeoutMs: number;
  readonly checkImage?: string;
  readonly pullRequests: {
    readonly draft: boolean;
    readonly maxFiles: number;
    readonly maxLines: number;
    readonly revalidate: "rebase" | "refresh";
    readonly require: readonly ("checks" | "acceptance")[];
  };
  readonly server: { readonly api: string; readonly git: string };
  readonly allowPrivateTarget?: true;
};

/** What the harness is for, in its owner's words: the acceptance judge's input only. */
export type DeclaredIntent = {
  readonly purpose: string;
  readonly serves?: readonly string[];
  readonly outcomes?: readonly string[];
  readonly excludes?: readonly string[];
};

/** The model the acceptance check judges with. */
export type AcceptanceJudgeConfig = { readonly model: string; readonly params?: unknown };

/** What Home and the engine read: no token, no intent, no judge. */
export type BindingsFile = {
  readonly v: 1;
  readonly repositories: readonly RepositoryBinding[];
  readonly tokenEnv?: string;
};

export type WorkspaceConfig = BindingsFile & {
  readonly intent?: DeclaredIntent;
  readonly judge?: AcceptanceJudgeConfig;
};

/** A `repositories` block this package cannot take, or a harness directory it cannot run in. */
export class WorkspaceConfigError extends Error {
  override readonly name = "WorkspaceConfigError";
}

const BINDING_RE = /^[a-z][a-z0-9-]{0,39}$/;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const PREFIX_RE = /^[a-z0-9][a-z0-9/-]{0,30}\/$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BINDINGS_MAX_BYTES = 256 * 1024;

/** The workspaces directory, relative to the harness. */
export const WORKSPACES_DIR = join(".crewhaus", "workspaces");

/** `.crewhaus/workspaces/<binding>`, relative to the harness. */
export function bindingDirOf(binding: string): string {
  if (!BINDING_RE.test(binding)) throw new WorkspaceConfigError("a binding is a-z, 0-9 and -");
  return join(WORKSPACES_DIR, binding);
}

/** `.crewhaus/run/control/work/bindings.json`, relative to the harness. */
export function bindingsFileOf(harnessDir: string): string {
  return join(workDirOf(harnessDir), "bindings.json");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(at: string, why: string): never {
  throw new WorkspaceConfigError(`repositories.${at}: ${why}`);
}

function parseBinding(raw: unknown): RepositoryBinding {
  if (!isRecord(raw) || typeof raw["name"] !== "string" || !BINDING_RE.test(raw["name"])) {
    throw new WorkspaceConfigError("repositories holds a binding with no usable name");
  }
  const name = raw["name"];
  const { repo, base, branchPrefix, checks, checkTimeoutMs, checkImage, server } = raw;
  if (raw["host"] !== "github") bad(name, "host is github");
  if (typeof repo !== "string" || !REPO_RE.test(repo)) bad(name, "repo is owner/name");
  if (typeof base !== "string" || !isBranch(base)) bad(name, "base is a branch name");
  if (typeof branchPrefix !== "string" || !PREFIX_RE.test(branchPrefix)) {
    bad(name, "branch_prefix ends in /");
  }
  if (
    !Array.isArray(checks) ||
    checks.some(
      (argv) =>
        !Array.isArray(argv) ||
        argv.length === 0 ||
        argv.some((w) => typeof w !== "string" || w === "" || /[\0\n\r]/.test(w)),
    )
  ) {
    bad(name, "checks is a list of argv lists");
  }
  if (!Number.isSafeInteger(checkTimeoutMs) || (checkTimeoutMs as number) <= 0) {
    bad(name, "check_timeout is a duration");
  }
  if (checkImage !== undefined && typeof checkImage !== "string") {
    bad(name, "check_image is a container image");
  }
  const pr = raw["pullRequests"];
  if (
    !isRecord(pr) ||
    typeof pr["draft"] !== "boolean" ||
    !Number.isSafeInteger(pr["maxFiles"]) ||
    !Number.isSafeInteger(pr["maxLines"]) ||
    (pr["revalidate"] !== "rebase" && pr["revalidate"] !== "refresh") ||
    !Array.isArray(pr["require"]) ||
    pr["require"].length === 0 ||
    pr["require"].some((r) => r !== "checks" && r !== "acceptance")
  ) {
    bad(name, "pull_requests is not complete");
  }
  if (!isRecord(server) || typeof server["api"] !== "string" || typeof server["git"] !== "string") {
    bad(name, "server names its api and git origins");
  }
  const s = server as { api: string; git: string };
  const p = pr as unknown as RepositoryBinding["pullRequests"];
  return {
    name,
    host: "github",
    repo: repo as string,
    base: base as string,
    branchPrefix: branchPrefix as string,
    checks: (checks as string[][]).map((argv) => [...argv]),
    checkTimeoutMs: checkTimeoutMs as number,
    ...(checkImage !== undefined ? { checkImage: checkImage as string } : {}),
    pullRequests: {
      draft: p.draft,
      maxFiles: p.maxFiles,
      maxLines: p.maxLines,
      revalidate: p.revalidate,
      require: [...p.require],
    },
    server: { api: s.api, git: s.git },
    ...(raw["allowPrivateTarget"] === true ? { allowPrivateTarget: true as const } : {}),
  };
}

/** A branch name git accepts and no tool reads as an option. */
export function isBranch(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

function lines(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return undefined;
  return value as string[];
}

function parseIntent(raw: unknown): DeclaredIntent | undefined {
  if (!isRecord(raw) || typeof raw["purpose"] !== "string") return undefined;
  const serves = lines(raw["serves"]);
  const outcomes = lines(raw["outcomes"]);
  const excludes = lines(raw["excludes"]);
  return {
    purpose: raw["purpose"],
    ...(serves !== undefined ? { serves } : {}),
    ...(outcomes !== undefined ? { outcomes } : {}),
    ...(excludes !== undefined ? { excludes } : {}),
  };
}

/** Check a registrar config. Throws {@link WorkspaceConfigError} naming the binding. */
export function parseWorkspaceConfig(raw: unknown): WorkspaceConfig {
  if (!isRecord(raw) || !Array.isArray(raw["repositories"])) {
    throw new WorkspaceConfigError("repositories is a list of bindings");
  }
  const repositories = raw["repositories"].map(parseBinding);
  const names = repositories.map((r) => r.name);
  if (new Set(names).size !== names.length) {
    throw new WorkspaceConfigError("repositories names each binding once");
  }
  const tokenEnv = raw["tokenEnv"];
  const judge = raw["judge"];
  const intent = parseIntent(raw["intent"]);
  return {
    v: 1,
    repositories,
    ...(typeof tokenEnv === "string" && ENV_NAME_RE.test(tokenEnv) ? { tokenEnv } : {}),
    ...(intent !== undefined ? { intent } : {}),
    ...(isRecord(judge) && typeof judge["model"] === "string"
      ? {
          judge: {
            model: judge["model"],
            ...(judge["params"] !== undefined ? { params: judge["params"] } : {}),
          },
        }
      : {}),
  };
}

/**
 * Refuse to work when the process's directory is inside a workspace: the harness directory
 * is where the runtime reads its settings, its floor and its records from, and a steward's
 * run never moves into the clone it edits. Checked at boot and at the start of every
 * workspace tool call and engine entry.
 */
export function assertHarnessCwd(harnessDir: string): void {
  let cwd: string;
  let root: string;
  try {
    cwd = realpathSync(process.cwd());
    root = realpathSync(harnessDir);
  } catch (err) {
    throw new WorkspaceConfigError(
      `the harness directory cannot be read: ${(err as Error).message}`,
    );
  }
  for (const dir of [cwd, root]) {
    const parts = dir.split(sep);
    for (let i = 0; i + 1 < parts.length; i += 1) {
      if (parts[i] === ".crewhaus" && parts[i + 1] === "workspaces") {
        throw new WorkspaceConfigError(
          "A harness runs in its own directory, never inside a workspace. Start it where its crewhaus.yaml is.",
        );
      }
    }
  }
}

let active: WorkspaceConfig | undefined;
let bootProblem: string | undefined;

/** Create each binding's directory and write the file Home reads. */
export function writeBindings(harnessDir: string, config: WorkspaceConfig): void {
  for (const r of config.repositories) {
    const made = ensureDirContained(harnessDir, bindingDirOf(r.name), { mode: 0o700 });
    if (!made.ok) throw new WorkspaceConfigError(`${bindingDirOf(r.name)}: ${made.reason}`);
  }
  const dir = ensureDirContained(harnessDir, workDirOf(harnessDir), { mode: 0o700 });
  if (!dir.ok) throw new WorkspaceConfigError(`${workDirOf(harnessDir)}: ${dir.reason}`);
  // Built key by key: what Home reads holds no token, no intent and no judge.
  const file: BindingsFile = {
    v: 1,
    repositories: config.repositories,
    ...(config.tokenEnv !== undefined ? { tokenEnv: config.tokenEnv } : {}),
  };
  const written = writeFileSafe(
    harnessDir,
    bindingsFileOf(harnessDir),
    `${JSON.stringify(file)}\n`,
    { overwrite: true, mode: 0o600 },
  );
  if (!written.ok)
    throw new WorkspaceConfigError(`${bindingsFileOf(harnessDir)}: ${written.reason}`);
}

/**
 * The boot registrar: the bundle's `repositories` block, taken literally, kept for the
 * workspace tools and written for Home. A block it cannot take is refused with a message
 * naming the binding. A directory it cannot write leaves the tools refusing with that reason
 * instead of stopping the boot. No block registers nothing.
 */
export function bindWorkspaceRepositories(config: unknown): void {
  if (config === undefined || config === null) return;
  const parsed = parseWorkspaceConfig(config);
  const harnessDir = process.cwd();
  assertHarnessCwd(harnessDir);
  active = parsed;
  bootProblem = undefined;
  try {
    writeBindings(harnessDir, parsed);
  } catch (err) {
    bootProblem = (err as Error).message;
  }
}

/** The active build's bindings, or why there are none. */
export function activeBindings(): BindingsFile | { readonly problem: string } {
  if (bootProblem !== undefined) return { problem: bootProblem };
  if (active === undefined) {
    return {
      problem:
        "This harness declares no repositories. Add a repositories block to its crewhaus.yaml, then compile and start it again.",
    };
  }
  const { v, repositories, tokenEnv } = active;
  return { v, repositories, ...(tokenEnv !== undefined ? { tokenEnv } : {}) };
}

/** The declared intent: the acceptance judge's input, and nothing else's. */
export function acceptanceIntent(): DeclaredIntent | undefined {
  return active?.intent;
}

/** The model the acceptance check judges with, when the spec names one. */
export function acceptanceJudgeConfig(): AcceptanceJudgeConfig | undefined {
  return active?.judge;
}

/** Test seam: forget the registered block. */
export function _resetWorkspaceBindings(): void {
  active = undefined;
  bootProblem = undefined;
}

/**
 * What Home reads: the bindings the harness's last boot wrote. `undefined` when it wrote
 * none; a file that is not one is an error naming the file, never a guess.
 */
export function readBindings(harnessDir: string): BindingsFile | undefined {
  const rel = bindingsFileOf(harnessDir);
  const read = openForReadSync(harnessDir, rel, {
    maxBytes: BINDINGS_MAX_BYTES,
    followLeafSymlink: false,
  });
  if (!read.ok) {
    if (read.code === "not-found") return undefined;
    throw new WorkspaceConfigError(`${rel}: ${read.reason}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    throw new WorkspaceConfigError(`${rel} is not readable; start the harness again to rewrite it`);
  }
  const { repositories, tokenEnv } = parseWorkspaceConfig(body);
  return { v: 1, repositories, ...(tokenEnv !== undefined ? { tokenEnv } : {}) };
}

/** Whether a path is inside another, by its relative path. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
