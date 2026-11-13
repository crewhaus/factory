/**
 * Check a spec with a harness's OWN `@crewhaus/spec`, in a separate process.
 *
 * A fleet spans CrewHaus versions, so a harness's spec is checked against the
 * schema it was built with. That schema is the harness's code, and Home never
 * runs a harness's code in its own process: the check runs in a child.
 *
 * The child is started with a fixed source (the {@link VALIDATOR_SOURCE}
 * constant; nothing from a request reaches its command line), in a fresh
 * empty working directory removed afterwards (the harness's `.env` and
 * `bunfig.toml` never apply: `--no-env-file`, `--no-install`), with an
 * environment of `PATH` from Home's own environment and nothing else. The
 * entry point is an absolute contained path, so it resolves its own
 * dependencies from where it sits. The spec and the entry point go in on
 * stdin; the answer comes back on stdout as JSON, capped, within a timeout. No interpreter, a timeout, a
 * crash, output past the cap or output that is not the answer: the caller
 * falls back to Home's own schema and says why.
 *
 * Only a harness adopted with `crewhaus harness adopt` on this machine is checked this
 * way, and only when its `@crewhaus/spec` resolves inside the harness; the caller decides
 * both.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

/** The child's whole program. It imports the entry Home resolved and contained, and nothing else. */
export const VALIDATOR_SOURCE = `
const input = JSON.parse(await new Response(Bun.stdin.stream()).text());
const mod = await import(input.entry);
const issues = [];
for (const issue of mod.parseSpecIssues(input.yaml)) {
  issues.push({ path: (issue.path ?? []).map(String), message: String(issue.message), code: issue.code ?? null });
}
const out = { issues };
if (input.op === "schema") {
  out.schema = mod.specJsonSchema();
  try { out.parsed = mod.parseSpec(input.yaml); } catch { out.parsed = null; }
}
process.stdout.write(JSON.stringify(out));
`;

export type ChildIssue = {
  readonly path: ReadonlyArray<string>;
  readonly message: string;
  readonly code: string | null;
};

export type ChildAnswer =
  | {
      readonly ok: true;
      readonly issues: ReadonlyArray<ChildIssue>;
      readonly schema?: Record<string, unknown>;
      /** The spec parsed with the harness's schema (defaults applied), or null when it does not parse. */
      readonly parsed?: unknown;
    }
  | { readonly ok: false; readonly note: string };

/** The interpreter flags every check starts with: no `.env` file is loaded and nothing is installed. */
export const VALIDATOR_FLAGS = ["--no-env-file", "--no-install"] as const;

/** A started child, as {@link validateInHarness} uses it. */
export type ChildHandle = {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
};

export type SpawnChild = (
  cmd: readonly string[],
  opts: { readonly cwd: string; readonly env: Record<string, string>; readonly stdin: string },
) => ChildHandle;

export type ChildTimer = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type ValidateInHarnessOptions = {
  readonly op: "issues" | "schema";
  /** The contained `@crewhaus/spec` entry point the child imports. */
  readonly entry: string;
  readonly spawn?: SpawnChild;
  readonly timer?: ChildTimer;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Home's own environment; only `PATH` is passed on. Default `process.env`. */
  readonly homeEnv?: Readonly<Record<string, string | undefined>>;
  /** The interpreter; default {@link bunInterpreter}. */
  readonly interpreter?: string | undefined;
};

export const VALIDATOR_TIMEOUT_MS = 10_000;
/** A schema document is large; an answer past this is not one. */
export const VALIDATOR_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The `bun` that runs the child: this process when it is `bun` itself, else `bun` on PATH,
 * searching only absolute PATH entries, so the answer is an absolute path that never
 * depends on the directory the child runs in.
 */
export function bunInterpreter(
  homeEnv: Readonly<Record<string, string | undefined>> = process.env,
  execPath: string = process.execPath,
): string | undefined {
  const name = basename(execPath).toLowerCase();
  if (name === "bun" || name === "bun.exe") return execPath;
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (homeEnv["PATH"] ?? "").split(sep)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    for (const candidate of process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"]) {
      const path = join(dir, candidate);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

const defaultSpawn: SpawnChild = (cmd, opts) => {
  const child = Bun.spawn([...cmd], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "ignore",
  });
  return { stdout: child.stdout, exited: child.exited, kill: () => child.kill() };
};

const defaultTimer: ChildTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a stream up to `maxBytes`; undefined when it goes past. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string | undefined> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseAnswer(text: string, op: "issues" | "schema"): ChildAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, note: "the harness's schema check answered something that is not JSON" };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed["issues"])) {
    return { ok: false, note: "the harness's schema check answered without a list of issues" };
  }
  const issues: ChildIssue[] = [];
  for (const raw of parsed["issues"] as unknown[]) {
    if (!isPlainObject(raw) || typeof raw["message"] !== "string") {
      return {
        ok: false,
        note: "the harness's schema check answered an issue it could not describe",
      };
    }
    issues.push({
      path: Array.isArray(raw["path"]) ? (raw["path"] as unknown[]).map(String) : [],
      message: raw["message"],
      code: typeof raw["code"] === "string" ? raw["code"] : null,
    });
  }
  if (op === "schema") {
    if (!isPlainObject(parsed["schema"])) {
      return { ok: false, note: "the harness's schema check answered no schema" };
    }
    return { ok: true, issues, schema: parsed["schema"], parsed: parsed["parsed"] ?? null };
  }
  return { ok: true, issues };
}

/**
 * Check `yaml` with the harness's own schema, in a child process. Never
 * throws: every failure is `{ ok: false, note }` naming why. `_harnessDir`
 * names the harness `opts.entry` belongs to; the child never runs there.
 */
export async function validateInHarness(
  _harnessDir: string,
  yaml: string,
  opts: ValidateInHarnessOptions,
): Promise<ChildAnswer> {
  const homeEnv = opts.homeEnv ?? process.env;
  const interpreter = "interpreter" in opts ? opts.interpreter : bunInterpreter(homeEnv);
  if (interpreter === undefined) {
    return {
      ok: false,
      note: "no bun interpreter was found on this machine's PATH to run the harness's schema check",
    };
  }
  const env: Record<string, string> = {};
  const path = homeEnv["PATH"];
  if (typeof path === "string") env["PATH"] = path;
  const spawn = opts.spawn ?? defaultSpawn;
  const timer = opts.timer ?? defaultTimer;
  const timeoutMs = opts.timeoutMs ?? VALIDATOR_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? VALIDATOR_MAX_BYTES;

  let cwd: string;
  try {
    cwd = mkdtempSync(join(tmpdir(), "crewhaus-spec-check-"));
  } catch (err) {
    return {
      ok: false,
      note: `the harness's schema check had no working directory: ${(err as Error).message}`,
    };
  }
  try {
    return await runChild(spawn, [interpreter, ...VALIDATOR_FLAGS, "-e", VALIDATOR_SOURCE], {
      cwd,
      env,
      stdin: JSON.stringify({ op: opts.op, entry: opts.entry, yaml }),
      timer,
      timeoutMs,
      maxBytes,
      op: opts.op,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function runChild(
  spawn: SpawnChild,
  cmd: readonly string[],
  opts: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly stdin: string;
    readonly timer: ChildTimer;
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly op: "issues" | "schema";
  },
): Promise<ChildAnswer> {
  const { timer, timeoutMs, maxBytes } = opts;
  let child: ChildHandle;
  try {
    child = spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: opts.stdin });
  } catch (err) {
    return {
      ok: false,
      note: `the harness's schema check could not start: ${(err as Error).message}`,
    };
  }

  type Outcome = { kind: "timeout" } | { kind: "done"; text: string | undefined; code: number };
  let handle: unknown;
  const timedOut = new Promise<Outcome>((resolve) => {
    handle = timer.set(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const finished = (async (): Promise<Outcome> => {
    const text = await readCapped(child.stdout, maxBytes);
    if (text === undefined) return { kind: "done", text, code: -1 };
    return { kind: "done", text, code: await child.exited };
  })().catch((): Outcome => ({ kind: "done", text: "", code: -1 }));
  const outcome = await Promise.race([finished, timedOut]);
  timer.clear(handle);
  if (outcome.kind === "timeout") {
    child.kill();
    return {
      ok: false,
      note: `the harness's schema check did not answer within ${Math.round(timeoutMs / 1000)} seconds`,
    };
  }
  if (outcome.text === undefined) {
    child.kill();
    return { ok: false, note: "the harness's schema check answered more than this manager reads" };
  }
  if (outcome.code !== 0) {
    return { ok: false, note: `the harness's schema check stopped with exit code ${outcome.code}` };
  }
  return parseAnswer(outcome.text, opts.op);
}
