/**
 * `crewhaus deploy approve`: one person's answer to a protected environment's approval,
 * recorded once under a receipt and, when it is an approval, in the file every gate reads;
 * the version that is waiting is the one answered when none is named; and every refusal is
 * made before anything is written.
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_FOR_ERROR } from "@crewhaus/control-contract";
import { casAppend, deploymentsLedger, readDeployQuorums } from "@crewhaus/control-records";
import { openQuorumDecision } from "@crewhaus/deployment-controller/quorum";
import { parseArgs } from "@crewhaus/infra-utils";
import { specRevision } from "@crewhaus/ir/policy";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import { AGENT_TOOL_ENV } from "./approvals-cmd";
import { DEPLOY_APPROVE_SCHEMA } from "./arg-schemas";
import {
  DEPLOY_APPROVE_AGENT_REFUSAL,
  DEPLOY_APPROVE_USAGE,
  deployApprove,
} from "./deploy-approve-cmd";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const TEXT = "name: demo\ntarget: cli\nagent:\n  model: claude-opus-5\n  instructions: help\n";
const HASH = specRevision(TEXT);

let base: string;
let dir: string;
let env: Record<string, string>;

function put(rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-deploy-approve-")));
  dir = join(base, "demo");
  mkdirSync(dir);
  env = {
    CREWHAUS_HANGAR_ROOT: join(base, "hangar"),
    CREWHAUS_REGISTRY_ROOT: join(base, "registry"),
    CREWHAUS_NO_REGISTRY: "1",
  };
  put("crewhaus.yaml", TEXT);
  put(
    ".crewhaus/environments.json",
    JSON.stringify({ environments: { prod: { requireApproval: true, minApprovals: 2 } } }),
  );
  const registry = createFileBackedRegistry({ rootDir: join(dir, ".crewhaus", "specs") });
  await registry.put("demo", "1.0.0", TEXT);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const as = (username: string) => ({ username, hostname: "box" });

const approve = (argv: readonly string[], who = "alice", over: Record<string, string> = {}) =>
  deployApprove(parseArgs([...argv], DEPLOY_APPROVE_SCHEMA), {
    env: { ...env, ...over },
    cwd: dir,
    now: () => NOW,
    identity: as(who),
  });

const ask = (version = "1.0.0", specHash = HASH, environment = "prod") =>
  openQuorumDecision(dir, { spec: "demo", environment, version, specHash }, { now: NOW - 60_000 });

const rows = () => {
  const read = readDeployQuorums(dir);
  return read.state === "present" ? read.rows : [];
};

const recorded = (): Array<Record<string, unknown>> => {
  const path = join(dir, ".crewhaus", "approvals", "demo__prod.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
};

function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) {
        out[`${path}/`] = "";
        walk(path);
      } else out[path] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}

describe("crewhaus deploy approve", () => {
  test("answers the version that is waiting; two people meet a quorum of two, one person once", async () => {
    await ask();
    const first = await approve(["demo", "--env", "prod"]);
    expect(first.exitCode).toBe(0);
    expect(first.lines[0]).toBe("Approved: demo 1.0.0 for prod. 1 of 2 approvals are recorded.");
    expect(rows().map((r) => r.state)).toEqual(["pending"]);

    const again = await approve(["demo", "--env", "prod"]);
    expect(again.exitCode).toBe(EXIT_FOR_ERROR.already_decided);
    expect(again.lines[0]).toBe("deploy approve: you already answered this");
    expect(recorded()).toHaveLength(1);

    const second = await approve(["demo", "--env", "prod"], "bob");
    expect(second.exitCode).toBe(0);
    expect(second.lines.slice(0, 2)).toEqual([
      "Approved: demo 1.0.0 for prod. It has its approvals (2 of 2).",
      "  next: crewhaus spec pin demo prod 1.0.0",
    ]);
    expect(rows().map((r) => r.state)).toEqual(["granted"]);
    const entries = recorded();
    expect(entries.map((e) => [e["approver"], e["version"], e["specHash"]])).toEqual([
      ["alice", "1.0.0", HASH],
      ["bob", "1.0.0", HASH],
    ]);
    // Who they are is a keyed digest, not a name.
    expect(new Set(entries.map((e) => e["principal"])).size).toBe(2);
    for (const e of entries) expect(String(e["principal"])).toMatch(/^local:#[0-9a-f]{64}$/);
  });

  test("a registered version can be answered before a move asks for it", async () => {
    const out = await approve(["demo", "--env", "prod", "--version", "1.0.0", "--json"]);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.lines.join("\n"))).toMatchObject({
      subject: { spec: "demo", environment: "prod", version: "1.0.0", specHash: HASH },
      choice: "approve",
      state: "pending",
      approvals: 1,
      required: 2,
    });
    expect(rows()).toHaveLength(1);
  });

  test("a deny refuses it and adds nothing to the approvals file", async () => {
    await ask();
    const out = await approve(["demo", "--env", "prod", "--deny"]);
    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toBe("Refused: demo 1.0.0 for prod.");
    expect(rows().map((r) => r.state)).toEqual(["denied"]);
    expect(existsSync(join(dir, ".crewhaus", "approvals"))).toBe(false);
    const late = await approve(["demo", "--env", "prod", "--version", "1.0.0"], "bob");
    expect(late.exitCode).toBe(EXIT_FOR_ERROR.already_decided);
    expect(late.lines[0]).toBe("deploy approve: it was already settled (denied)");
  });

  test("a build is approved by its record's content, and moved by activating it", async () => {
    const dep = `dep_01${"0".repeat(24)}`;
    const hash = `sha256:${"d".repeat(64)}`;
    await casAppend(deploymentsLedger(dir), dep, null, {
      id: dep,
      state: "prepared",
      artifact: { digest: `sha256:${"e".repeat(64)}`, specHash: hash, entry: "dist/daemon.ts" },
    });
    await ask(dep, hash);
    await approve(["demo", "--env", "prod"]);
    const out = await approve(["demo", "--env", "prod"], "bob");
    expect(out.lines[1]).toBe(`  next: crewhaus deploy activate ${dep} --environment prod`);
  });

  test("a version that is waiting and not registered yet is answered for what was refused", async () => {
    const hash = `sha256:${"c".repeat(64)}`;
    await ask("2.0.0-rc", hash);
    const out = await approve(["demo", "--env", "prod", "--json"]);
    expect(JSON.parse(out.lines.join("\n")).subject.specHash).toBe(hash);
  });

  test("the receipt names who and the harness, and the decision is under it", async () => {
    await ask();
    const out = await approve(["demo", "--env", "prod"]);
    const receipt = out.lines.at(-1)?.replace("  receipt ", "");
    const at = join(dir, ".crewhaus", "run", "control", "commands");
    const lines = readdirSync(at)
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) => readFileSync(join(at, n), "utf8").trim().split("\n"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r["id"] === receipt);
    expect(lines.some((l) => l["kind"] === "deployments.approve")).toBe(true);
    expect(lines.at(-1)?.["state"]).toBe("succeeded");
    expect(JSON.stringify(lines)).not.toContain("alice");
  });

  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly argv: readonly string[];
    readonly setUp?: () => Promise<unknown>;
    readonly env?: Record<string, string>;
    readonly code: keyof typeof EXIT_FOR_ERROR;
    readonly says: string;
  }> = [
    {
      name: "nothing waiting and no version named",
      argv: ["demo", "--env", "prod"],
      code: "not_found",
      says: "nothing of demo is waiting for prod",
    },
    {
      name: "several versions waiting and none named",
      argv: ["demo", "--env", "prod"],
      setUp: async () => {
        await ask();
        await ask("2.0.0", `sha256:${"c".repeat(64)}`);
      },
      code: "invalid",
      says: "several versions are waiting",
    },
    {
      name: "a version nobody has",
      argv: ["demo", "--env", "prod", "--version", "9.9.9"],
      code: "not_found",
      says: "no version 9.9.9 of demo here",
    },
    {
      name: "an environment nobody protects",
      argv: ["demo", "--env", "staging", "--version", "1.0.0"],
      code: "conflict",
      says: "staging is not a protected environment",
    },
    {
      name: "no environment",
      argv: ["demo"],
      code: "invalid",
      says: "name the environment with --env",
    },
    {
      name: "a name that is no spec's",
      argv: ["../demo", "--env", "prod"],
      code: "invalid",
      says: "name the spec",
    },
    {
      name: "a version that reads as a flag",
      argv: ["demo", "--env", "prod", "--version", "a/b"],
      code: "invalid",
      says: "--version is a registered version",
    },
    {
      name: "a harness whose approver list cannot be read",
      argv: ["demo", "--env", "prod"],
      setUp: async () => {
        await ask();
        put(".crewhaus/run/control/approvers.json", "{ torn");
      },
      code: "forbidden",
      says: "list of who may approve cannot be read",
    },
    {
      name: "a command an agent's tool started",
      argv: ["demo", "--env", "prod"],
      setUp: () => ask(),
      env: { [AGENT_TOOL_ENV]: "1" },
      code: "forbidden",
      says: DEPLOY_APPROVE_AGENT_REFUSAL,
    },
  ];
  for (const row of refusals) {
    test(`${row.name} is refused, and nothing is written`, async () => {
      await row.setUp?.();
      const before = treeOf(base);
      const out = await approve(row.argv, "alice", row.env ?? {});
      expect(out.lines.join("\n")).toContain(row.says);
      expect(out.exitCode).toBe(EXIT_FOR_ERROR[row.code]);
      expect(treeOf(base)).toEqual(before);
    });
  }

  test("--help says how, and writes nothing", async () => {
    const before = treeOf(base);
    expect(await approve(["--help"])).toEqual({ lines: DEPLOY_APPROVE_USAGE, exitCode: 0 });
    expect(treeOf(base)).toEqual(before);
  });
});
