/**
 * `crewhaus inbox list|show|stats`: the bare verb lists; `--json` is the list Home's API
 * answers; a harness whose sessions folder lies outside it is named, beside the others'
 * items or alone; what a harness sent is shown masked; an unknown item says which
 * command lists what is open; and nothing is written, created or touched while reading.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
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
import { join } from "node:path";
import { mintRunId } from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import { append, runsLedger } from "@crewhaus/control-records";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import {
  createPendingApprovalStore,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { SHOW_NEEDS_ONE, runInboxCommand } from "./inbox-cmd";

type Schema = { safeParse(value: unknown): { success: boolean; error?: unknown } };
const schemaOf = (id: string) => (SCHEMAS as unknown as Readonly<Record<string, Schema>>)[id];

/** A value shaped like a credential, built from parts, under a key the masker hides. */
const CANARY = ["thz", "live", "k".repeat(28)].join("_");
const NOW = Date.parse("2026-11-10T12:00:00.000Z");

let base: string;
let env: Record<string, string>;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-inbox-cmd-")));
  env = {
    CREWHAUS_HANGAR_ROOT: join(base, "hangar"),
    CREWHAUS_REGISTRY_ROOT: join(base, "registry"),
    CREWHAUS_WATCHME_ROOT: join(base, "watchme"),
    HOME: base,
  };
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A registered harness folder with a spec. */
function harness(name: string): { id: string; dir: string } {
  const dir = join(base, "harnesses", name);
  mkdirSync(join(dir, ".crewhaus", "sessions"), { recursive: true });
  writeFileSync(
    join(dir, "crewhaus.yaml"),
    `name: ${name}\ntarget: cli\nagent:\n  model: claude-opus-5\n  instructions: help\n`,
  );
  const entry = openHangarRegistry({ env }).upsert({ dir, specName: name, target: "cli" });
  return { id: entry.id, dir };
}

/** One pending request, through the store's own writer. */
async function park(dir: string, input: unknown): Promise<string> {
  const store = createPendingApprovalStore({
    rootDir: join(dir, ".crewhaus", "sessions"),
    now: () => new Date(NOW - 600_000),
  });
  const id = generateApprovalId();
  await store.persist({
    id,
    toolName: "SendMessage",
    inputHash: hashApprovalInput("SendMessage", input),
    input,
    runId: mintRunId({ now: NOW - 600_000 }),
    sessionId: `sess_${"a".repeat(16)}`,
    surface: "daemon",
    createdAt: new Date(NOW - 600_000).toISOString(),
  } as never);
  return id;
}

function failRun(dir: string): void {
  const id = mintRunId({ now: NOW - 60_000 });
  const trigger = { kind: "api" };
  for (const row of [
    { id, state: "running", at: new Date(NOW - 120_000).toISOString(), trigger },
    {
      id,
      state: "failed",
      at: new Date(NOW - 60_000).toISOString(),
      trigger,
      failureClass: "auth",
    },
  ]) {
    const written = append(runsLedger(dir), row);
    if (!written.ok) throw new Error(written.reason);
  }
}

/** Every path under `root` with its bytes and mtime, for a no-write check. */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        out[`${path}/`] = String(st.mtimeMs);
        walk(path);
      } else out[path] = `${readFileSync(path).toString("base64")}@${st.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

const run = (argv: readonly string[]) => runInboxCommand(argv, { env, now: () => NOW });

describe("crewhaus inbox", () => {
  test("the bare verb lists by band, with the command that shows each item", async () => {
    const a = harness("alpha");
    await park(a.dir, { channel: "ops", text: "ship it" });
    failRun(a.dir);
    const bare = await run([]);
    const listed = await run(["list"]);
    expect(bare).toEqual(listed);
    expect(bare.exitCode).toBe(0);
    const text = bare.lines.join("\n");
    expect(text.indexOf("Decide")).toBeGreaterThan(-1);
    expect(text.indexOf("Fix")).toBeGreaterThan(text.indexOf("Decide"));
    expect(text).toContain("Permission to use SendMessage");
    expect(text).toContain("crewhaus approvals grant appr_");
    expect(text).toContain("alpha");
  });

  test("--json is the list Home's API answers, with what a harness sent masked", async () => {
    const a = harness("alpha");
    await park(a.dir, { channel: "ops", api_key: CANARY });
    const out = await run(["list", "--json"]);
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.lines.join("\n"));
    expect(schemaOf("attentionList")?.safeParse(body).success).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].body.input.api_key).toBe("[redacted]");
    expect(body.items[0].body.input.channel).toBe("ops");
    expect(out.lines.join("\n")).not.toContain(CANARY);
    expect(body.names).toEqual([{ id: a.id, name: "alpha" }]);
  });

  test("filters by band and kind, and refuses a word that is neither", async () => {
    const a = harness("alpha");
    await park(a.dir, { text: "x" });
    failRun(a.dir);
    const fix = JSON.parse((await run(["list", "--band", "fix", "--json"])).lines.join("\n"));
    expect(fix.items.map((i: { band: string }) => i.band)).toEqual(["fix"]);
    const kind = JSON.parse((await run(["--kind", "review", "--json"])).lines.join("\n"));
    expect(kind.items).toEqual([]);
    expect(kind.empty.reason).toBe("filtered");
    expect((await run(["list", "--band", "urgent"])).exitCode).toBe(55);
    expect((await run(["list", "--kind", "nope"])).exitCode).toBe(55);
    await expect(run(["nope"])).rejects.toThrow("(expected: list | show | stats)");
  });

  test("a harness whose sessions folder lies outside it is named, beside others' items or alone", async () => {
    const a = harness("linked");
    const b = harness("parked");
    await park(b.dir, { text: "x" });
    rmSync(join(a.dir, ".crewhaus", "sessions"), { recursive: true, force: true });
    symlinkSync(join(b.dir, ".crewhaus", "sessions"), join(a.dir, ".crewhaus", "sessions"));
    const both = JSON.parse((await run(["list", "--json"])).lines.join("\n"));
    expect(both.unreachable).toEqual([a.id]);
    expect(both.items.map((i: { harness: string }) => i.harness)).toEqual([b.id]);
    const alone = await run(["list", "--harness", "linked"]);
    expect(alone.exitCode).toBe(0);
    expect(alone.lines.join("\n")).toContain(
      "Couldn't read the requests of linked: its sessions folder is outside its folder.",
    );
    const json = JSON.parse((await run(["list", "--harness", a.id, "--json"])).lines.join("\n"));
    expect(json.items).toEqual([]);
    expect(json.unreachable).toEqual([a.id]);
    expect(json.empty.reason).toBe("unreachable");
  });

  test("show reads one item by its id or its ref; an unknown one names the list command", async () => {
    const a = harness("alpha");
    await park(a.dir, { text: "x" });
    const listed = JSON.parse((await run(["--json"])).lines.join("\n"));
    const ref = listed.items[0].ref as string;
    const id = ref.slice(ref.lastIndexOf("/") + 1);
    for (const asked of [id, ref]) {
      const shown = await run(["show", asked, "--json"]);
      expect(shown.exitCode).toBe(0);
      expect(JSON.parse(shown.lines.join("\n")).ref).toBe(ref);
    }
    const unknown = await run(["show", `att_${"0".repeat(26)}`]);
    expect(unknown.exitCode).toBe(56);
    expect(unknown.lines.join("\n")).toContain("crewhaus inbox list");
    const none = await run(["show"]);
    expect(none.exitCode).toBe(55);
    expect(none.lines).toEqual([SHOW_NEEDS_ONE]);
  });

  test("stats counts what is open and how long it waited", async () => {
    const a = harness("alpha");
    await park(a.dir, { text: "x" });
    const out = await run(["stats", "--json"]);
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.lines.join("\n"));
    expect(schemaOf("attentionMetrics")?.safeParse(body).success).toBe(true);
    expect(body.open).toEqual([{ kind: "permission", open: 1, p50Ms: 600_000, p90Ms: 600_000 }]);
    expect((await run(["stats", "--since", "forever"])).exitCode).toBe(55);
  });

  test("an empty inbox exits 0 and says so", async () => {
    harness("quiet");
    const out = await run([]);
    expect(out).toEqual({
      lines: [
        "Nothing needs you right now.",
        "Advisor findings appear after Home has checked a harness.",
      ],
      exitCode: 0,
    });
  });

  test("reading writes, creates and touches nothing", async () => {
    const a = harness("alpha");
    await park(a.dir, { text: "x" });
    failRun(a.dir);
    const before = treeOf(base);
    await run(["list"]);
    await run(["list", "--json", "--all"]);
    await run(["stats"]);
    const listed = JSON.parse((await run(["--json"])).lines.join("\n"));
    await run(["show", listed.items[0].ref]);
    expect(treeOf(base)).toEqual(before);
  });

  test("through the binary's dispatch, reading touches nothing either", async () => {
    const a = harness("alpha");
    await park(a.dir, { text: "x" });
    failRun(a.dir);
    // Bun keeps its own cache under HOME; the harnesses and Home's records are what count.
    const records = () => ({
      harnesses: treeOf(join(base, "harnesses")),
      registry: treeOf(join(base, "registry")),
      hangar: existsSync(join(base, "hangar")),
    });
    const before = records();
    const cli = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "index.ts");
    const outputs: string[] = [];
    for (const args of [
      ["inbox", "--json"],
      ["inbox", "stats"],
      ["inbox", "show", "nope"],
    ]) {
      const proc = Bun.spawn([process.execPath, cli, ...args], {
        cwd: base,
        env: { ...env, PATH: process.env["PATH"] ?? "" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      outputs.push(`${args.join(" ")}: ${code}`);
      if (args[1] === "--json") {
        const kinds = JSON.parse(stdout).items.map((i: { kind: string }) => i.kind);
        expect(kinds).toContain("permission");
      }
      if (args[1] === "show") expect(stderr).toContain("inbox show: name an item");
    }
    expect(outputs).toEqual(["inbox --json: 0", "inbox stats: 0", "inbox show nope: 55"]);
    expect(records()).toEqual(before);
  }, 30_000); // three CLI processes, each loading the whole entry file; slow on a loaded runner
});
