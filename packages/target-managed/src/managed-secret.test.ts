/**
 * A managed daemon's signing secret and the boot check on where its tenants
 * root belongs, compiled and RUN. `index.test.ts` pins the emitted text; this
 * boots the emitted daemon the way an operator does (cwd = harness root, a
 * `node_modules/@crewhaus/*` link farm standing in for `bun install`) and asks
 * it over HTTP on loopback.
 *
 * No credential is real, and no test reaches a model.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { signJwt } from "@crewhaus/gateway-server";
import type { IrManagedV0 } from "@crewhaus/ir";
import { emitManaged } from "./index";

/** Generous but bounded: a cold `bun` boot of the emitted daemon under load. */
const BOOT_TIMEOUT_MS = 90_000;
/** Two boots of the emitted daemon, each slow by construction on a CI runner. */
const TEST_TIMEOUT_MS = 200_000;

const REPO_ROOT = dirname(dirname(dirname(import.meta.dir)));
const BANNER = /\[managed\] gateway listening on 127\.0\.0\.1:(\d+)/;
const SAVED_LINE =
  "[managed] no CREWHAUS_GATEWAY_JWT_SECRET in env, so this run generated one and saved it to .crewhaus/run/gateway-jwt-secret.";
const REFUSAL =
  "[managed] this spec declares a tool that works on files, so CREWHAUS_TENANTS_ROOT must be outside the harness directory";
const ENV_SECRET = ["managed", "secret", "0".repeat(16)].join("-");

const ir: IrManagedV0 = {
  version: 0,
  name: "managed-secret",
  target: "managed",
  agent: { model: "claude-sonnet-4-6", instructions: "Answer." },
  tenants: [{ id: "tenant-a", budget: { maxInputTokens: 1_000, maxOutputTokens: 1_000 } }],
  permissions: { rules: [] },
  compaction: {},
  continuity: undefined,
};

const dirs: string[] = [];
const procs: Array<ReturnType<typeof Bun.spawn>> = [];
afterAll(() => {
  for (const p of procs) p.kill();
  for (const d of dirs) {
    try {
      chmodSync(join(d, ".crewhaus", "run"), 0o700);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A harness dir with the emitted bundle under `dist/` and the workspace linked in. */
function makeHarness(spec: IrManagedV0): string {
  const root = scratch("crewhaus-managed-secret-");
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  for (const file of emitManaged(spec, { readme: false }).files) {
    writeFileSync(join(dist, file.path), file.content);
  }
  const scope = join(root, "node_modules", "@crewhaus");
  mkdirSync(scope, { recursive: true });
  const packagesDir = join(REPO_ROOT, "packages");
  for (const name of readdirSync(packagesDir)) {
    symlinkSync(join(packagesDir, name), join(scope, name), "dir");
  }
  return root;
}

type Run = {
  /** Set when the banner appeared: the daemon is listening here. */
  readonly base: string | undefined;
  /** Set when the process ended before the banner. */
  readonly exitCode: number | undefined;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
};

/** Start the daemon and wait for its banner, or for it to exit. */
async function boot(root: string, env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn({
    cmd: [process.execPath, join(root, "dist", "daemon.ts")],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: root,
      ANTHROPIC_API_KEY: ["sk", "ant", "e2e", "0".repeat(12)].join("-"),
      CREWHAUS_TENANTS_ROOT: join(scratch("crewhaus-managed-tenants-"), "tenants"),
      CREWHAUS_SESSION_DIR: join(root, "sessions"),
      CREWHAUS_NO_REGISTRY: "1",
      CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
      CREWHAUS_JANITOR: "0",
      PORT: "0",
      HOST: "127.0.0.1",
      ...env,
    },
  });
  procs.push(proc);
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  let exitCode: number | undefined;
  void proc.exited.then((code) => {
    exitCode = code;
  });
  const started = Date.now();
  while (Date.now() - started < BOOT_TIMEOUT_MS) {
    if (BANNER.test(output) || exitCode !== undefined) break;
    await Bun.sleep(25);
  }
  if (exitCode !== undefined) await drained;
  const port = output.match(BANNER)?.[1];
  if (port === undefined && exitCode === undefined) {
    throw new Error(`the daemon neither listened nor exited:\n${output}`);
  }
  return {
    base: port === undefined ? undefined : `http://127.0.0.1:${port}`,
    exitCode,
    output: () => output,
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}

/** The HTTP status of an authenticated call that reaches no model. */
async function statusWith(base: string | undefined, secret: string): Promise<number> {
  if (base === undefined) throw new Error("the daemon is not listening");
  const token = signJwt({ tenant_id: "tenant-a", sub: "managed-secret-test" }, secret);
  const res = await fetch(base, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocol: "crewhaus.v1",
      id: "req-1",
      method: "audit.tail",
      params: { tenantId: "tenant-a" },
    }),
  });
  return res.status;
}

const secretPath = (root: string): string => join(root, ".crewhaus", "run", "gateway-jwt-secret");
const savedSecret = (root: string): string => readFileSync(secretPath(root), "utf8").trim();

/** What `git check-ignore` answers for the secret file in a fresh repository at the harness. */
function ignoredByGit(root: string): boolean {
  const git = (...args: string[]): number =>
    Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "ignore", stderr: "ignore" })
      .exitCode;
  expect(git("init", "--quiet")).toBe(0);
  const answer = git("check-ignore", "--quiet", secretPath(root));
  // 0 is ignored and 1 is not; anything else means git could not say.
  expect([0, 1]).toContain(answer);
  return answer === 0;
}

describe("a signing secret the daemon generates", () => {
  test(
    "goes to a 0600 file beside a .gitignore, the log names the path, and a token minted from it passes",
    async () => {
      const root = makeHarness(ir);
      const run = await boot(root);
      try {
        expect(run.exitCode).toBeUndefined();
        const raw = readFileSync(secretPath(root), "utf8");
        expect(raw).toMatch(/^[0-9a-f]{48}\n$/);
        expect(statSync(secretPath(root)).mode & 0o777).toBe(0o600);
        expect(readFileSync(join(root, ".crewhaus", "run", ".gitignore"), "utf8")).toBe("*\n");
        expect(statSync(join(root, ".crewhaus", "run")).mode & 0o777).toBe(0o700);
        // stdout and stderr together, up to the banner.
        expect(run.output()).toContain(SAVED_LINE);
        expect(run.output()).not.toContain(raw.trim());
        expect(await statusWith(run.base, raw.trim())).toBe(200);
        // The control: this check can tell a good secret from a bad one.
        expect(await statusWith(run.base, "f".repeat(48))).toBe(401);
      } finally {
        await run.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a second boot replaces the file, and only the new value is honoured",
    async () => {
      const root = makeHarness(ir);
      const first = await boot(root);
      const firstValue = savedSecret(root);
      await first.stop();
      const second = await boot(root);
      try {
        const secondValue = savedSecret(root);
        expect(secondValue).toMatch(/^[0-9a-f]{48}$/);
        expect(secondValue).not.toBe(firstValue);
        expect(await statusWith(second.base, secondValue)).toBe(200);
        expect(await statusWith(second.base, firstValue)).toBe(401);
      } finally {
        await second.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a link at the path is replaced with its target unchanged; an existing .gitignore stays; the daemon does not read the old entry",
    async () => {
      const root = makeHarness(ir);
      const runDir = join(root, ".crewhaus", "run");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, ".gitignore"), "kept-by-the-operator\n");
      const target = join(scratch("crewhaus-managed-target-"), "elsewhere");
      const planted = "a".repeat(48);
      writeFileSync(target, `${planted}\n`);
      symlinkSync(target, secretPath(root));
      const run = await boot(root);
      try {
        expect(lstatSync(secretPath(root)).isSymbolicLink()).toBe(false);
        expect(statSync(secretPath(root)).mode & 0o777).toBe(0o600);
        expect(readFileSync(target, "utf8")).toBe(`${planted}\n`);
        expect(readFileSync(join(runDir, ".gitignore"), "utf8")).toBe("kept-by-the-operator\n");
        expect(savedSecret(root)).not.toBe(planted);
        expect(await statusWith(run.base, savedSecret(root))).toBe(200);
        expect(await statusWith(run.base, planted)).toBe(401);
      } finally {
        await run.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a directory at .gitignore gives way to the file, and git ignores the secret",
    async () => {
      const root = makeHarness(ir);
      const ignoreFile = join(root, ".crewhaus", "run", ".gitignore");
      mkdirSync(join(ignoreFile, "nested"), { recursive: true });
      writeFileSync(join(ignoreFile, "nested", "entry"), "x\n");
      const run = await boot(root);
      try {
        expect(run.exitCode).toBeUndefined();
        expect(lstatSync(ignoreFile).isFile()).toBe(true);
        expect(readFileSync(ignoreFile, "utf8")).toBe("*\n");
        expect(existsSync(secretPath(root))).toBe(true);
        expect(ignoredByGit(root)).toBe(true);
      } finally {
        await run.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a link at .gitignore gives way to the file, with its target unchanged",
    async () => {
      const root = makeHarness(ir);
      const ignoreFile = join(root, ".crewhaus", "run", ".gitignore");
      mkdirSync(dirname(ignoreFile), { recursive: true });
      const target = join(scratch("crewhaus-managed-target-"), "elsewhere");
      writeFileSync(target, "kept\n");
      symlinkSync(target, ignoreFile);
      const run = await boot(root);
      try {
        expect(run.exitCode).toBeUndefined();
        expect(lstatSync(ignoreFile).isFile()).toBe(true);
        expect(readFileSync(ignoreFile, "utf8")).toBe("*\n");
        expect(readFileSync(target, "utf8")).toBe("kept\n");
      } finally {
        await run.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // root ignores the mode bits; the next test covers the same refusal for root.
  test.skipIf(process.getuid?.() === 0)(
    "a read-only run directory: exit 1, naming the variable, before anything listens",
    async () => {
      const root = makeHarness(ir);
      const runDir = join(root, ".crewhaus", "run");
      mkdirSync(runDir, { recursive: true });
      chmodSync(runDir, 0o500);
      try {
        const run = await boot(root);
        expect(run.exitCode).toBe(1);
        expect(run.base).toBeUndefined();
        expect(run.output()).toContain(
          "[managed] set CREWHAUS_GATEWAY_JWT_SECRET (at least 16 chars)",
        );
        expect(run.output()).toContain(".crewhaus/run/gateway-jwt-secret");
        expect(existsSync(secretPath(root))).toBe(false);
      } finally {
        chmodSync(runDir, 0o700);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a run directory that cannot be made: exit 1, naming the variable",
    async () => {
      const root = makeHarness(ir);
      writeFileSync(join(root, ".crewhaus"), "a file where the directory goes\n");
      const run = await boot(root);
      expect(run.exitCode).toBe(1);
      expect(run.output()).toContain("[managed] set CREWHAUS_GATEWAY_JWT_SECRET");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "with the variable set: no file, no .gitignore, no line, and the variable signs",
    async () => {
      const root = makeHarness(ir);
      const run = await boot(root, { CREWHAUS_GATEWAY_JWT_SECRET: ENV_SECRET });
      try {
        expect(run.exitCode).toBeUndefined();
        expect(existsSync(secretPath(root))).toBe(false);
        expect(existsSync(join(root, ".crewhaus", "run", ".gitignore"))).toBe(false);
        expect(run.output()).not.toContain("saved it to");
        expect(run.output()).not.toContain(ENV_SECRET);
        expect(await statusWith(run.base, ENV_SECRET)).toBe(200);
      } finally {
        await run.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("where the tenants root belongs", () => {
  const withRead: IrManagedV0 = { ...ir, tools: ["read"] };

  test(
    "with a path-taking tool: a relative root inside the harness exits 21 with the refusal, and serves nothing",
    async () => {
      const root = makeHarness(withRead);
      const run = await boot(root, { CREWHAUS_TENANTS_ROOT: "live/tenants" });
      expect(run.exitCode).toBe(21);
      expect(run.base).toBeUndefined();
      expect(run.output()).toContain(REFUSAL);
      // Refused before the secret: nothing was saved.
      expect(existsSync(secretPath(root))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "with a file reader whose manifest row names no field: a root inside exits 21",
    async () => {
      const run = await boot(makeHarness({ ...ir, tools: ["readLines"] }), {
        CREWHAUS_TENANTS_ROOT: "live/tenants",
      });
      expect(run.exitCode).toBe(21);
      expect(run.output()).toContain(REFUSAL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "with a path-taking tool: a root outside the harness boots",
    async () => {
      const run = await boot(makeHarness(withRead));
      try {
        expect(run.exitCode).toBeUndefined();
        expect(run.base).toBeDefined();
        expect(run.output()).not.toContain(REFUSAL);
      } finally {
        await run.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "with a path-taking tool: a root that lands inside through a symlink, and does not exist yet, exits 21",
    async () => {
      const root = makeHarness(withRead);
      const link = join(scratch("crewhaus-managed-link-"), "harness");
      symlinkSync(root, link, "dir");
      const run = await boot(root, { CREWHAUS_TENANTS_ROOT: join(link, "not", "yet", "there") });
      expect(run.exitCode).toBe(21);
      expect(run.output()).toContain(REFUSAL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "without one: a root inside the harness boots, and the daemon carries no check",
    async () => {
      const root = makeHarness(ir);
      expect(readFileSync(join(root, "dist", "daemon.ts"), "utf8")).not.toContain(
        "checkTenantsRoot",
      );
      const run = await boot(root, { CREWHAUS_TENANTS_ROOT: "live/tenants" });
      try {
        expect(run.exitCode).toBeUndefined();
        expect(run.output()).not.toContain(REFUSAL);
      } finally {
        await run.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a spec with a path-taking tool and a feedback block boots and signs",
    async () => {
      const root = makeHarness({ ...withRead, feedback: { modality: "binary" } });
      const run = await boot(root);
      try {
        expect(run.exitCode).toBeUndefined();
        expect(await statusWith(run.base, savedSecret(root))).toBe(200);
      } finally {
        await run.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
