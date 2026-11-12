/**
 * A harness's own id: `crewhaus init` gives a new harness one, `crewhaus harness adopt`
 * writes it when absent and adopts the row on this machine, `crewhaus harness fork` gives a
 * copied harness its own. A registration or a read never writes it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHarnessIdentity } from "@crewhaus/control-records";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { runHarnessCommand } from "./harness-cmd";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { root: string; env: Record<string, string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-identity-")));
  roots.push(root);
  return {
    root,
    env: {
      CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
      CREWHAUS_HANGAR_ROOT: join(root, "hangar"),
      CREWHAUS_WATCHME_ROOT: join(root, "watchme"),
    },
  };
}

function harnessAt(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "crewhaus.yaml"), `name: ${name}\ntarget: channel\n`);
  return dir;
}

describe("crewhaus harness adopt", () => {
  test("registers, writes harness.json with the row's id, and records home", async () => {
    const { root, env } = workspace();
    const dir = harnessAt(root, "bot");
    const out = await runHarnessCommand(["adopt", dir, "--slug", "Support Bot"], { env });
    expect(out.exitCode).toBe(0);
    const row = openHangarRegistry({ env }).get(dir);
    const identity = readHarnessIdentity(dir);
    expect(identity.state === "present" && identity.identity.id).toBe(row?.id as string);
    expect(row?.home?.by).toMatch(/^local:#[0-9a-f]{64}$|^prn_/);
    expect(row?.slug).toBe("support-bot");
    expect(out.lines[0]).toContain("a group start includes it");
  });

  test("a registration alone never writes harness.json", async () => {
    const { root, env } = workspace();
    const dir = harnessAt(root, "bot");
    await runHarnessCommand(["add", dir], { env });
    await runHarnessCommand(["show", dir], { env });
    expect(existsSync(join(dir, ".crewhaus", "run", "control", "harness.json"))).toBe(false);
  });
});

describe("crewhaus harness fork", () => {
  test("a copied harness gets its own id and is registered under it", async () => {
    const { root, env } = workspace();
    const original = harnessAt(root, "bot");
    await runHarnessCommand(["adopt", original], { env });
    const copy = join(root, "bot-copy");
    cpSync(original, copy, { recursive: true });
    const before = readHarnessIdentity(copy);
    const out = await runHarnessCommand(["fork", copy], { env });
    expect(out.exitCode).toBe(0);
    const after = readHarnessIdentity(copy);
    if (before.state !== "present" || after.state !== "present") throw new Error("no identity");
    expect(after.identity.id).not.toBe(before.identity.id);
    expect(openHangarRegistry({ env }).get(copy)?.id).toBe(after.identity.id);
  });
});

describe("crewhaus init", () => {
  test("writes harness.json for the harness it creates", async () => {
    const { root, env } = workspace();
    const proc = Bun.spawn([process.execPath, "--no-install", CLI_PATH, "init", "fresh"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env, CREWHAUS_NO_REGISTRY: "1" },
    });
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0);
    const identity = readHarnessIdentity(join(root, "fresh"));
    expect(identity.state === "present" && identity.identity.id).toMatch(/^hrn_[0-9a-f]{16}$/);
  }, 60_000);
});
