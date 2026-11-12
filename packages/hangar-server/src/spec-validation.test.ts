/**
 * Home checks a spec with the schema the harness is built against, and never
 * runs a harness's code in its own process: an adopted harness's own
 * `@crewhaus/spec` answers from a child process, anything else is checked
 * with Home's schema and says so. A spec with settings the schema in use
 * does not know is read-only here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { SECURITY_SURFACES as SPEC_PATCH_SURFACES } from "@crewhaus/spec-patch";
import { specRev } from "@crewhaus/spec-patch/commit";
import { makeFixtureHarness } from "./fixture";
import { jobCrewhausBin } from "./process";
import { SECURITY_SURFACES, setSchemaCheckDeps } from "./spec-edit";
import { type ChildHandle, type SpawnChild, validateInHarness } from "./spec-validator-child";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");

const SPEC = [
  "name: validated",
  "target: cli",
  "agent:",
  "  model: claude-opus-5",
  "  instructions: |",
  "    You help.",
  "",
].join("\n");

/**
 * A harness's own `@crewhaus/spec`: it knows `future_block` (Home's schema
 * does not), refuses `agent.brand_new`, and writes the pid of whatever
 * process imports it to a marker file.
 */
function plantHarnessSchema(dir: string, marker: string): void {
  const pkg = join(dir, "node_modules", "@crewhaus", "spec");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@crewhaus/spec", version: "9.9.9", type: "module", main: "index.js" }),
  );
  writeFileSync(
    join(pkg, "index.js"),
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }));`,
      "const TOP = new Set(['name', 'target', 'agent', 'future_block', 'watchme', 'mcp_servers']);",
      "const AGENT = new Set(['model', 'instructions']);",
      "export function parseSpecIssues(yaml) {",
      "  const doc = Bun.YAML.parse(yaml) ?? {};",
      "  const issues = [];",
      "  const top = Object.keys(doc).filter((k) => !TOP.has(k));",
      "  if (top.length) issues.push({ path: [], code: 'unrecognized_keys', message: `Unrecognized key(s) in object: ${top.map((k) => `'${k}'`).join(', ')}` });",
      "  const agent = Object.keys(doc.agent ?? {}).filter((k) => !AGENT.has(k));",
      "  if (agent.length) issues.push({ path: ['agent'], code: 'unrecognized_keys', message: `Unrecognized key(s) in object: ${agent.map((k) => `'${k}'`).join(', ')}` });",
      "  return issues;",
      "}",
      "export function parseSpec(yaml) {",
      "  const issues = parseSpecIssues(yaml);",
      "  if (issues.length) throw new Error(issues[0].message);",
      "  return Bun.YAML.parse(yaml);",
      "}",
      "export function specJsonSchema() {",
      "  return { definitions: { cli: { type: 'object', properties: { future_block: { type: 'object' } } } } };",
      "}",
      "",
    ].join("\n"),
  );
}

const servers: TestServer[] = [];
afterEach(async () => {
  setSchemaCheckDeps({});
  for (const t of servers.splice(0)) await t.stop();
});

function boot(): TestServer {
  const t = bootTestServer({ now: () => NOW });
  servers.push(t);
  return t;
}

function harness(t: TestServer, name: string, yaml = SPEC): { dir: string; marker: string } {
  const dir = makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: "validated",
    noSpec: true,
  });
  writeFileSync(join(dir, "crewhaus.yaml"), yaml);
  const marker = join(t.workspace, `${name}.imported`);
  plantHarnessSchema(dir, marker);
  return { dir, marker };
}

async function register(t: TestServer, dir: string): Promise<string> {
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (res.body["entry"] as { id: string }).id;
}

function adopt(t: TestServer, id: string): void {
  const registry = openHangarRegistry({ root: t.registryRoot, env: {} });
  expect(registry.adopt(id, "prn_test")).toBeDefined();
}

const revOf = (dir: string) => specRev(readFileSync(join(dir, "crewhaus.yaml"), "utf8"));
const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });

describe("a harness's schema never runs in Home's process", () => {
  test("a harness not adopted here is checked with Home's schema and its code is never loaded", async () => {
    const t = boot();
    const { dir, marker } = harness(t, "not-adopted");
    const id = await register(t, dir);
    const schema = await t.api(`/api/h/${id}/spec/schema`);
    expect(schema.body["schemaSource"]).toBe("manager");
    expect(String(schema.body["note"])).toBe(
      "Checked with this CrewHaus's schema. Adopt the harness to check it with its own.",
    );
    await t.api(`/api/h/${id}/spec/trust`);
    await t.api(`/api/h/${id}/spec/diff`, { method: "POST", body: JSON.stringify({ edits: [] }) });
    const wrote = await t.api(
      `/api/h/${id}/spec`,
      put({ edits: [{ path: "agent.instructions", value: "Hi." }], expectedRev: revOf(dir) }),
    );
    expect(wrote.status).toBe(200);
    expect(existsSync(marker)).toBe(false);
  });

  test("an adopted harness is checked with its own schema, in another process", async () => {
    const t = boot();
    const { dir, marker } = harness(t, "adopted");
    const id = await register(t, dir);
    adopt(t, id);
    const schema = await t.api(`/api/h/${id}/spec/schema`);
    expect(schema.body["schemaSource"]).toBe("harness");
    expect(schema.body["schemaVersion"]).toBe("9.9.9");
    expect(existsSync(marker)).toBe(true);
    const pid = (JSON.parse(readFileSync(marker, "utf8")) as { pid: number }).pid;
    expect(pid).not.toBe(process.pid);
    rmSync(marker);
    const wrote = await t.api(
      `/api/h/${id}/spec`,
      put({ edits: [{ path: "agent.instructions", value: "Hi." }], expectedRev: revOf(dir) }),
    );
    expect(wrote.status).toBe(200);
    if (existsSync(marker)) {
      expect((JSON.parse(readFileSync(marker, "utf8")) as { pid: number }).pid).not.toBe(
        process.pid,
      );
    }
  }, 20_000); // starts real child processes

  test("an adopted harness's own schema refuses an edit it does not know", async () => {
    const t = boot();
    const { dir } = harness(t, "refuses");
    const id = await register(t, dir);
    adopt(t, id);
    const before = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
    const refused = await t.api(
      `/api/h/${id}/spec`,
      put({
        edits: [{ path: "agent.brand_new", value: 1 }],
        confirmName: "validated",
        expectedRev: revOf(dir),
      }),
    );
    expect(refused.body["ok"]).toBe(false);
    expect(String(refused.body["reason"])).toContain("brand_new");
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(before);
  }, 20_000); // starts real child processes
});

describe("a spec with settings the schema in use does not know is read-only", () => {
  const FUTURE = `${SPEC}future_block:\n  x: 1\n`;

  test("checked with Home's schema: every read says so, and a write is refused naming the setting", async () => {
    const t = boot();
    const { dir } = harness(t, "future", FUTURE);
    const id = await register(t, dir);
    for (const path of [`/api/h/${id}/spec/schema`, `/api/h/${id}/spec/trust`]) {
      const read = await t.api(path);
      const readOnly = read.body["readOnly"] as { paths: string[]; reason: string; verb: string };
      expect(readOnly.paths).toEqual(["future_block"]);
      expect(readOnly.reason).toContain("read-only here");
      expect(readOnly.verb).toContain("bunx crewhaus");
    }
    const refused = await t.api(
      `/api/h/${id}/spec`,
      put({ edits: [{ path: "agent.instructions", value: "Hi." }], expectedRev: revOf(dir) }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body["code"]).toBe("read-only");
    expect(String(refused.body["error"])).toContain("future_block");
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(FUTURE);
  });

  test("checked with the adopted harness's own schema, which knows the setting, it stays editable", async () => {
    const t = boot();
    const { dir } = harness(t, "future-adopted", FUTURE);
    const id = await register(t, dir);
    adopt(t, id);
    const read = await t.api(`/api/h/${id}/spec/schema`);
    expect(read.body["readOnly"]).toBeNull();
    const wrote = await t.api(
      `/api/h/${id}/spec`,
      put({ edits: [{ path: "agent.instructions", value: "Hi." }], expectedRev: revOf(dir) }),
    );
    expect(wrote.status).toBe(200);
    expect(wrote.body["wrote"]).toBe(true);
  }, 20_000); // starts real child processes

  test("a child that never answers falls back to Home's schema with the reason", async () => {
    const t = boot();
    const { dir } = harness(t, "hangs");
    const id = await register(t, dir);
    adopt(t, id);
    setSchemaCheckDeps({
      interpreter: "bun",
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        exited: new Promise<number>(() => {}),
        kill: () => {},
      }),
      timer: { set: (fn) => queueMicrotask(fn), clear: () => {} },
    });
    const read = await t.api(`/api/h/${id}/spec/schema`);
    expect(read.body["schemaSource"]).toBe("manager");
    expect(String(read.body["note"])).toContain("did not answer");
  });
});

describe("every spec write and its preview use the schema the harness is checked with", () => {
  const FUTURE = `${SPEC}future_block:\n  x: 1\nmcp_servers:\n  files:\n    transport: stdio\n    command: echo\n    args: []\n`;
  const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

  function plantAdvice(dir: string): void {
    const advice = join(dir, ".crewhaus", "advice");
    mkdirSync(advice, { recursive: true });
    writeFileSync(
      join(advice, "suggestions.json"),
      JSON.stringify({
        suggestions: [
          {
            findingId: "adv_instructions",
            summary: "be brief",
            patch: {
              target: "cli",
              path: ["agent", "instructions"],
              op: "replace",
              value: "You help briefly.",
              rationale: "observed",
            },
          },
        ],
      }),
    );
  }

  function plantWatchmeProposal(dir: string): string {
    const synth = join(dir, ".crewhaus", "watchme", "synthesized");
    mkdirSync(synth, { recursive: true });
    writeFileSync(
      join(synth, "20260803T000000Z.yaml"),
      `${SPEC.replace("You help.", "You help, watched.")}`,
    );
    return "20260803T000000Z";
  }

  async function adoptedFuture(t: TestServer, name: string): Promise<{ id: string; dir: string }> {
    const { dir } = harness(t, name, FUTURE);
    const id = await register(t, dir);
    adopt(t, id);
    return { id, dir };
  }

  async function notAdoptedFuture(
    t: TestServer,
    name: string,
  ): Promise<{ id: string; dir: string }> {
    const { dir } = harness(t, name, FUTURE);
    return { id: await register(t, dir), dir };
  }

  const readOnly = (res: { status: number; body: Record<string, unknown> }) => {
    expect(`${res.status}:${String(res.body["code"])}`).toBe("409:read-only");
    expect(String(res.body["error"])).toContain("future_block");
  };

  test("an adopted harness whose schema knows a newer setting: the diff preview answers", async () => {
    const t = boot();
    const { id } = await adoptedFuture(t, "diff-adopted");
    const diff = await t.api(
      `/api/h/${id}/spec/diff`,
      post({ edits: [{ path: "agent.instructions", value: "Hi." }] }),
    );
    expect(diff.status).toBe(200);
    expect(diff.body["ok"]).toBe(true);
    expect(diff.body["readOnly"]).toBeNull();
    expect(String(diff.body["diff"])).toContain("agent.instructions");
  }, 20_000); // starts real child processes

  test("an adopted harness whose schema knows a newer setting: a connector is previewed, added and removed", async () => {
    const t = boot();
    const { id, dir } = await adoptedFuture(t, "mcp-adopted");
    const dry = await t.api(
      `/api/h/${id}/builders/mcp`,
      post({ name: "notes", transport: "stdio", command: "cat" }),
    );
    expect(dry.status).toBe(200);
    expect(dry.body["ok"]).toBe(true);
    expect(dry.body["dryRun"]).toBe(true);
    const wrote = await t.api(
      `/api/h/${id}/builders/mcp`,
      post({
        name: "notes",
        transport: "stdio",
        command: "cat",
        dryRun: false,
        confirmName: "validated",
        expectedRev: dry.body["rev"],
      }),
    );
    expect(wrote.status).toBe(200);
    expect(wrote.body["ok"]).toBe(true);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toContain("notes:");
    const plan = await t.api(`/api/h/${id}/builders/mcp/notes`, { method: "DELETE" });
    expect(plan.status).toBe(200);
    expect(plan.body["dryRun"]).toBe(true);
    const removed = await t.api(
      `/api/h/${id}/builders/mcp/notes?confirmName=validated&expectedRev=${encodeURIComponent(String(plan.body["rev"]))}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(removed.body["ok"]).toBe(true);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).not.toContain("notes:");
  }, 20_000); // starts real child processes

  test("an adopted harness whose schema knows a newer setting: advice is previewed and applied", async () => {
    const t = boot();
    const { id, dir } = await adoptedFuture(t, "advice-adopted");
    plantAdvice(dir);
    const route = `/api/h/${id}/feedback/advice/adv_instructions/apply`;
    const preview = await t.api(route, post({}));
    expect(preview.status).toBe(200);
    expect(preview.body["applied"]).toBe(false);
    expect(typeof preview.body["rev"]).toBe("string");
    const applied = await t.api(route, post({ confirm: true, expectedRev: preview.body["rev"] }));
    expect(applied.status).toBe(200);
    expect(applied.body["applied"]).toBe(true);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toContain("You help briefly.");
  }, 20_000); // starts real child processes

  test("an adopted harness whose schema knows a newer setting: watch-me toggles and applies", async () => {
    const t = boot();
    const { id, dir } = await adoptedFuture(t, "watchme-adopted");
    const toggled = await t.api(
      `/api/h/${id}/memory/watchme/toggle`,
      post({ watching: true, confirm: true, confirmName: "validated", expectedRev: revOf(dir) }),
    );
    expect(toggled.status).toBe(200);
    expect(toggled.body["ok"]).toBe(true);
    expect(toggled.body["applied"]).toBe(true);
    const stamp = plantWatchmeProposal(dir);
    const applied = await t.api(
      `/api/h/${id}/memory/watchme/synthesized/${stamp}/apply`,
      post({ edits: ["agent.instructions"], confirm: true, expectedRev: revOf(dir) }),
    );
    expect(applied.status).toBe(200);
    expect(applied.body["applied"]).toBe(true);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toContain("You help, watched.");
  }, 20_000); // starts real child processes

  test("a read-only spec: the diff preview says so, and every other spec write is refused 409 read-only", async () => {
    const t = boot();
    const { id, dir } = await notAdoptedFuture(t, "future-everywhere");
    plantAdvice(dir);
    const stamp = plantWatchmeProposal(dir);
    const rev = revOf(dir);

    const diff = await t.api(
      `/api/h/${id}/spec/diff`,
      post({ edits: [{ path: "agent.instructions", value: "Hi." }] }),
    );
    expect((diff.body["readOnly"] as { paths: string[] }).paths).toEqual(["future_block"]);
    expect(diff.body["autoApplicable"]).toBe(false);

    readOnly(
      await t.api(
        `/api/h/${id}/spec/propose`,
        post({ edits: [{ path: "agent.instructions", value: "Hi." }] }),
      ),
    );
    readOnly(
      await t.api(
        `/api/h/${id}/builders/mcp`,
        post({ name: "notes", transport: "stdio", command: "cat" }),
      ),
    );
    readOnly(
      await t.api(
        `/api/h/${id}/builders/mcp`,
        post({
          name: "notes",
          transport: "stdio",
          command: "cat",
          dryRun: false,
          confirmName: "validated",
          expectedRev: rev,
        }),
      ),
    );
    readOnly(await t.api(`/api/h/${id}/builders/mcp/files`, { method: "DELETE" }));
    readOnly(await t.api(`/api/h/${id}/feedback/advice/adv_instructions/apply`, post({})));
    readOnly(
      await t.api(
        `/api/h/${id}/feedback/advice/adv_instructions/apply`,
        post({ confirm: true, expectedRev: rev }),
      ),
    );
    readOnly(
      await t.api(
        `/api/h/${id}/memory/watchme/toggle`,
        post({ watching: true, confirm: true, confirmName: "validated", expectedRev: rev }),
      ),
    );
    readOnly(
      await t.api(
        `/api/h/${id}/memory/watchme/synthesized/${stamp}/apply`,
        post({ edits: ["agent.instructions"], confirm: true, expectedRev: rev }),
      ),
    );
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(FUTURE);
  });
});

/** The variables Windows supplies to every child process, whatever environment the parent passes. */
const WINDOWS_SYSTEM_ENV = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

describe("the child check", () => {
  const silent = (): ChildHandle => ({
    stdout: new ReadableStream<Uint8Array>({ start() {} }),
    exited: new Promise<number>(() => {}),
    kill: () => {},
  });
  const answering = (text: string): ChildHandle => ({
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    exited: Promise.resolve(0),
    kill: () => {},
  });

  test("a child that never answers times out, and is killed", async () => {
    let killed = false;
    const out = await validateInHarness("/h", "name: x\n", {
      op: "issues",
      entry: "/h/node_modules/@crewhaus/spec/index.js",
      interpreter: "bun",
      spawn: () => ({
        ...silent(),
        kill: () => {
          killed = true;
        },
      }),
      timer: { set: (fn) => queueMicrotask(fn), clear: () => {} },
    });
    expect(out).toEqual({ ok: false, note: expect.stringContaining("did not answer") });
    expect(killed).toBe(true);
  });

  test("output past the cap is not read", async () => {
    const out = await validateInHarness("/h", "name: x\n", {
      op: "issues",
      entry: "/e",
      interpreter: "bun",
      maxBytes: 8,
      spawn: () => answering(JSON.stringify({ issues: [] })),
    });
    expect(out).toEqual({ ok: false, note: expect.stringContaining("more than") });
  });

  test("output that is not the answer is refused", async () => {
    const out = await validateInHarness("/h", "name: x\n", {
      op: "issues",
      entry: "/e",
      interpreter: "bun",
      spawn: () => answering("not json"),
    });
    expect(out).toEqual({ ok: false, note: expect.stringContaining("not JSON") });
  });

  test("the child is handed PATH alone, a fixed program, an empty working directory and the spec on stdin", async () => {
    const seen: Array<{
      cmd: readonly string[];
      cwd: string;
      env: Record<string, string>;
      stdin: string;
    }> = [];
    const spawn: SpawnChild = (cmd, opts) => {
      seen.push({ cmd, cwd: opts.cwd, env: opts.env, stdin: opts.stdin });
      return answering(JSON.stringify({ issues: [{ path: ["a"], message: "m", code: "c" }] }));
    };
    const out = await validateInHarness("/h", "name: sentinel-spec\n", {
      op: "issues",
      entry: "/e",
      interpreter: "bun",
      spawn,
      homeEnv: { PATH: "/usr/bin", CREWHAUS_TOKEN: "x", HOME: "/home/x" },
    });
    expect(out).toEqual({ ok: true, issues: [{ path: ["a"], message: "m", code: "c" }] });
    expect(Object.keys(seen[0]?.env ?? {})).toEqual(["PATH"]);
    expect(seen[0]?.cmd.slice(0, 4)).toEqual(["bun", "--no-env-file", "--no-install", "-e"]);
    expect(seen[0]?.cmd.join(" ")).not.toContain("sentinel-spec");
    expect(seen[0]?.stdin).toContain("sentinel-spec");
    expect(seen[0]?.cwd).not.toBe("/h");
    // The working directory is the check's own, and is gone once it answers.
    expect(existsSync(seen[0]?.cwd ?? "/h")).toBe(false);
  });

  test("a real child is given PATH alone: the harness's .env and bunfig.toml never apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-check-env-"));
    try {
      const dir = join(root, "harness");
      const pkg = join(dir, "node_modules", "@crewhaus", "spec");
      mkdirSync(pkg, { recursive: true });
      const marker = join(root, "preloaded");
      const planted = ["CREWHAUS", "HOME", "PLANTED"].join("_");
      const sentinel = ["CREWHAUS", "HOME", "ONLY"].join("_");
      writeFileSync(join(dir, ".env"), `${planted}=planted\n`);
      writeFileSync(
        join(dir, "preload.js"),
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");\n`,
      );
      writeFileSync(
        join(dir, "bunfig.toml"),
        'preload = ["./preload.js"]\n[run]\npreload = ["./preload.js"]\n',
      );
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@crewhaus/spec",
          version: "1.0.0",
          type: "module",
          main: "index.js",
        }),
      );
      const entry = join(pkg, "index.js");
      writeFileSync(
        entry,
        [
          "export function parseSpecIssues() {",
          "  return [",
          "    { path: ['env'], message: Object.keys(process.env).sort().join(','), code: 'c' },",
          "    { path: ['cwd'], message: process.cwd(), code: 'c' },",
          "  ];",
          "}",
          "",
        ].join("\n"),
      );
      const out = await validateInHarness(dir, "name: x\n", {
        op: "issues",
        entry,
        homeEnv: { PATH: process.env["PATH"] ?? "", [sentinel]: "home-only" },
      });
      expect(out.ok).toBe(true);
      const issues = out.ok ? out.issues : [];
      const seen = (issues[0]?.message ?? "").split(",");
      expect(seen).toContain("PATH");
      expect(seen).not.toContain(sentinel);
      expect(seen).not.toContain(planted);
      // Windows itself hands every child its system variables; nothing else may appear.
      const allowed = new Set(
        process.platform === "win32" ? ["PATH", ...WINDOWS_SYSTEM_ENV] : ["PATH"],
      );
      expect(seen.filter((k) => !allowed.has(k.toUpperCase()))).toEqual([]);
      expect(issues[1]?.message).not.toBe(dir);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000); // starts a real child process

  test("no interpreter is a note, never a throw", async () => {
    const out = await validateInHarness("/h", "name: x\n", {
      op: "issues",
      entry: "/e",
      interpreter: undefined,
    });
    expect(out).toEqual({ ok: false, note: expect.stringContaining("no bun interpreter") });
  });
});

describe("one security-surface table", () => {
  test("hangar-server's table is spec-patch's table", () => {
    expect(SECURITY_SURFACES).toBe(SPEC_PATCH_SURFACES);
  });
});

describe("the crewhaus a Home job runs", () => {
  const local = join("/h", "node_modules", ".bin", "crewhaus");
  const deps = {
    exists: (p: string) => p === local,
    realpath: (p: string) => (p === local ? "/h/node_modules/crewhaus/cli.js" : p),
    which: () => "/usr/local/bin/crewhaus",
  };
  const row = (extra: Record<string, unknown>) =>
    ({ dir: "/h", registeredAt: "2026-08-01T00:00:00.000Z", ...extra }) as never;

  test("a harness not adopted here runs the crewhaus on PATH", () => {
    const registry = {
      list: () => [row({})],
      adoptionSince: () => "2026-07-01T00:00:00.000Z",
    };
    expect(jobCrewhausBin(registry, "/h", deps)).toBe("/usr/local/bin/crewhaus");
  });

  test("an adopted harness runs its own contained crewhaus", () => {
    const registry = {
      list: () => [row({ home: { adoptedAt: "2026-08-02T00:00:00.000Z", by: "prn_x" } })],
      adoptionSince: () => "2026-07-01T00:00:00.000Z",
    };
    expect(jobCrewhausBin(registry, "/h", deps)).toBe(local);
  });

  test("a directory with no row runs the crewhaus on PATH", () => {
    const registry = { list: () => [], adoptionSince: () => undefined };
    expect(jobCrewhausBin(registry, "/h", deps)).toBe("/usr/local/bin/crewhaus");
  });
});
