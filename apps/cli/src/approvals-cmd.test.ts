/**
 * `crewhaus approvals`, driven in-process through `runApprovalsCommand`: who a decision
 * is recorded as, which harness's approver list applies when the store was found
 * through the environment, standing rules and the requests that ask the owner for one,
 * and the refusal under an agent's tool.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
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
import { join, relative } from "node:path";
import { type LocalIdentity, ensureAccessSetUp, localActorOf } from "@crewhaus/access-control";
import { mintId } from "@crewhaus/control-contract";
import { foldStates, readProposals, readStandingRules } from "@crewhaus/control-records";
import { commandsLedgerOf } from "@crewhaus/control-service";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { parseManagerHook, resolveHookCommand } from "@crewhaus/harness-supervisor";
import {
  type PendingApproval,
  createPendingApprovalStore,
  foldReadOnly,
  generateApprovalId,
  hashApprovalInput,
  principalAuthorizer,
} from "@crewhaus/session-store";
import { bootTestServer } from "../../../packages/hangar-server/src/testkit";
import { managerHookArgv } from "../../../packages/runtime-core/src/hook-targets";
import { _setApprovalSeamsForTest } from "../../../packages/session-store/src/approvals/decide";
import {
  AGENT_TOOL_REFUSAL,
  type ApprovalsDeps,
  NO_HARNESS_LINE,
  runApprovalsCommand,
  settingsApplyGate,
} from "./approvals-cmd";
import { directControl, harnessIdOf, liveHarnessDirs } from "./daemon-cmd";

const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => _setApprovalSeamsForTest(undefined));

function tmp(prefix = "approvals-cmd-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TMP.push(dir);
  return dir;
}

const OWNER_USER: LocalIdentity = { username: "owner", hostname: "laptop" };
const MEMBER_USER: LocalIdentity = { username: "rae", hostname: "laptop" };
const STRANGER: LocalIdentity = { username: "zed", hostname: "laptop" };

/** A Home whose access records link `OWNER_USER` as the owner. */
async function home(): Promise<{ readonly hangarRoot: string; readonly owner: string }> {
  const hangarRoot = join(tmp("approvals-home-"), "hangar");
  const done = await ensureAccessSetUp(hangarRoot, { localActor: localActorOf(OWNER_USER) });
  if (!done.ok) throw new Error(done.reason);
  return { hangarRoot, owner: done.result.owner };
}

/** Plant a member whose active `local` link is `identity`, as the access records hold one. */
function linkMember(hangarRoot: string, identity: LocalIdentity, by: string): string {
  const principal = mintId("prn");
  const link = mintId("lnk");
  const at = new Date().toISOString();
  const dir = join(hangarRoot, "access");
  appendFileSync(
    join(dir, "principals.jsonl"),
    `${JSON.stringify({ id: principal, kind: "member", state: "active", at, by })}\n`,
  );
  appendFileSync(
    join(dir, "links.jsonl"),
    `${JSON.stringify({
      id: link,
      principal,
      provider: "local",
      subjectRef: "d".repeat(64),
      verifiedVia: "owner",
      state: "active",
      at,
      by,
    })}\n`,
  );
  const file = join(dir, "subjects.json");
  const subjects = JSON.parse(readFileSync(file, "utf8")) as { links: Record<string, string> };
  subjects.links[link] = localActorOf(identity);
  writeFileSync(file, `${JSON.stringify(subjects, null, 2)}\n`);
  return principal;
}

function project(
  harness: string,
  owner: string,
  members: ReadonlyArray<{ readonly principal: string; readonly decide: string }> = [],
): void {
  const control = join(harness, ".crewhaus", "run", "control");
  mkdirSync(control, { recursive: true });
  writeFileSync(
    join(control, "approvers.json"),
    `${JSON.stringify({
      v: 1,
      epoch: 1,
      generatedAt: new Date().toISOString(),
      harness: "hrn_00000000000000d1",
      owner,
      governedSince: new Date(Date.now() - 86_400_000).toISOString(),
      members,
      links: [],
    })}\n`,
  );
}

async function park(
  rootDir: string,
  toolName = "Write",
  input: unknown = { path: "notes/a.md" },
): Promise<PendingApproval> {
  const record: PendingApproval = {
    id: generateApprovalId(),
    toolName,
    inputHash: hashApprovalInput(toolName, input),
    input,
    runId: "run_1",
    sessionId: "sess_00000000deadbeef",
    surface: "single-turn",
    createdAt: new Date().toISOString(),
  };
  await createPendingApprovalStore({ rootDir }).persist(record);
  return record;
}

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

type Rig = {
  readonly harness: string;
  readonly hangarRoot: string;
  readonly env: Record<string, string>;
  run(argv: readonly string[], over?: Partial<ApprovalsDeps>): Promise<Run>;
};

function rig(hangarRoot: string, harness = tmp("approvals-harness-")): Rig {
  const env = {
    CREWHAUS_HANGAR_ROOT: hangarRoot,
    CREWHAUS_REGISTRY_ROOT: tmp("approvals-registry-"),
  };
  return {
    harness,
    hangarRoot,
    env,
    async run(argv, over = {}) {
      let stdout = "";
      let stderr = "";
      const identity = over.identity ?? OWNER_USER;
      const [action = "", ...rest] = argv;
      const BOOLEAN = new Set(["always", "json", "once", "help"]);
      const flags: Record<string, string | boolean> = {};
      const words: string[] = [];
      for (let i = 0; i < rest.length; i += 1) {
        const word = rest[i] as string;
        if (!word.startsWith("--")) {
          words.push(word);
          continue;
        }
        const name = word.slice(2);
        if (BOOLEAN.has(name)) {
          flags[name] = true;
        } else {
          flags[name] = rest[i + 1] ?? "";
          i += 1;
        }
      }
      const code = await runApprovalsCommand({ positional: words, flags }, action, {
        env,
        cwd: harness,
        identity,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        scopedSessionRoot: () => undefined,
        isTTY: () => false,
        ask: async () => "",
        control: directControl({ env, identity }),
        registryDirs: () => liveHarnessDirs({ env }),
        harnessIdOf: (dir) => harnessIdOf(dir, { env }),
        ...over,
      });
      return { code, stdout, stderr };
    },
  };
}

const sessionsOf = (harness: string): string => join(harness, ".crewhaus", "sessions");
const decisionClaims = (root: string): string[] => {
  const dir = join(root, "approvals.d", "claims", "decision");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const decideLines = (root: string, id: string): number => {
  const dir = join(root, "approvals.d", "decisions");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"))
    .filter((line) => line.includes('"event":"decide"') && line.includes(id)).length;
};
const receipts = (harness: string) => {
  const fold = foldStates(commandsLedgerOf(harness));
  return fold.ok ? [...fold.objects.values()].map((o) => o.record) : [];
};

describe("who a CLI decision is recorded as", () => {
  test("a linked local user decides as their member; an unlinked one is refused; --by is a label", async () => {
    const { hangarRoot, owner } = await home();
    const r = rig(hangarRoot);
    const member = linkMember(hangarRoot, MEMBER_USER, owner);
    project(r.harness, owner, [{ principal: member, decide: "operator" }]);
    const root = sessionsOf(r.harness);

    const a = await park(root);
    const linked = await r.run(["grant", a.id, "--by", "mallory"], { identity: MEMBER_USER });
    expect(linked.code).toBe(0);
    const decided = foldReadOnly(root).records.find((x) => x.id === a.id);
    expect(decided?.decidedByPrincipal).toBe(member);
    expect(decided?.decidedBy).toBe("mallory");
    const grantReceipt = receipts(r.harness).find((x) => x["kind"] === "decisions.resolve");
    expect(grantReceipt?.["actor"]).toBe(member);
    expect(grantReceipt?.["state"]).toBe("succeeded");

    const b = await park(root);
    const unlinked = await r.run(["grant", b.id], { identity: STRANGER });
    expect(unlinked.code).toBe(51);
    expect(unlinked.stderr).toContain("Sign in to Home, or ask its owner.");
    expect(decisionClaims(root)).toEqual([`${a.id}.json`]);
    const refused = receipts(r.harness).filter(
      (x) => x["kind"] === "decisions.resolve" && x["state"] !== "succeeded",
    );
    expect(refused.map((x) => x["state"])).toEqual(["rejected"]);
  }, 30_000);
});

describe("finding the harness when the store was found through the environment", () => {
  function harnessWith(sessionDir: string): string {
    const dir = tmp("approvals-found-");
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(join(dir, ".env"), `CREWHAUS_SESSION_DIR=${sessionDir}\n`);
    return dir;
  }

  test("a registered harness whose own root it is decides by its own approver list", async () => {
    const { hangarRoot, owner } = await home();
    const h = harnessWith("custom");
    project(h, owner);
    const r = rig(hangarRoot, tmp("approvals-elsewhere-"));
    openHangarRegistry({ env: r.env }).upsert({ dir: h, specName: "h", target: "cli" });
    const root = join(h, "custom");
    const p = await park(root);
    const stranger = await r.run(["grant", p.id], {
      identity: STRANGER,
      scopedSessionRoot: () => root,
    });
    expect(stranger.code).toBe(51);
    const ownerRun = await r.run(["grant", p.id], { scopedSessionRoot: () => root });
    expect(ownerRun.code).toBe(0);
    expect(foldReadOnly(root).records[0]?.decidedByPrincipal).toBe(owner);
  }, 30_000);

  test("two harnesses, one governed: refused, naming --dir", async () => {
    const { hangarRoot, owner } = await home();
    const outer = harnessWith(join("inner", "s"));
    const inner = join(outer, "inner");
    mkdirSync(join(inner, ".crewhaus"), { recursive: true });
    writeFileSync(join(inner, ".env"), "CREWHAUS_SESSION_DIR=s\n");
    project(inner, owner);
    const r = rig(hangarRoot, tmp("approvals-elsewhere-"));
    const root = join(inner, "s");
    const p = await park(root);
    const answer = await r.run(["grant", p.id], { scopedSessionRoot: () => root });
    expect(answer.code).toBe(55);
    expect(answer.stderr).toContain("--dir");
    expect(foldReadOnly(root).records[0]?.decision).toBeUndefined();
  }, 30_000);

  test("two ungoverned harnesses: --always is refused, a grant is decided and says so", async () => {
    const { hangarRoot } = await home();
    const outer = harnessWith(join("inner", "s"));
    const inner = join(outer, "inner");
    mkdirSync(join(inner, ".crewhaus"), { recursive: true });
    writeFileSync(join(inner, ".env"), "CREWHAUS_SESSION_DIR=s\n");
    const r = rig(hangarRoot, tmp("approvals-elsewhere-"));
    const root = join(inner, "s");
    const p = await park(root);
    const always = await r.run(["grant", p.id, "--always"], { scopedSessionRoot: () => root });
    expect(always.code).toBe(55);
    const once = await r.run(["grant", p.id], { scopedSessionRoot: () => root });
    expect(once.code).toBe(0);
    expect(once.stderr).toContain(NO_HARNESS_LINE);
  }, 30_000);

  test("a root no harness names: decided, with the line that says pass --dir", async () => {
    const { hangarRoot } = await home();
    const r = rig(hangarRoot, tmp("approvals-elsewhere-"));
    const root = join(tmp("approvals-loose-"), "s");
    const p = await park(root);
    const answer = await r.run(["grant", p.id], { scopedSessionRoot: () => root });
    expect(answer.code).toBe(0);
    expect(answer.stderr).toContain(NO_HARNESS_LINE);
  }, 30_000);
});

describe("standing rules and requests to the owner", () => {
  test("a member's --always grants once and asks the owner, who answers it once", async () => {
    const { hangarRoot, owner } = await home();
    const r = rig(hangarRoot);
    const member = linkMember(hangarRoot, MEMBER_USER, owner);
    project(r.harness, owner, [{ principal: member, decide: "maintainer" }]);
    const p = await park(sessionsOf(r.harness));
    const asked = await r.run(["grant", p.id, "--always"], { identity: MEMBER_USER });
    expect(asked.code).toBe(0);
    expect(asked.stdout).toContain("asked the owner for Write(notes/a.md)");
    const record = foldReadOnly(sessionsOf(r.harness)).records[0];
    expect(record?.decision).toBe("grant");
    expect(record?.always).toBeUndefined();
    expect(existsSync(join(r.harness, ".crewhaus", "settings.json"))).toBe(false);
    const proposals = readProposals(r.harness);
    if (proposals.state !== "present") throw new Error(proposals.state);
    const proposal = proposals.rows[0];
    expect(proposal?.requiredClass).toBe("owner");
    expect(proposal?.terms.pattern).toBe("Write(notes/a.md)");
    const id = proposal?.id ?? "";

    const byMember = await r.run(["grant", id], { identity: MEMBER_USER });
    expect(byMember.code).toBe(51);
    const byOwner = await r.run(["grant", id]);
    expect(byOwner.code).toBe(0);
    const rules = readStandingRules(r.harness);
    expect(rules.state === "present" ? rules.rows.map((row) => row.pattern) : []).toEqual([
      "Write(notes/a.md)",
    ]);
    expect(rules.state === "present" ? rules.rows[0]?.cmd : undefined).toMatch(/^cmd_/);
    expect(JSON.parse(readFileSync(join(r.harness, ".crewhaus", "settings.json"), "utf8"))).toEqual(
      { permissions: { rules: [{ type: "alwaysAllow", pattern: "Write(notes/a.md)" }] } },
    );
    const again = await r.run(["grant", id]);
    expect(again.code).toBe(55);
    expect(receipts(r.harness).some((x) => x["kind"] === "rules.create")).toBe(true);
  }, 30_000);

  test("a wider glob is the owner's, at a terminal, confirmed by the tool's name", async () => {
    const { hangarRoot, owner } = await home();
    const r = rig(hangarRoot);
    project(r.harness, owner);
    const root = sessionsOf(r.harness);
    const p = await park(root);
    await park(root, "Write", { path: "notes/b.md" });
    const off = await r.run(["grant", p.id, "--always", "--pattern", "Write(notes/**)"]);
    expect(off.code).toBe(55);
    let asked = "";
    const done = await r.run(["grant", p.id, "--always", "--pattern", "Write(notes/**)"], {
      isTTY: () => true,
      ask: async (question) => {
        asked = question;
        return "Write";
      },
    });
    expect(done.code).toBe(0);
    expect(asked).toContain("Write");
    expect(done.stdout).toContain("also covers 2 approval(s)");
    expect(JSON.parse(readFileSync(join(r.harness, ".crewhaus", "settings.json"), "utf8"))).toEqual(
      { permissions: { rules: [{ type: "alwaysAllow", pattern: "Write(notes/**)" }] } },
    );
  }, 30_000);

  test("revoking a rule is the owner's, and ends it", async () => {
    const { hangarRoot, owner } = await home();
    const r = rig(hangarRoot);
    const member = linkMember(hangarRoot, MEMBER_USER, owner);
    project(r.harness, owner, [{ principal: member, decide: "maintainer" }]);
    const p = await park(sessionsOf(r.harness));
    expect((await r.run(["grant", p.id, "--always"])).code).toBe(0);
    const rules = readStandingRules(r.harness);
    const id = rules.state === "present" ? (rules.rows[0]?.id ?? "") : "";
    expect((await r.run(["revoke", id], { identity: MEMBER_USER })).code).toBe(51);
    const revoked = await r.run(["revoke", id]);
    expect(revoked.code).toBe(0);
    const after = readStandingRules(r.harness);
    expect(after.state === "present" ? after.rows[0]?.state : undefined).toBe("revoked");
  }, 30_000);
});

describe("whole-tool allows no record keeps", () => {
  function tree(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (at: string): void => {
      for (const name of readdirSync(at)) {
        const path = join(at, name);
        if (statSync(path).isDirectory()) walk(path);
        else
          out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    };
    walk(dir);
    return out;
  }

  test("rules lists one with its verb and writes nothing; only the owner removes it", async () => {
    const { hangarRoot, owner } = await home();
    const r = rig(hangarRoot);
    const member = linkMember(hangarRoot, MEMBER_USER, owner);
    project(r.harness, owner, [{ principal: member, decide: "maintainer" }]);
    writeFileSync(
      join(r.harness, ".crewhaus", "settings.json"),
      `${JSON.stringify({ permissions: { rules: [{ type: "alwaysAllow", pattern: "Bash" }] } })}\n`,
    );
    const before = tree(r.harness);
    const listed = await r.run(["rules"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("legacy broad allow: make it narrow, or remove it");
    expect(listed.stdout).toContain(`crewhaus approvals revoke --legacy Bash --dir ${r.harness}`);
    expect(tree(r.harness)).toEqual(before);
    expect((await r.run(["revoke", "--legacy", "Bash"], { identity: MEMBER_USER })).code).toBe(51);
    expect((await r.run(["revoke", "--legacy", "Bash"])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(r.harness, ".crewhaus", "settings.json"), "utf8"))).toEqual(
      { permissions: { rules: [] } },
    );
  }, 30_000);
});

describe("a command an agent's tool started", () => {
  test("decides nothing, and still lists", async () => {
    const { hangarRoot } = await home();
    const r = rig(hangarRoot);
    const root = sessionsOf(r.harness);
    const p = await park(root);
    const before = readFileSync(join(root, "approvals.jsonl"));
    const env = { ...r.env, CREWHAUS_AGENT_TOOL: "Bash" };
    for (const argv of [
      ["grant", p.id],
      ["deny", p.id],
      ["supersede", p.id, "--reason", "other"],
      ["defer", p.id, "--until", "2099-01-01T00:00:00Z", "--reason", "scheduled"],
      ["revoke", mintId("rule")],
    ]) {
      const refused = await r.run(argv, { env });
      expect([argv[0], refused.code]).toEqual([argv[0], 51]);
      expect(refused.stderr).toContain(AGENT_TOOL_REFUSAL);
    }
    expect(readFileSync(join(root, "approvals.jsonl")).equals(before)).toBe(true);
    expect(decisionClaims(root)).toEqual([]);
    expect(receipts(r.harness)).toEqual([]);
    expect((await r.run(["list"], { env })).code).toBe(0);
    expect((await r.run(["rules"], { env })).code).toBe(0);
  }, 30_000);
});

describe("one decision wins on every surface", () => {
  test("Home, the CLI and a daemon's own path on one approval: one decision, one claim, one line", async () => {
    const t = bootTestServer();
    try {
      const harness = join(t.harnessesRoot, "contested");
      mkdirSync(harness, { recursive: true });
      writeFileSync(join(harness, "crewhaus.yaml"), "name: contested\ntarget: cli\n");
      const reg = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir: harness }),
      });
      const hrn = (reg.body["entry"] as { id: string }).id;
      const root = sessionsOf(harness);
      const p = await park(root);
      const r = rig(join(tmp("approvals-cli-home-"), "hangar"), harness);
      let others: Promise<readonly [number, string]> | undefined;
      let fired = false;
      _setApprovalSeamsForTest({
        afterFold: () => {
          if (fired) return;
          fired = true;
          others = Promise.all([
            t
              .api(`/api/h/${hrn}/approvals/${p.id}/deny`, { method: "POST", body: "{}" })
              .then((res) => res.status),
            createPendingApprovalStore({ rootDir: root })
              .decide(
                p.id,
                { choice: "deny", actor: {}, via: "slack" },
                { authorize: principalAuthorizer(harness, {}) },
              )
              .then((answer) => answer.outcome),
          ]);
        },
      });
      const cli = await r.run(["grant", p.id]);
      const [home, daemon] = (await others) ?? [0, ""];
      expect(cli.code).toBe(0);
      expect(home).toBe(409);
      expect(daemon).toBe("already-decided");
      expect(decisionClaims(root)).toEqual([`${p.id}.json`]);
      expect(decideLines(root, p.id)).toBe(1);
      expect(foldReadOnly(root).records[0]?.decision).toBe("grant");
    } finally {
      await t.stop();
    }
  }, 40_000);
});

describe("the manager-hook reading the floor uses", () => {
  test("equals harness-supervisor's parse and resolve, declaration by declaration", () => {
    const harness = tmp("approvals-hooks-");
    const table: unknown[] = [
      "./prep.sh",
      "  ./prep.sh --flag  ",
      "../tools/prep.sh",
      "/abs/prep.sh",
      "make",
      "bun scripts/post.ts",
      ["bun", "scripts/post.ts"],
      ["./bin/x", " a ", "", 3, "b"],
      ["  ", ""],
      [],
      "",
      "   ",
      7,
      null,
      { argv: ["x"] },
    ];
    for (const declared of table) {
      const parsed = parseManagerHook(declared);
      const expected =
        parsed === undefined
          ? undefined
          : [resolveHookCommand(harness, parsed.argv[0] as string), ...parsed.argv.slice(1)];
      expect([declared, managerHookArgv(declared, harness)]).toEqual([declared, expected]);
    }
  });
});

describe("permissions suggest --apply on a harness with an approver list", () => {
  test("is the owner's: a linked maintainer is refused and the file stays as it was", async () => {
    const { hangarRoot, owner } = await home();
    const r = rig(hangarRoot);
    const member = linkMember(hangarRoot, MEMBER_USER, owner);
    project(r.harness, owner, [{ principal: member, decide: "maintainer" }]);
    const settings = join(r.harness, ".crewhaus", "settings.json");
    writeFileSync(settings, `${JSON.stringify({ hooks: [] })}\n`);
    const before = readFileSync(settings);
    let said = "";
    const deps = (identity: LocalIdentity) => ({
      control: directControl({ env: r.env, identity }),
      identity,
      stderr: (text: string) => {
        said += text;
      },
    });
    expect(settingsApplyGate(r.harness, deps(MEMBER_USER))).toBe(51);
    expect(said).toContain("Needs the owner.");
    expect(settingsApplyGate(r.harness, deps(OWNER_USER))).toBeUndefined();
    expect(readFileSync(settings).equals(before)).toBe(true);
    // With no approver list, the harness is its single owner's.
    expect(settingsApplyGate(tmp("approvals-plain-"), deps(STRANGER))).toBeUndefined();
  }, 30_000);
});
