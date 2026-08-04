import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreflight } from "./preflight";
import type { PreflightItem } from "./types";

const FAKE_KEY = ["sk", "test", "not", "real"].join("-");

const CLI_SPEC = `
name: helper
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: Help briefly.
`;

const CLI_SPEC_WITH_BUDGET = `${CLI_SPEC}budget:
  usd: 5
`;

const CLI_SPEC_WITH_MCP = `${CLI_SPEC}mcp_servers:
  thredz:
    transport: stdio
    command: bun
    args: [server.ts]
    env:
      THREDZ_API_KEY: $THREDZ_API_KEY
`;

const CHANNEL_SPEC = `
name: support-bot
target: channel
agent:
  model: claude-sonnet-4-5
  instructions: Answer briefly.
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: channel
gateway:
  port: 47613
`;

const CHANNEL_ENV_OK = {
  ANTHROPIC_API_KEY: FAKE_KEY,
  SLACK_BOT_TOKEN: "xoxb-fixture",
  SLACK_SIGNING_SECRET: "fixture-signing",
};

const freePorts = () => (port: number) => Promise.resolve({ port, free: true });

function byId(items: readonly PreflightItem[], id: string): PreflightItem | undefined {
  return items.find((i) => i.id === id);
}

describe("runPreflight — spec area", () => {
  test("YAML syntax errors are blocking and stop spec-derived areas gracefully", async () => {
    const report = await runPreflight({ specYaml: ":::not yaml at all", env: {} });
    expect(report.ok).toBe(false);
    expect(report.blocking[0]?.area).toBe("spec");
    expect(report.blocking[0]?.message).toContain("spec does not compile");
    // No crash, no spurious items from areas that need a parsed spec.
    expect(report.items.filter((i) => i.area === "credentials")).toEqual([]);
  });

  test("schema failures are blocking and name the path", async () => {
    const report = await runPreflight({
      specYaml: "name: t\ntarget: cli\n",
      env: {},
      checkPort: freePorts(),
    });
    expect(report.ok).toBe(false);
    expect(report.blocking.some((i) => i.message.includes("agent"))).toBe(true);
  });

  test("injected compiler warnings surface as warn items", async () => {
    const report = await runPreflight({
      specYaml: CLI_SPEC,
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      compileWarnings: ["key `frobnicate` is accepted but not wired"],
      checkPort: freePorts(),
    });
    const warning = byId(report.items, "spec.compile-warning.0");
    expect(warning?.level).toBe("warn");
    expect(warning?.message).toContain("frobnicate");
    expect(report.ok).toBe(true);
  });

  test("neither specYaml nor harnessDir → blocking spec.missing", async () => {
    const report = await runPreflight({ env: {} });
    expect(report.ok).toBe(false);
    expect(report.blocking[0]?.id).toBe("spec.missing");
  });
});

describe("runPreflight — credentials + durability", () => {
  test("missing model creds block; satisfied creds + budget → ok with info matrix", async () => {
    const missing = await runPreflight({ specYaml: CLI_SPEC, env: {}, checkPort: freePorts() });
    expect(missing.ok).toBe(false);
    expect(byId(missing.blocking, "credentials.anthropic")?.message).toContain("will not boot");

    const ok = await runPreflight({
      specYaml: CLI_SPEC_WITH_BUDGET,
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      checkPort: freePorts(),
    });
    expect(ok.ok).toBe(true);
    expect(byId(ok.items, "credentials.anthropic")?.level).toBe("info");
    // Budget declared → no uncapped-spend warning.
    expect(byId(ok.items, "durability.budget")).toBeUndefined();
  });

  test("live creds without a budget block warn (but never block)", async () => {
    const report = await runPreflight({
      specYaml: CLI_SPEC,
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      checkPort: freePorts(),
    });
    expect(report.ok).toBe(true);
    const budget = byId(report.items, "durability.budget");
    expect(budget?.level).toBe("warn");
    expect(budget?.remediation).toContain("budget");
  });
});

describe("runPreflight — channel shape", () => {
  test('missing channel secret is blocking with the "will not boot: X unset" message', async () => {
    const report = await runPreflight({
      specYaml: CHANNEL_SPEC,
      env: { ANTHROPIC_API_KEY: FAKE_KEY, SLACK_BOT_TOKEN: "xoxb-fixture" },
      checkPort: freePorts(),
    });
    expect(report.ok).toBe(false);
    const item = byId(report.blocking, "channels.channels.slack.signingSecret");
    expect(item?.message).toContain("will not boot: SLACK_SIGNING_SECRET unset");
    expect(item?.envVar).toBe("SLACK_SIGNING_SECRET");
  });

  test("channel daemon without CREWHAUS_DEDUP_STORE warns; with it, no warning", async () => {
    const without = await runPreflight({
      specYaml: CHANNEL_SPEC,
      env: CHANNEL_ENV_OK,
      checkPort: freePorts(),
    });
    expect(byId(without.items, "durability.dedup-store")?.level).toBe("warn");

    const withStore = await runPreflight({
      specYaml: CHANNEL_SPEC,
      env: { ...CHANNEL_ENV_OK, CREWHAUS_DEDUP_STORE: "sqlite:.crewhaus/dedup.sqlite" },
      checkPort: freePorts(),
    });
    expect(byId(withStore.items, "durability.dedup-store")).toBeUndefined();
  });

  test("gateway.port and env PORT are checked; a taken port blocks", async () => {
    const requested: number[] = [];
    const report = await runPreflight({
      specYaml: CHANNEL_SPEC,
      env: { ...CHANNEL_ENV_OK, PORT: "3000" },
      checkPort: (port) => {
        requested.push(port);
        return Promise.resolve({ port, free: port !== 47613 });
      },
    });
    expect(requested.sort()).toEqual([3000, 47613]);
    const taken = byId(report.blocking, "ports.47613");
    expect(taken?.message).toContain("spec gateway.port");
    expect(byId(report.items, "ports.3000")?.level).toBe("info");
  });

  test("fully provisioned channel harness is ok", async () => {
    const report = await runPreflight({
      specYaml: CHANNEL_SPEC,
      env: { ...CHANNEL_ENV_OK, CREWHAUS_DEDUP_STORE: "sqlite:.crewhaus/dedup.sqlite" },
      checkPort: freePorts(),
    });
    expect(report.ok).toBe(true);
    expect(report.blocking).toEqual([]);
  });
});

describe("runPreflight — mcp dry-run", () => {
  test("unset MCP env ref blocks with the boot ConfigError text", async () => {
    const report = await runPreflight({
      specYaml: CLI_SPEC_WITH_MCP,
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      checkPort: freePorts(),
    });
    expect(report.ok).toBe(false);
    const item = byId(report.blocking, "mcp.thredz.env.THREDZ_API_KEY");
    expect(item?.message).toContain("environment variable THREDZ_API_KEY is not set");
    expect(item?.envVar).toBe("THREDZ_API_KEY");
  });
});

describe("runPreflight — harnessDir + bundle freshness", () => {
  test("reads crewhaus.yaml from harnessDir and labels a stale bundle approximate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-harness-"));
    const specPath = join(dir, "crewhaus.yaml");
    writeFileSync(specPath, CLI_SPEC_WITH_BUDGET);
    mkdirSync(join(dir, "dist"), { recursive: true });
    const artifact = join(dir, "dist", "agent.ts");
    writeFileSync(artifact, "// generated\n");
    utimesSync(specPath, 2_000_000_000, 2_000_000_000);
    utimesSync(artifact, 1_000_000_000, 1_000_000_000);

    const report = await runPreflight({
      harnessDir: dir,
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      checkPort: freePorts(),
    });
    expect(report.ok).toBe(true);
    const stale = byId(report.items, "bundle.stale");
    expect(stale?.level).toBe("warn");
    expect(stale?.message).toContain("approximate mtime heuristic");
  });

  test("missing crewhaus.yaml in harnessDir → blocking spec.missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-empty-"));
    const report = await runPreflight({ harnessDir: dir, env: {}, checkPort: freePorts() });
    expect(report.ok).toBe(false);
    expect(report.blocking[0]?.id).toBe("spec.missing");
  });

  test("the freshness comparator seam is injectable (spec-hash drop-in)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-seam-"));
    writeFileSync(join(dir, "crewhaus.yaml"), CLI_SPEC_WITH_BUDGET);
    const report = await runPreflight({
      harnessDir: dir,
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      checkPort: freePorts(),
      freshness: () => ({ state: "fresh" }),
    });
    expect(byId(report.items, "bundle.fresh")?.level).toBe("info");
  });
});

describe("report shape", () => {
  test("blocking is exactly the blocking-level subset, in item order", async () => {
    const report = await runPreflight({
      specYaml: CHANNEL_SPEC,
      env: {},
      checkPort: freePorts(),
    });
    expect(report.blocking).toEqual(report.items.filter((i) => i.level === "blocking"));
    expect(report.ok).toBe(report.blocking.length === 0);
  });
});
