/**
 * An unset tool-config variable stops a compiled bundle at boot, and
 * `crewhaus compile --check` reads that stop as a first-boot gate.
 *
 * A `$VAR` in a `tool_config` or `chains` block is read when the bundle
 * starts. A daemon shape (channel, managed, crew) checks each such variable
 * just before the registration that reads it, and exits 2 with one line
 * naming it when it is unset, as its other boot gates do; the other shapes
 * stop at the same point with the registration's `BuiltinToolError` (exit 1),
 * which carries the same sentence. A registration ahead of that point still
 * runs, so a block its registrar refuses there keeps the check red.
 *
 * Real boots: each bundle is compiled in-process, written into an os.tmpdir()
 * mkdtemp, and started with `bun --no-install` against THIS working tree's
 * packages, linked into the bundle's node_modules (the recipe of
 * eval-bridge-smoke.test.ts). The cwd is a sandbox mkdtemp, and the env holds
 * only PATH, HOME and a sandbox registry root, plus what a case adds. Values
 * only need to be present: nothing here is a credential.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compile } from "@crewhaus/compiler";
import { DAEMON_ENTRY_TARGETS } from "@crewhaus/harness-supervisor";
import { SHAPE_TOOL_PROFILES } from "@crewhaus/tool-categories";
import {
  type CheckRunResult,
  type CheckStepRunner,
  defaultCheckRunner,
  runCompileCheck,
} from "./compile-check";

const REPO_ROOT = join(import.meta.dir, "../../..");

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function newTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Link the in-tree `@crewhaus/*` packages into a bundle's node_modules, so the
 * boot runs THIS working tree. Copied from eval-bridge-smoke.test.ts's
 * `linkWorkspacePackages`, which explains why: symlinks (not copies) so the
 * packages' own dependencies still resolve from the repo root, paired with
 * `--no-install` so a missing link fails loudly instead of reaching npm.
 */
function linkWorkspacePackages(dir: string): void {
  const nodeModules = join(dir, "node_modules");
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(REPO_ROOT, "packages", entry.name);
    const manifest = join(pkgDir, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    if (name === undefined || !name.startsWith("@crewhaus/")) continue;
    const dest = join(nodeModules, name);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) symlinkSync(pkgDir, dest, "dir");
  }
}

/** Compile `yaml` into a fresh directory, with the in-tree packages linked. No package.json is written. */
function build(yaml: string): { out: string; bundle: ReturnType<typeof compile> } {
  const out = newTmp("crewhaus-tool-gate-bundle-");
  const bundle = compile(yaml);
  for (const file of bundle.files) {
    const full = join(out, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
  }
  linkWorkspacePackages(out);
  return { out, bundle };
}

/**
 * Start `entry` once, the way an operator would, with nothing on stdin. A
 * daemon that stays up comes back `timedOut` after a minute and fails the
 * exit-code assertion instead of hanging the file.
 */
async function boot(
  out: string,
  entry: string,
  env: Readonly<Record<string, string>> = {},
): Promise<CheckRunResult & { readonly sandbox: string }> {
  const sandbox = newTmp("crewhaus-tool-gate-cwd-");
  const result = await defaultCheckRunner({
    argv: [process.execPath, "--no-install", join(out, entry)],
    cwd: sandbox,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: sandbox,
      CREWHAUS_REGISTRY_ROOT: join(sandbox, "registry"),
      ...env,
    },
    timeoutMs: 60_000,
  });
  return { ...result, sandbox };
}

const sentence = (path: string, name: string): string =>
  `${path} reads $${name}, but ${name} is not set. Set ${name} in the environment the harness starts in.`;
const RPC_SENTENCE = sentence("chains[0].rpcUrls[0]", "TOOL_GATE_RPC");
const ORIGIN_SENTENCE = sentence("agent.tool_config.http.allowed_origins[0]", "TOOL_GATE_ORIGIN");
const GATE_DETAIL =
  "boot reached its tool config env refs gate — full boot needs the env vars the spec's tool_config and chains blocks read";

const CHAINS = [
  "chains:",
  "  - id: ethereum-mainnet",
  "    kind: evm",
  '    rpcUrls: ["$TOOL_GATE_RPC"]',
  "    finality: { kind: confirmations, count: 12 }",
];
const AGENT_READS_ORIGIN = [
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: i",
  "  tools: [httpRequest]",
  "  tool_config:",
  "    http:",
  "      allowed_origins: [$TOOL_GATE_ORIGIN]",
];
/** A crew whose role reads a chain: the form of the DAO-governance walkthrough. */
const CREW = [
  "name: dao-voter",
  "target: crew",
  "model: claude-sonnet-4-6",
  "entry: triage",
  ...CHAINS,
  "roles:",
  "  triage:",
  "    instructions: Read the proposal id.",
  "    tools: [evmCall]",
].join("\n");
const MANAGED = [
  "name: m",
  "target: managed",
  ...AGENT_READS_ORIGIN,
  "tenants:",
  "  - id: t1",
  "    budget: { maxInputTokens: 1000, maxOutputTokens: 1000 }",
].join("\n");
const CHANNEL = [
  "name: ch",
  "target: channel",
  ...AGENT_READS_ORIGIN,
  "channels:",
  "  slack:",
  "    botToken: $SLACK_BOT_TOKEN",
  "    signingSecret: $SLACK_SIGNING_SECRET",
  "routing:",
  "  sessionKey: thread",
].join("\n");
/**
 * A managed agent with two blocks: an image block that compiles, but that its
 * registrar refuses at boot in every environment (a base URL with a query),
 * and an http block that reads a variable. `tools` sets the order the two
 * registrations run in.
 */
const managedWithRefusedBlock = (tools: string): string =>
  [
    "name: m",
    "target: managed",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: i",
    `  tools: [${tools}]`,
    "  tool_config:",
    "    imageGenerate:",
    '      openaiBaseUrl: "https://h.example.invalid/v1?x=1"',
    "    http:",
    "      allowed_origins: [$TOOL_GATE_ORIGIN]",
    "tenants:",
    "  - id: t1",
    "    budget: { maxInputTokens: 1000, maxOutputTokens: 1000 }",
  ].join("\n");
/** A workflow whose step reads a chain: the form of the wallet-gated-action walkthrough. */
const WORKFLOW = [
  "name: usdc-payout",
  "target: workflow",
  "model: claude-sonnet-4-6",
  ...CHAINS,
  "steps:",
  "  - name: simulate",
  "    instructions: i",
  "    tools: [evmCall]",
].join("\n");

describe("which shapes check their tool-config variables", () => {
  test("exactly the daemon-entry shapes that carry a tool catalog", () => {
    let host = 0;
    let daemons = 0;
    for (const [shape, profile] of Object.entries(SHAPE_TOOL_PROFILES)) {
      if (profile.runtime !== "host") continue;
      host += 1;
      if (profile.daemonEntry === true) daemons += 1;
      expect({ shape, checks: profile.daemonEntry === true }).toEqual({
        shape,
        checks: DAEMON_ENTRY_TARGETS.has(shape),
      });
    }
    expect({ host, daemons }).toEqual({ host: 10, daemons: 3 });
    // voice boots from daemon.ts too, but registers no tool catalog.
    expect(
      [...DAEMON_ENTRY_TARGETS].filter(
        (s) => SHAPE_TOOL_PROFILES[s as keyof typeof SHAPE_TOOL_PROFILES]?.daemonEntry !== true,
      ),
    ).toEqual(["voice"]);
    expect(SHAPE_TOOL_PROFILES.voice.runtime).toBe("none");
  });
});

describe("a compiled bundle started with a tool-config variable unset", () => {
  // Each test boots a compiled bundle's whole import graph in a subprocess,
  // and CI runners are slow at module loading.
  test("crew: exits 2 naming the variable, before the daemon does anything", async () => {
    const { out } = build(CREW);
    const r = await boot(out, "daemon.ts");
    expect({ exitCode: r.exitCode, timedOut: r.timedOut }).toEqual({
      exitCode: 2,
      timedOut: false,
    });
    expect(r.stderr).toBe(`${RPC_SENTENCE}\n`);
    expect(r.stderr).not.toContain("BuiltinToolError");
    expect(r.stderr).not.toContain("    at ");
    // No crew event, no audit log, no control state: nothing in daemon.ts ran.
    expect(r.stdout).toBe("");
    expect(existsSync(join(r.sandbox, ".crewhaus"))).toBe(false);
  }, 120_000);

  test("crew: with the variable set, the boot passes the check and reaches its next gate", async () => {
    const { out } = build(CREW);
    const r = await boot(out, "daemon.ts", { TOOL_GATE_RPC: "https://rpc.example.invalid" });
    expect({ exitCode: r.exitCode, timedOut: r.timedOut }).toEqual({
      exitCode: 2,
      timedOut: false,
    });
    expect(r.stderr).toContain("[crew] no input on stdin");
    expect(r.stderr).not.toContain("reads $TOOL_GATE_RPC");
  }, 120_000);

  test("managed: exits 2 naming the variable while daemon.ts imports agent.ts", async () => {
    const { out } = build(MANAGED);
    const r = await boot(out, "daemon.ts");
    expect({ exitCode: r.exitCode, timedOut: r.timedOut }).toEqual({
      exitCode: 2,
      timedOut: false,
    });
    expect(r.stderr).toBe(`${ORIGIN_SENTENCE}\n`);
  }, 120_000);

  test("channel: with its secrets present, exits 2 naming the variable", async () => {
    const { out } = build(CHANNEL);
    const r = await boot(out, "daemon.ts", {
      SLACK_BOT_TOKEN: "placeholder",
      SLACK_SIGNING_SECRET: "placeholder",
      ANTHROPIC_API_KEY: "placeholder",
    });
    expect({ exitCode: r.exitCode, timedOut: r.timedOut }).toEqual({
      exitCode: 2,
      timedOut: false,
    });
    expect(r.stderr).toContain(`${ORIGIN_SENTENCE}\n`);
    expect(r.stderr).not.toContain("missing required env vars");
    expect(r.stderr).not.toContain("BuiltinToolError");
  }, 120_000);

  test("workflow: unchanged, exits 1 with the registration's error and the same sentence", async () => {
    const { out } = build(WORKFLOW);
    const r = await boot(out, "agent.ts");
    expect({ exitCode: r.exitCode, timedOut: r.timedOut }).toEqual({
      exitCode: 1,
      timedOut: false,
    });
    expect(r.stderr).toContain(`BuiltinToolError: ${RPC_SENTENCE}`);
  }, 120_000);
});

describe("compile --check on a bundle whose tool config reads an unset variable", () => {
  /** The install step answered offline; the boot is real, against the linked packages. */
  function checkRunner(record: (boot: CheckRunResult) => void): CheckStepRunner {
    return async (opts) => {
      if (opts.argv[1] === "install") {
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      }
      const result = await defaultCheckRunner({
        ...opts,
        argv: [process.execPath, "--no-install", ...opts.argv.slice(1)],
      });
      record(result);
      return result;
    };
  }

  /** Compile `yaml` and run the check on it: the verdict, its boot step, and how the boot stopped. */
  async function check(target: string, yaml: string) {
    const { out, bundle } = build(yaml);
    const boots: CheckRunResult[] = [];
    const result = await runCompileCheck({
      target,
      bundle,
      outDir: out,
      runner: checkRunner((b) => boots.push(b)),
      bootTimeoutMs: 60_000,
      env: { PATH: process.env["PATH"] ?? "", HOME: newTmp("crewhaus-tool-gate-home-") },
    });
    return {
      green: result.green,
      boot: result.steps.find((s) => s.step === "boot"),
      // A timeout would read "ok"; this says the boot really stopped, and with what code.
      exits: boots.map((b) => ({ exitCode: b.exitCode, timedOut: b.timedOut })),
    };
  }

  for (const [target, yaml, exitCode] of [
    ["crew", CREW, 2],
    ["workflow", WORKFLOW, 1],
  ] as const) {
    test(`${target}: GREEN, gated at the tool config env refs gate (boot exit ${exitCode})`, async () => {
      const r = await check(target, yaml);
      expect(r.boot).toEqual({ step: "boot", status: "gated", detail: GATE_DETAIL });
      expect(r.green).toBe(true);
      expect(r.exits).toEqual([{ exitCode, timedOut: false }]);
    }, 120_000);
  }

  // A block its registrar refuses at boot stops the boot in every environment,
  // so the check must read it red. A daemon checks each variable just before
  // the registration that reads it, so a registration ahead of that one still
  // runs, and refuses with its own error.
  test("managed: a block refused at boot, registered before the variable is read, stays RED", async () => {
    const r = await check("managed", managedWithRefusedBlock("imageGenerate, httpRequest"));
    expect(r.boot?.status).toBe("failed");
    expect(r.boot?.detail).toStartWith(
      "boot exited 1: ImageGenerationError: the OpenAI base URL for https://h.example.invalid has a query or fragment.",
    );
    expect(r.green).toBe(false);
    expect(r.exits).toEqual([{ exitCode: 1, timedOut: false }]);
  }, 120_000);

  test("managed: the same blocks the other way round stop at the variable first: GREEN, gated", async () => {
    // A gate stops the boot before whatever comes after it, as every
    // first-boot gate does; here that is the refused block.
    const r = await check("managed", managedWithRefusedBlock("httpRequest, imageGenerate"));
    expect(r.boot).toEqual({ step: "boot", status: "gated", detail: GATE_DETAIL });
    expect(r.green).toBe(true);
    expect(r.exits).toEqual([{ exitCode: 2, timedOut: false }]);
  }, 120_000);
});
