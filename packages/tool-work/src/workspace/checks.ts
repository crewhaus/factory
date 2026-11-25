/**
 * Running a repository's declared checks. A check runs the project's own code over changes a
 * model wrote, so it runs inside the configured sandbox (`CREWHAUS_SANDBOX`, docker when
 * unset) with the worktree mounted and nothing else: no network, none of the harness's
 * environment, the files it writes owned by the user who runs the harness. Without a sandbox
 * backend nothing runs and the answer is `not-run`, which never passes a gate.
 *
 * A check is an argv, handed to the container as separate arguments. No shell reads it.
 */
import { realpathSync } from "node:fs";
import { createSandbox, resolveSandboxBackend, sandboxAvailableFromEnv } from "@crewhaus/sandbox";
import type { RepositoryBinding } from "./bindings";

/** Why checks cannot run here, with what to do about it. */
export const NO_SANDBOX_REMEDY =
  "The checks run your project's code, so they need a sandbox and none is available. Start Docker or Podman and set CREWHAUS_SANDBOX=docker (or podman), or have the owner confirm the agreement line \"Runs your project's checks on this computer\".";

/** Where a worktree is mounted in the container. */
const MOUNT = "/workspace";
/** Docker's status for a container it could not create. */
const CREATE_FAILED = 125;
/** Bytes of each stream kept per check. */
const OUTPUT_MAX_BYTES = 128 * 1024;

/** The images the sandbox allows out of the box, by the program a check starts with. */
const IMAGES: Readonly<Record<string, string>> = {
  node: "node:22-alpine",
  npm: "node:22-alpine",
  npx: "node:22-alpine",
  corepack: "node:22-alpine",
  yarn: "node:22-alpine",
  python: "python:3.13-slim",
  python3: "python:3.13-slim",
  pip: "python:3.13-slim",
};
const DEFAULT_IMAGE = "alpine:3.19";

/** The image one check runs in: the binding's own, else one that has the check's program. */
export function checkImageFor(binding: RepositoryBinding, argv: readonly string[]): string {
  return binding.checkImage ?? IMAGES[argv[0] ?? ""] ?? DEFAULT_IMAGE;
}

export type CheckInput = {
  readonly argv: readonly string[];
  readonly image: string;
  /** The worktree, absolute, its links followed. */
  readonly worktree: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

export type CheckAnswer =
  | {
      readonly ran: true;
      readonly exit: number;
      readonly timedOut: boolean;
      readonly output: string;
    }
  /** The sandbox could not start it: nothing ran. */
  | { readonly ran: false; readonly reason: string };

/** What runs a check. Tests pass their own; the default is the configured sandbox. */
export type CheckRunner = (input: CheckInput) => Promise<CheckAnswer>;

/**
 * The configured sandbox as a check runner, or `undefined` when there is none: `noop`, and a
 * value that names no backend, are both no sandbox.
 */
export function sandboxCheckRunner(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CheckRunner | undefined {
  if (!sandboxAvailableFromEnv(env)) return undefined;
  const backend = resolveSandboxBackend(env);
  if (!backend.ok || backend.backend === "noop") return undefined;
  const { backend: name } = backend;
  return async (input) => {
    const worktree = realpathSync(input.worktree);
    const sandbox = createSandbox({
      backend: name,
      allowedImages: [input.image],
      mountWhitelist: [worktree],
      memory: "2g",
      cpus: "2.0",
      maxOutputBytes: OUTPUT_MAX_BYTES,
    });
    try {
      const user =
        typeof process.getuid === "function" && typeof process.getgid === "function"
          ? `${process.getuid()}:${process.getgid()}`
          : undefined;
      const result = await sandbox.exec({
        image: input.image,
        argv: [...input.argv],
        env: { HOME: "/tmp", CI: "1" },
        mounts: [{ src: worktree, dst: MOUNT, readonly: false }],
        workdir: MOUNT,
        ...(user !== undefined ? { user } : {}),
        timeoutMs: input.timeoutMs,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      if (result.aborted === true) return { ran: false, reason: "it was stopped" };
      const output = [result.stdout, result.stderr].filter((t) => t !== "").join("\n");
      if (result.timedOut) return { ran: true, exit: 124, timedOut: true, output };
      if (result.exitCode === CREATE_FAILED && result.stdoutBytes === 0) {
        return { ran: false, reason: firstLine(result.stderr) };
      }
      if (result.exitCode < 0) return { ran: false, reason: "the container did not start" };
      return { ran: true, exit: result.exitCode, timedOut: false, output };
    } catch (err) {
      return { ran: false, reason: firstLine((err as Error).message) };
    } finally {
      await sandbox.close();
    }
  };
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line === "" ? "the sandbox could not start it" : line.slice(0, 200);
}

/** A check's name as a person reads it and a criterion spells it. */
export function checkName(argv: readonly string[]): string {
  return argv.join(" ");
}

export type CheckResult = {
  readonly k: number;
  readonly name: string;
  readonly exit: number;
  readonly timedOut: boolean;
  readonly output: string;
};

export type ChecksAnswer =
  | { readonly ran: true; readonly results: readonly CheckResult[]; readonly passed: boolean }
  /** At least one check could not be started: nothing is concluded from the others. */
  | { readonly ran: false; readonly reason: string };

/**
 * Run every declared check of a binding in a worktree, in order. A check that fails does not
 * stop the ones after it, so the agent sees them all. A worktree is whichever checkout the
 * caller names: an item's own, or a merge result.
 */
export async function runDeclaredChecks(input: {
  readonly binding: RepositoryBinding;
  readonly worktree: string;
  readonly runner: CheckRunner | undefined;
  readonly signal?: AbortSignal;
}): Promise<ChecksAnswer> {
  const { runner } = input;
  if (runner === undefined) return { ran: false, reason: NO_SANDBOX_REMEDY };
  const results: CheckResult[] = [];
  for (const [k, argv] of input.binding.checks.entries()) {
    const answer = await runner({
      argv,
      image: checkImageFor(input.binding, argv),
      worktree: input.worktree,
      timeoutMs: input.binding.checkTimeoutMs,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (!answer.ran) {
      return {
        ran: false,
        reason: `The check "${checkName(argv)}" could not be started in the sandbox (${answer.reason}).`,
      };
    }
    results.push({
      k,
      name: checkName(argv),
      exit: answer.exit,
      timedOut: answer.timedOut,
      output: answer.output,
    });
  }
  return { ran: true, results, passed: results.every((r) => r.exit === 0) };
}
