/**
 * System mode: the real CLI, as a child process, from source or from the binary
 * `CREWHAUS_E2E_BIN` names. The child's whole environment is spelled out here,
 * with `HOME` a sandbox, so nothing on the machine leaks in or gets written to.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHangarRoot } from "@crewhaus/harness-registry";
import type { HomeAddress } from "./session";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * How to start the CLI. Callers leave `env` alone so it reads this process's
 * environment: a child's is spelled out, and does not carry the variable.
 */
export function crewhausArgv(env: Readonly<Record<string, string | undefined>> = process.env) {
  const bin = env["CREWHAUS_E2E_BIN"];
  if (bin !== undefined && bin !== "") return [bin];
  return [process.execPath, join(REPO_ROOT, "apps", "cli", "src", "index.ts")];
}

/** The environment a sandbox implies: registry, watch-me store and home inside it. */
export function sandboxEnv(sandbox: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: sandbox,
    CREWHAUS_REGISTRY_ROOT: join(sandbox, "registry"),
    CREWHAUS_WATCHME_ROOT: join(sandbox, "watchme"),
  };
}

/**
 * The child's whole environment. Registration stays on, because that is how a
 * run reaches the console, and sessions stay at the default path under the
 * working directory, because that is where the console reads them.
 */
export function childEnv(sandbox: string, modelUrl?: string): Record<string, string> {
  return {
    ...sandboxEnv(sandbox),
    // Built from parts, and only ever sent to the loopback fake.
    ANTHROPIC_API_KEY: ["sk", "ant", "e2e", "0".repeat(12)].join("-"),
    ...(modelUrl !== undefined ? { ANTHROPIC_BASE_URL: modelUrl } : {}),
  };
}

/** How long a child gets to print its URL. A wait, not an assertion on time. */
const PRINT_BOUND_MS = 60_000;
/** What `crewhaus hangar` prints: the summary's `url` row, a bare address. No credential is
 *  ever printed: a session reads Home's own key from the sandbox, where the CLI does. */
const PRINTED_URL = /^│\s+url\s+(http:\/\/127\.0\.0\.1:(\d+))\s*$/m;

/** Pull the address out of what the CLI printed. */
export function parsePrintedUrl(
  output: string,
): { readonly url: string; readonly port: number } | undefined {
  const match = PRINTED_URL.exec(output);
  if (match === null) return undefined;
  const [, url, port] = match;
  if (url === undefined || port === undefined) return undefined;
  return { url, port: Number(port) };
}

/** Home's own key, read from the sandbox's Hangar root the way the CLI reads it; "" when absent. */
export function sandboxToken(env: Readonly<Record<string, string | undefined>>): string {
  try {
    return readFileSync(join(resolveHangarRoot(env), "token"), "utf8").trim();
  } catch {
    return "";
  }
}

export type SpawnedHangar = {
  readonly pid: number;
  readonly port: number;
  readonly home: HomeAddress;
  /** SIGTERM, then the exit code. */
  stop(): Promise<number>;
};

/** Start `crewhaus hangar`, and read stdout until it prints where it is. */
export async function spawnHangar(
  env: Readonly<Record<string, string>>,
  cwd?: string,
): Promise<SpawnedHangar> {
  const child = Bun.spawn([...crewhausArgv(), "hangar", "--no-open", "--port", "0"], {
    env: { ...env },
    ...(cwd !== undefined ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const bound = Bun.sleep(PRINT_BOUND_MS).then(() => "bound" as const);
  let address = parsePrintedUrl(output);
  while (address === undefined) {
    const next = await Promise.race([reader.read(), bound]);
    if (next === "bound" || next.done === true) {
      child.kill("SIGKILL");
      const reason = next === "bound" ? "printed no URL in time" : "exited before printing a URL";
      throw new Error(`crewhaus hangar ${reason}:\n${output}\n${await stderr}`);
    }
    output += decoder.decode(next.value, { stream: true });
    address = parsePrintedUrl(output);
  }
  // Keep draining, so a chatty child never blocks on a full pipe.
  void (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  })();
  const { port, url } = address;
  // No boot link is printed either: the first session mints its own with Home's key.
  const home: HomeAddress = { url, token: sandboxToken(env), bootPath: "" };
  return {
    pid: child.pid,
    port,
    home,
    stop: async () => {
      child.kill("SIGTERM");
      return await child.exited;
    },
  };
}

export type CompletedRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** `crewhaus run` from a harness directory, with one prompt on stdin and then EOF. */
export async function runCrewhaus(
  harnessDir: string,
  env: Readonly<Record<string, string>>,
  prompt: string,
): Promise<CompletedRun> {
  const child = Bun.spawn([...crewhausArgv(), "run", "crewhaus.yaml"], {
    cwd: harnessDir,
    env: { ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${prompt}\n`);
  await child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}
