/**
 * Unit tests for the `crewhaus harness` verb family (Hangar M1).
 *
 * Every test runs against a temp registry root injected through the module's
 * `env` option (the registry reads CREWHAUS_REGISTRY_ROOT /
 * CREWHAUS_WATCHME_ROOT / CREWHAUS_NO_REGISTRY from the INJECTED env
 * exclusively), so nothing here can touch the real `~/.crewhaus`. No
 * subprocesses, no network; the preflight verb runs against the same
 * injected env so its credential checks are deterministic.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HarnessCommandResult, runHarnessCommand } from "./harness-cmd";

let root: string;
let regRoot: string;
let watchmeRoot: string;
let env: Record<string, string | undefined>;

const FIXED_NOW = Date.parse("2026-08-01T00:00:00.000Z");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-harness-cmd-"));
  regRoot = join(root, "registry-root");
  watchmeRoot = join(root, "watchme-root");
  env = { CREWHAUS_REGISTRY_ROOT: regRoot, CREWHAUS_WATCHME_ROOT: watchmeRoot };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(argv: readonly string[]): Promise<HarnessCommandResult> {
  return runHarnessCommand(argv, { env, now: () => FIXED_NOW });
}

/** Seed a harness dir carrying a parseable cli spec. */
function seedHarness(rel: string, name = "alpha", model = "claude-sonnet-4-6"): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "crewhaus.yaml"),
    `name: ${name}\ntarget: cli\nagent:\n  model: ${model}\n  instructions: help\n`,
  );
  return dir;
}

/** The registered entry's id, fished out of `list --json`. */
async function idOf(dir: string): Promise<string> {
  const out = await run(["list", "--json"]);
  const rows = JSON.parse(out.lines.join("\n")) as Array<{ id: string; dir: string }>;
  const row = rows.find((r) => r.dir === dir);
  if (row === undefined) throw new Error(`no registry row for ${dir}`);
  return row.id;
}

describe("harness dispatch + help", () => {
  test("no verb / --help print usage, exit 0", async () => {
    for (const argv of [[], ["--help"], ["-h"]]) {
      const out = await run(argv);
      expect(out.exitCode).toBe(0);
      expect(out.lines[0]).toBe("usage:");
      expect(out.lines.join("\n")).toContain("harness preflight");
    }
  });

  test("unknown verb throws with the verb list", () => {
    expect(run(["bogus"])).rejects.toThrow(/unknown harness verb "bogus".*list \| show \| add/);
  });

  test("unknown flag and missing positional throw", async () => {
    expect(run(["list", "--nope"])).rejects.toThrow(/unknown flag "--nope"/);
    expect(run(["show"])).rejects.toThrow(/a <dir\|hrn_id> argument is required/);
  });
});

describe("harness add / list / remove", () => {
  test("add registers with origin manual and list joins the spec header", async () => {
    const dir = seedHarness("alpha");
    const added = await run(["add", dir]);
    expect(added.exitCode).toBe(0);
    expect(added.lines.join("\n")).toMatch(/registered alpha \(hrn_[0-9a-f]{16}\) at /);

    const list = await run(["list"]);
    const text = list.lines.join("\n");
    expect(text).toContain("1 registered harness(es)");
    expect(text).toContain(`• alpha  (${dir})`);
    expect(text).toContain("shape=cli model=claude-sonnet-4-6");
    expect(text).toContain("origin=manual/harness add");

    const json = JSON.parse((await run(["list", "--json"])).lines.join("\n")) as Array<{
      specName: string;
      origin: string;
      header: { model?: string } | null;
    }>;
    expect(json).toHaveLength(1);
    expect(json[0]?.specName).toBe("alpha");
    expect(json[0]?.origin).toBe("manual");
    expect(json[0]?.header?.model).toBe("claude-sonnet-4-6");
  });

  test("re-adding refreshes instead of duplicating", async () => {
    const dir = seedHarness("alpha");
    await run(["add", dir]);
    const again = await run(["add", dir]);
    expect(again.lines.join("\n")).toMatch(/^refreshed alpha /);
    const json = JSON.parse((await run(["list", "--json"])).lines.join("\n")) as unknown[];
    expect(json).toHaveLength(1);
  });

  test("add without a readable spec warns but registers (warn-not-fail)", async () => {
    const dir = join(root, "specless");
    mkdirSync(dir, { recursive: true });
    const out = await run(["add", dir]);
    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toContain("⚠ no readable crewhaus.yaml");
    expect(out.lines.join("\n")).toMatch(/registered specless \(hrn_/);
  });

  test("add refuses a non-directory", () => {
    expect(run(["add", join(root, "nope")])).rejects.toThrow(/no directory at /);
  });

  test("empty list points at add/scan", async () => {
    const out = await run(["list"]);
    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toContain("no harnesses registered");
    expect(out.lines[0]).toContain("harness scan --root");
  });

  test("remove by id drops the row only and says so; unknown key throws", async () => {
    const dir = seedHarness("alpha");
    await run(["add", dir]);
    const id = await idOf(dir);
    const out = await run(["remove", id]);
    expect(out.lines[0]).toContain("removed alpha");
    expect(out.lines[0]).toContain("the directory itself is untouched");
    expect(existsSync(join(dir, "crewhaus.yaml"))).toBe(true);
    expect((await run(["list"])).lines[0]).toContain("no harnesses registered");
    expect(run(["remove", id])).rejects.toThrow(/no registered harness matches/);
  });

  test("a vanished dir renders the missing note, never auto-prunes", async () => {
    const dir = seedHarness("gone", "gone");
    await run(["add", dir]);
    rmSync(dir, { recursive: true, force: true });
    const text = (await run(["list"])).lines.join("\n");
    expect(text).toContain("• gone");
    expect(text).toMatch(/⚠ missing since .* — relocate or remove/);
  });
});

describe("harness show", () => {
  test("renders entry + inventory + health for a live harness", async () => {
    const dir = seedHarness("alpha");
    await run(["add", dir]);
    const out = await run(["show", dir]);
    const text = out.lines.join("\n");
    expect(out.exitCode).toBe(0);
    expect(text).toContain(`• alpha  (${dir})`);
    expect(text).toContain("registry=unregistered  pins: no pins");
    expect(text).toContain("last eval: none recorded");
    expect(text).toContain("sessions=0  feedback=0");
    expect(text).toContain("health ✓: unregistered  eval:ok");
    expect(text).toContain("eval: no runs recorded");

    const json = JSON.parse((await run(["show", dir, "--json"])).lines.join("\n")) as {
      entry: { specName: string };
      inventory: { specName: string } | null;
      health: { evalHealthy: boolean } | null;
    };
    expect(json.entry.specName).toBe("alpha");
    expect(json.inventory?.specName).toBe("alpha");
    expect(json.health?.evalHealthy).toBe(true);
  });

  test("names the env files the harness reads, shared ones with their resolved path", async () => {
    const dir = seedHarness("fleet/member", "member");
    writeFileSync(join(root, "fleet", ".env"), "SHARED=1\n");
    writeFileSync(join(dir, ".env"), "LOCAL=1\n");
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "settings.json"),
      JSON.stringify({ manager: { envFiles: ["../.env"] } }),
    );
    await run(["add", dir]);
    const text = (await run(["show", dir])).lines.join("\n");
    expect(text).toContain("env files (lowest precedence first");
    expect(text).toContain(`../.env → ${join(root, "fleet", ".env")}  [shared]`);
    // The file list, never a value.
    expect(text).not.toContain("SHARED=1");

    const json = JSON.parse((await run(["show", dir, "--json"])).lines.join("\n")) as {
      envFiles: Array<{ declaredAs: string; scope: string }>;
    };
    expect(json.envFiles.map((r) => r.declaredAs)).toEqual(["../.env", ".env"]);
  });

  test("names the operator hooks a supervised start will run", async () => {
    const dir = seedHarness("alpha");
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "settings.json"),
      JSON.stringify({ manager: { hooks: { preSpawn: "./prep.sh" } } }),
    );
    await run(["add", dir]);
    const text = (await run(["show", dir])).lines.join("\n");
    expect(text).toContain("hook preSpawn: `./prep.sh` · never run");

    const json = JSON.parse((await run(["show", dir, "--json"])).lines.join("\n")) as {
      hooks: Array<{ name: string; declaredAs: string }>;
    };
    expect(json.hooks).toEqual([{ name: "preSpawn", declaredAs: "./prep.sh" }]);
  });

  test("a harness with no env files grows no env section", async () => {
    const dir = seedHarness("alpha");
    await run(["add", dir]);
    expect((await run(["show", dir])).lines.join("\n")).not.toContain("env files (");
  });

  test("a missing-dir entry shows without inventory/health", async () => {
    const dir = seedHarness("gone", "gone");
    await run(["add", dir]);
    rmSync(dir, { recursive: true, force: true });
    const text = (await run(["show", dir])).lines.join("\n");
    expect(text).toContain("relocate or remove");
    expect(text).not.toContain("last eval:");
  });
});

describe("harness relocate", () => {
  test("points the same id at the new dir", async () => {
    const dirA = seedHarness("alpha");
    await run(["add", dirA]);
    const id = await idOf(dirA);
    const dirB = seedHarness("moved/alpha");
    const out = await run(["relocate", id, dirB]);
    expect(out.lines[0]).toBe(`relocated alpha (${id}): ${dirA} → ${dirB}`);
    expect(await idOf(dirB)).toBe(id);
  });

  test("refuses a dir already registered to another entry", async () => {
    const dirA = seedHarness("alpha");
    const dirB = seedHarness("beta", "beta");
    await run(["add", dirA]);
    await run(["add", dirB]);
    const id = await idOf(dirA);
    expect(run(["relocate", id, dirB])).rejects.toThrow(/already registered/);
  });

  test("refuses a nonexistent target dir", async () => {
    const dirA = seedHarness("alpha");
    await run(["add", dirA]);
    const id = await idOf(dirA);
    expect(run(["relocate", id, join(root, "void")])).rejects.toThrow(/no directory at /);
  });
});

describe("harness group / tag / pin", () => {
  test("bare group creates; membership add/remove; list --group filters", async () => {
    const dirA = seedHarness("alpha");
    const dirB = seedHarness("beta", "beta");
    await run(["add", dirA]);
    await run(["add", dirB]);

    const created = await run(["group", "blue", "--color", "#00f"]);
    expect(created.lines[0]).toBe("group blue created (order 1, color #00f)");

    await run(["group", "blue", "--add", dirA]);
    const scoped = (await run(["list", "--group", "blue"])).lines.join("\n");
    expect(scoped).toContain("• alpha");
    expect(scoped).not.toContain("• beta");
    expect(scoped).toContain("groups: blue");

    const removed = await run(["group", "blue", "--remove", dirA]);
    expect(removed.lines.join("\n")).toContain("removed alpha");
    expect((await run(["list", "--group", "blue"])).lines[0]).toContain(
      'no harnesses registered in group "blue"',
    );
  });

  test("--add and --remove together are refused; --order reorders", async () => {
    expect(run(["group", "g", "--add", "x", "--remove", "y"])).rejects.toThrow(
      /--add and --remove are mutually exclusive/,
    );
    await run(["group", "blue"]);
    await run(["group", "green"]);
    const moved = await run(["group", "green", "--order", "1"]);
    expect(moved.lines.join("\n")).toContain("group green moved to position 1");
    expect(run(["group", "blue", "--order", "zero"])).rejects.toThrow(/positive integer/);
  });

  test("tag add/remove round-trips and requires exactly one direction", async () => {
    const dir = seedHarness("alpha");
    await run(["add", dir]);
    expect(run(["tag", dir])).rejects.toThrow(/exactly one of --add/);
    await run(["tag", dir, "--add", "prod"]);
    expect((await run(["list"])).lines.join("\n")).toContain("tags: prod");
    const dup = await run(["tag", dir, "--add", "prod"]);
    expect(dup.lines[0]).toContain("already carries tag prod");
    await run(["tag", dir, "--remove", "prod"]);
    expect((await run(["list"])).lines.join("\n")).not.toContain("tags: prod");
  });

  test("pin / pin --off toggle the flag", async () => {
    const dir = seedHarness("alpha");
    await run(["add", dir]);
    await run(["pin", dir]);
    expect((await run(["list"])).lines.join("\n")).toContain("pinned");
    await run(["pin", dir, "--off"]);
    expect((await run(["list"])).lines.join("\n")).not.toContain("pinned");
  });
});

describe("harness scan", () => {
  test("--root discovers + upserts (origin scan), remembers the root, counts", async () => {
    seedHarness("fleet/a");
    seedHarness("fleet/nested/b", "beta");
    const scanRoot = join(root, "fleet");

    const first = await run(["scan", "--root", scanRoot]);
    expect(first.lines.join("\n")).toContain("scan: 2 added, 0 refreshed, 0 missing (1 root(s))");
    const json = JSON.parse((await run(["list", "--json"])).lines.join("\n")) as Array<{
      origin: string;
      originDetail: string;
    }>;
    expect(json).toHaveLength(2);
    expect(json.every((e) => e.origin === "scan" && e.originDetail === scanRoot)).toBe(true);

    // The root was remembered as a scan root: a bare re-scan covers it.
    const second = await run(["scan"]);
    expect(second.lines.join("\n")).toContain("scan: 0 added, 2 refreshed, 0 missing");

    // A vanished registered dir counts as missing (stamped, never pruned).
    rmSync(join(scanRoot, "nested"), { recursive: true, force: true });
    const third = await run(["scan"]);
    expect(third.lines.join("\n")).toContain("scan: 0 added, 1 refreshed, 1 missing");
  });

  test("bare scan with no configured roots is loud", () => {
    expect(run(["scan"])).rejects.toThrow(/no scan roots configured — pass --root/);
  });
});

describe("harness preflight", () => {
  test("missing provider credentials block: ✗ rendering + exit 1", async () => {
    const dir = seedHarness("alpha");
    await run(["add", dir]);
    const out = await run(["preflight", dir]);
    expect(out.exitCode).toBe(1);
    const text = out.lines.join("\n");
    expect(text).toContain(`preflight alpha (${dir}):`);
    expect(text).toContain("✓ crewhaus.yaml parses cleanly");
    expect(text).toMatch(/✗ will not boot: no Anthropic credentials/);
    expect(text).toContain("fix: set ANTHROPIC_AUTH_TOKEN");
    expect(text).toMatch(/\d+ check\(s\), 1 blocking — fix the ✗ items/);
  });

  test("satisfied credentials pass: exit 0 + json shape", async () => {
    const dir = seedHarness("alpha");
    env["ANTHROPIC_API_KEY"] = "unit-test-credential";
    const out = await run(["preflight", dir]);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toContain("no blocking findings");

    const json = JSON.parse((await run(["preflight", dir, "--json"])).lines.join("\n")) as {
      ok: boolean;
      blocking: unknown[];
    };
    expect(json.ok).toBe(true);
    expect(json.blocking).toHaveLength(0);
  });

  test("checks the MERGED spawn env: a credential in the harness .env satisfies it", async () => {
    // The verb used to check `process.env` alone, so a key the daemon reads
    // from `.env` was reported as missing — preflight disagreeing with the
    // spawn, in the direction that cries wolf.
    const dir = seedHarness("alpha");
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=from-env-file\n");
    const out = await run(["preflight", dir]);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toContain("harness env file .env");
  });

  test("a shared fleet env file satisfies credentials and is named in the report", async () => {
    const dir = seedHarness("fleet/member", "member");
    writeFileSync(join(root, "fleet", ".env"), "ANTHROPIC_API_KEY=fleet-key\n");
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "settings.json"),
      JSON.stringify({ manager: { envFiles: ["../.env"] } }),
    );
    const out = await run(["preflight", dir]);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toContain('shared env file "../.env"');
  });

  test("a declared-but-absent shared env file warns without blocking the spawn", async () => {
    const dir = seedHarness("fleet/member", "member");
    env["ANTHROPIC_API_KEY"] = "unit-test-credential";
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "settings.json"),
      JSON.stringify({ manager: { envFiles: ["../.env"] } }),
    );
    const out = await run(["preflight", dir]);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toMatch(/⚠ shared env file "\.\.\/\.env" is declared/);
  });

  test("discloses the operator hooks the spawn will run", async () => {
    const dir = seedHarness("alpha");
    env["ANTHROPIC_API_KEY"] = "unit-test-credential";
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "settings.json"),
      JSON.stringify({ manager: { hooks: { preSpawn: ["bun", "run", "prep.ts"] } } }),
    );
    const out = await run(["preflight", dir]);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toContain("preSpawn hook will run: `bun run prep.ts`");
  });

  test("an unregistered key that is not a directory throws", () => {
    expect(run(["preflight", "hrn_0000000000000000"])).rejects.toThrow(
      /no registered harness \(or directory\) matches/,
    );
  });
});

describe("CREWHAUS_NO_REGISTRY", () => {
  test("mutating verbs say writes are disabled and persist nothing", async () => {
    const dir = seedHarness("alpha");
    env["CREWHAUS_NO_REGISTRY"] = "1";
    const out = await run(["add", dir]);
    expect(out.lines.join("\n")).toContain("CREWHAUS_NO_REGISTRY is set");
    expect(existsSync(join(regRoot, "harnesses.json"))).toBe(false);
    expect((await run(["list"])).lines[0]).toContain("no harnesses registered");
  });
});
