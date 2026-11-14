import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import {
  casAppend,
  controlPaths,
  decisionsLedger,
  readApproverProjection,
  readProposals,
  readStandingRules,
} from "@crewhaus/control-records";
import { emptyRuleSet, evaluate, loadSettingsRules } from "@crewhaus/permission-engine";
import { foldReadOnly, generateApprovalId } from "@crewhaus/session-store";
import type { DecisionActor } from "./decisions";
import {
  SECURITY_SETTINGS_PATHS,
  createDecisions,
  governedAncestorOf,
  harnessForSessionRoot,
  settingsWriteClass,
} from "./decisions";
import {
  callValues,
  carriesCredential,
  createStandingRule,
  legacyBroadAllows,
  ruleEndProblem,
  standingPatternFor,
  widenedPatternProblem,
} from "./rules";
import {
  NOW,
  linkLocalMember,
  park,
  plantProjection,
  removeTempDirs,
  rig,
  setUpOwner,
  settingsOf,
  tempDir,
} from "./test-helpers";

afterAll(removeTempDirs);

const DAY = 86_400_000;
const as = (principal: string, extra: Partial<{ service: true; display: string }> = {}) =>
  ({ kind: "principal", principal, ...extra }) as DecisionActor;

function governed() {
  const r = rig();
  const owner = mintId("prn");
  const operator = mintId("prn");
  const maintainer = mintId("prn");
  plantProjection(r.harness, owner, [
    { principal: operator, decide: "operator" },
    { principal: maintainer, decide: "maintainer" },
  ]);
  return { ...r, owner, operator, maintainer };
}

/** Every file under a directory, by its digest: what a read must leave as it was. */
function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

describe("decisions.resolve by class", () => {
  test("an operator is refused a request that needs a maintainer; the maintainer decides it", async () => {
    const r = governed();
    const p = await park(r.harness, "Write", { path: "a.md" }, { requiredClass: "maintainer" });
    const refused = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.operator),
      via: "home",
    });
    expect(refused.outcome).toBe("forbidden");
    expect(refused.reason).toBe("Needs a maintainer.");
    const decided = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.maintainer, { display: "mallory" }),
      via: "home",
    });
    expect(decided.outcome).toBe("decided");
    expect(decided.record?.decidedByPrincipal).toBe(r.maintainer);
    expect(decided.record?.decidedBy).toBe("mallory");
  });

  test("an operator cannot supersede, and a service principal decides nothing above operator", async () => {
    const r = governed();
    const p = await park(r.harness, "Write", { path: "a.md" });
    await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.owner),
      via: "home",
    });
    const sup = await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: p.id,
      reason: "decided-in-error",
      actor: as(r.operator),
      via: "cli",
    });
    expect(sup.outcome).toBe("forbidden");
    const q = await park(r.harness, "Write", { path: "b.md" }, { requiredClass: "maintainer" });
    const service = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: q.id,
      choice: "grant",
      actor: as(r.maintainer, { service: true }),
      via: "home",
    });
    expect(service.outcome).toBe("forbidden");
  });

  test("a local user decides as the member their link names, and an unlinked one is refused", async () => {
    const r = rig();
    const owner = await setUpOwner(r.hangarRoot);
    const member = linkLocalMember(r.hangarRoot, { username: "rae", hostname: "laptop" }, owner);
    plantProjection(r.harness, owner, [{ principal: member, decide: "operator" }], {
      accessRoot: realpathSync(r.hangarRoot),
    });
    const p = await park(r.harness, "Write", { path: "a.md" });
    const linked = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "deny",
      actor: { kind: "local", identity: { username: "rae", hostname: "laptop" }, display: "x" },
      via: "cli",
    });
    expect(linked.record?.decidedByPrincipal).toBe(member);
    const q = await park(r.harness, "Write", { path: "b.md" });
    const unlinked = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: q.id,
      choice: "grant",
      actor: { kind: "local", identity: { username: "zed", hostname: "laptop" } },
      via: "cli",
    });
    expect(unlinked.outcome).toBe("forbidden");
  });

  test("with no projection the harness is single-owner, and no principal is recorded", async () => {
    const r = rig();
    const p = await park(r.harness, "Write", { path: "a.md" });
    const answer = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: { kind: "anonymous", display: "hangar" },
      via: "home",
    });
    expect(answer.outcome).toBe("decided");
    expect(answer.record?.decidedByPrincipal).toBeUndefined();
  });
});

describe("standing rules from a grant", () => {
  test("the owner's --always writes the call's own narrow rule for 30 days, row first", async () => {
    const r = governed();
    const p = await park(r.harness, "Write", { path: "notes/a*.md" });
    const answer = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
      always: true,
    });
    expect(answer.outcome).toBe("decided");
    expect(answer.record?.always).toBe(true);
    expect(answer.rule?.pattern).toBe("Write(notes/a\\*.md)");
    expect(answer.rule?.createdBy).toBe(r.owner);
    expect(answer.rule?.reason).toBe("approval");
    expect(answer.rule?.derivedFrom).toBe(p.id);
    expect(
      Date.parse(answer.rule?.expiresAt ?? "") - Date.parse(answer.rule?.createdAt ?? ""),
    ).toBe(30 * DAY);
    expect(settingsOf(r.harness)).toEqual({
      permissions: { rules: [{ type: "alwaysAllow", pattern: "Write(notes/a\\*.md)" }] },
    });
  });

  test("days outside 1-365 and a call no rule can name are refused before anything is decided", async () => {
    const r = governed();
    const p = await park(r.harness, "Write", { path: "a.md" });
    for (const days of [0, 366, 1.5]) {
      const answer = await r.service.decisions.resolve({
        harnessDir: r.harness,
        ref: p.id,
        choice: "grant",
        actor: as(r.owner),
        via: "cli",
        always: true,
        days,
      });
      expect(answer.outcome).toBe("invalid");
    }
    const listing = await park(r.harness, "BashOutput", { bash_id: "bash_1" });
    const unnamed = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: listing.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
      always: true,
    });
    expect(unnamed.outcome).toBe("invalid");
    expect(unnamed.reason).toContain("no-scoping-argument");
    const two = await park(r.harness, "CopyPath", { source: "a.md", destination: "b.md" });
    const several = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: two.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
      always: true,
    });
    expect(several.reason).toContain("several-places");
    const paren = await park(r.harness, "Write", { path: "a(b).md" });
    const parenthesis = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: paren.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
      always: true,
    });
    expect(parenthesis.reason).toContain("not-representable");
    const keyed = await park(r.harness, "WebFetch", {
      url: `https://api.example.com/v1/items?api_key=${"k".repeat(12)}`,
    });
    const credential = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: keyed.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
      always: true,
    });
    expect(credential.outcome).toBe("invalid");
    expect(credential.reason).toContain("carries-credential");
    // Nothing was decided on any of them.
    const folded = foldReadOnly(join(r.harness, ".crewhaus", "sessions"));
    expect(folded.records.filter((x) => x.decision !== undefined)).toEqual([]);
    expect(settingsOf(r.harness)).toBeUndefined();
  });

  test("a member's --always grants once and asks the owner, who grants the request once", async () => {
    const r = governed();
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    const answer = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.maintainer),
      via: "cli",
      always: true,
    });
    expect(answer.outcome).toBe("decided");
    expect(answer.record?.always).toBeUndefined();
    expect(answer.rule).toBeUndefined();
    expect(settingsOf(r.harness)).toBeUndefined();
    const proposal = answer.proposal;
    expect(proposal?.requiredClass).toBe("owner");
    expect(proposal?.terms.pattern).toBe("Write(notes/a.md)");
    expect(proposal?.proposedBy).toBe(r.maintainer);
    const id = proposal?.id ?? "";
    const byMember = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: id,
      choice: "grant",
      actor: as(r.maintainer),
      via: "cli",
    });
    expect(byMember.outcome).toBe("forbidden");
    expect(byMember.reason).toBe("Needs the owner.");
    const byOwner = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
    });
    expect(byOwner.outcome).toBe("decided");
    expect(byOwner.rule?.reason).toBe("proposal");
    expect(byOwner.rule?.proposal).toBe(id);
    expect(byOwner.proposal?.rule).toBe(byOwner.rule?.id);
    const again = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
    });
    expect(again.outcome).toBe("already-decided");
    const rules = readStandingRules(r.harness);
    expect(rules.state === "present" ? rules.rows.length : 0).toBe(1);
    expect(settingsOf(r.harness)).toEqual({
      permissions: { rules: [{ type: "alwaysAllow", pattern: "Write(notes/a.md)" }] },
    });
  });

  test("a wider glob is the owner's, confirmed by the tool's name, and must cover the call", async () => {
    const r = governed();
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    const base = {
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant" as const,
      via: "cli" as const,
      always: true,
      pattern: "Write(notes/**)",
    };
    expect((await r.service.decisions.resolve({ ...base, actor: as(r.maintainer) })).outcome).toBe(
      "forbidden",
    );
    expect(
      (await r.service.decisions.resolve({ ...base, actor: as(r.owner), confirm: "write" }))
        .outcome,
    ).toBe("invalid");
    expect(
      (
        await r.service.decisions.resolve({
          ...base,
          actor: as(r.owner),
          confirm: "Write",
          pattern: "Write(other/**)",
        })
      ).outcome,
    ).toBe("invalid");
    const done = await r.service.decisions.resolve({
      ...base,
      actor: as(r.owner),
      confirm: "Write",
    });
    expect(done.rule?.pattern).toBe("Write(notes/**)");
  });
});

describe("narrowing per operative kind", () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, Record<string, unknown>]> =
    [
      ["Write", { path: "notes/a.md" }, { path: "notes/b.md" }],
      ["WebFetch", { url: "https://example.com/a" }, { url: "https://example.com/b" }],
      ["Bash", { command: "npm test" }, { command: "npm publish" }],
      ["DnsLookup", { name: "example.com" }, { name: "example.org" }],
      ["WebSearch", { query: "crewhaus" }, { query: "something else" }],
      ["PackageQuery", { name: "left-pad" }, { name: "right-pad" }],
    ];
  for (const [tool, approved, sibling] of cases) {
    test(`${tool}: the rule grants the approved call and not its sibling`, () => {
      const harness = tempDir();
      const narrow = standingPatternFor(tool, approved, harness);
      if ("refused" in narrow) throw new Error(`${tool}: ${narrow.refused}`);
      const rules = {
        ...emptyRuleSet,
        settings: [
          { type: "alwaysAllow" as const, pattern: narrow.pattern, source: "settings" as const },
        ],
      };
      const decide = (input: Record<string, unknown>) => {
        const values = callValues(tool, input, harness);
        return evaluate(
          {
            toolName: tool,
            input,
            ...(values !== undefined && values !== "no-scoping-argument"
              ? { operativeValues: values }
              : {}),
            readOnly: false,
            destructive: true,
          },
          "default",
          rules,
        );
      };
      expect(decide(approved)).toBe("allow");
      expect(decide(sibling)).not.toBe("allow");
    });
  }

  test("a path written absolute inside the harness is named relative to it", () => {
    const harness = tempDir();
    const narrow = standingPatternFor("Write", { path: join(harness, "notes", "a.md") }, harness);
    expect("pattern" in narrow && narrow.pattern).toBe("Write(notes/a.md)");
  });
});

describe("a value that carries a credential is never a rule", () => {
  // Built from parts at run time: no credential-shaped literal sits in the source.
  const token = ["sk", "ant", "api03", "x".repeat(24)].join("-");
  const refusedCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["Bash", { command: `curl -H "x-api-key: ${token}" https://api.example.com` }],
    ["Bash", { command: 'curl -H "Authorization: Basic abc" https://api.example.com' }],
    ["Bash", { command: "API_TOKEN=abc123 ./deploy.sh" }],
    ["WebFetch", { url: "https://api.example.com/items?access_token=abc123" }],
  ];
  for (const [tool, input] of refusedCases) {
    test(`${tool} ${JSON.stringify(input).slice(0, 40)}… is refused`, () => {
      const narrow = standingPatternFor(tool, input, tempDir());
      expect(narrow).toEqual({ refused: "carries-credential" });
    });
  }

  test("a value with no credential still makes its rule", () => {
    for (const [tool, input] of [
      ["Bash", { command: "curl -H 'Accept: text/plain' https://example.com?page=2" }],
      ["WebFetch", { url: "https://example.com/items?monkey=1" }],
      ["Bash", { command: "MAX_TOKENS=5 ./run.sh" }],
    ] as const) {
      expect("pattern" in standingPatternFor(tool, input, tempDir())).toBe(true);
    }
    expect(carriesCredential("Write(notes/a.md)")).toBe(false);
    expect(carriesCredential("https://user:hunter2@example.com/items")).toBe(true);
  });

  test("a wider pattern the owner types is refused when it holds a credential", () => {
    const harness = tempDir();
    expect(
      widenedPatternProblem(
        "WebFetch",
        { url: "https://example.com/a?token=abc" },
        "WebFetch(https://example.com/**?token=abc)",
        harness,
      ),
    ).toBe("a rule must not hold a credential");
  });
});

describe("revoking and expiry", () => {
  async function owned() {
    const r = governed();
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    const made = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
      always: true,
    });
    if (made.rule === undefined) throw new Error("no rule");
    return { ...r, rule: made.rule };
  }

  test("a revoked rule stops matching in a rule set loaded before, and its entry goes", async () => {
    const r = await owned();
    let now = NOW + 1000;
    const loaded = { ...emptyRuleSet, settings: loadSettingsRules(r.harness, { now: () => now }) };
    const call = {
      toolName: "Write",
      input: { path: "notes/a.md" },
      operativeValues: callValues("Write", { path: "notes/a.md" }, r.harness) as never,
      readOnly: false,
      destructive: true,
    };
    expect(evaluate(call, "default", loaded)).toBe("allow");
    const byMember = await r.service.rules.revoke({
      harnessDir: r.harness,
      id: r.rule.id,
      actor: as(r.maintainer),
    });
    expect(byMember.outcome).toBe("forbidden");
    const revoked = await r.service.rules.revoke({
      harnessDir: r.harness,
      id: r.rule.id,
      actor: as(r.owner),
    });
    expect(revoked.outcome).toBe("revoked");
    now += 1001;
    expect(evaluate(call, "default", loaded)).toBe("ask");
    expect(settingsOf(r.harness)).toEqual({ permissions: { rules: [] } });
  });

  test("a second live rule for the same pattern keeps the entry", async () => {
    const r = await owned();
    const q = await park(r.harness, "Write", { path: "notes/a.md" });
    const second = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: q.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
      always: true,
    });
    expect(second.rule?.pattern).toBe(r.rule.pattern);
    const revoked = await r.service.rules.revoke({
      harnessDir: r.harness,
      id: r.rule.id,
      actor: as(r.owner),
    });
    expect(revoked.outcome === "revoked" && revoked.settingsRemoved).toBe(false);
    expect(settingsOf(r.harness)).toEqual({
      permissions: { rules: [{ type: "alwaysAllow", pattern: r.rule.pattern }] },
    });
  });

  test("the next rule write ends a rule past its end and removes its entry", async () => {
    const r = await owned();
    r.clock.now = NOW + 31 * DAY;
    const q = await park(
      r.harness,
      "Write",
      { path: "notes/b.md" },
      {
        createdAt: new Date(NOW + 31 * DAY).toISOString(),
      },
    );
    await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: q.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
      always: true,
    });
    const rules = readStandingRules(r.harness);
    if (rules.state !== "present") throw new Error(rules.state);
    expect(rules.rows.find((row) => row.id === r.rule.id)?.state).toBe("expired");
    expect(settingsOf(r.harness)).toEqual({
      permissions: { rules: [{ type: "alwaysAllow", pattern: "Write(notes/b.md)" }] },
    });
  });
});

describe("whole-tool allows no record names", () => {
  test("are listed with their verb, a read writes nothing, and only the owner removes one", async () => {
    const r = governed();
    mkdirSync(join(r.harness, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(r.harness, ".crewhaus", "settings.json"),
      `${JSON.stringify({ permissions: { rules: [{ type: "alwaysAllow", pattern: "Bash" }] } })}\n`,
    );
    const before = treeDigest(r.harness);
    const listed = r.service.rules.list(r.harness);
    expect(listed.legacy).toEqual([
      {
        tool: "Bash",
        pattern: "Bash",
        note: "legacy broad allow: make it narrow, or remove it",
        verb: `crewhaus approvals revoke --legacy Bash --dir ${r.harness}`,
      },
    ]);
    expect(legacyBroadAllows(r.harness)).toEqual(listed.legacy);
    expect(treeDigest(r.harness)).toEqual(before);
    const byMember = await r.service.rules.revokeLegacy({
      harnessDir: r.harness,
      pattern: "Bash",
      actor: as(r.maintainer),
    });
    expect(byMember.outcome).toBe("forbidden");
    const byOwner = await r.service.rules.revokeLegacy({
      harnessDir: r.harness,
      pattern: "Bash",
      actor: as(r.owner),
    });
    expect(byOwner.outcome).toBe("removed");
    expect(settingsOf(r.harness)).toEqual({ permissions: { rules: [] } });
  });

  test("an allow a record names is a rule, never a legacy allow", async () => {
    const r = governed();
    const p = await park(r.harness, "Write", { path: "a.md" });
    await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
      always: true,
    });
    const listed = r.service.rules.list(r.harness);
    expect(listed.legacy).toEqual([]);
    expect(listed.rules.map((rule) => rule.pattern)).toEqual(["Write(a.md)"]);
    expect(listed.rules[0]?.verb).toContain("crewhaus approvals revoke rule_");
  });
});

describe("harnessForSessionRoot", () => {
  function harnessWithEnv(dir: string, sessionDir?: string): string {
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    if (sessionDir !== undefined)
      writeFileSync(join(dir, ".env"), `CREWHAUS_SESSION_DIR=${sessionDir}\n`);
    return dir;
  }

  test("a registered harness whose own environment moves its session root there", () => {
    const h = harnessWithEnv(tempDir(), "custom");
    const elsewhere = tempDir();
    expect(
      harnessForSessionRoot(join(h, "custom"), { registry: () => [h], cwd: elsewhere }),
    ).toEqual({ state: "one", dir: h });
  });

  test("a tenant's session root under the harness's tenants root", () => {
    const h = harnessWithEnv(tempDir());
    const root = join(h, ".crewhaus", "tenants", "t1", "sessions");
    expect(harnessForSessionRoot(root, { cwd: tempDir() })).toEqual({ state: "one", dir: h });
  });

  test("two harnesses that both name the root", () => {
    const outer = harnessWithEnv(tempDir(), join("inner", "s"));
    const inner = harnessWithEnv(join(outer, "inner"), "s");
    const found = harnessForSessionRoot(join(inner, "s"), { registry: () => [outer, inner] });
    expect(found.state).toBe("several");
  });

  test("a root outside every harness matches none, even one an override points at", () => {
    const h = harnessWithEnv(tempDir(), "../escaped");
    const outside = join(tempDir(), "s");
    expect(harnessForSessionRoot(outside, { registry: () => [h], cwd: h })).toEqual({
      state: "none",
    });
  });
});

describe("settingsWriteClass", () => {
  test("the owner's for permissions, hooks, manager.hooks and manager.envFiles; a maintainer's for the rest", () => {
    const base = { manager: { envFiles: ["a"] }, alerts: { x: 1 } };
    expect(settingsWriteClass(base, { ...base, permissions: { rules: [] } })).toBe("owner");
    expect(settingsWriteClass(base, { ...base, hooks: [{ event: "stop", command: "x" }] })).toBe(
      "owner",
    );
    expect(
      settingsWriteClass(base, { ...base, manager: { ...base.manager, hooks: { preSpawn: "x" } } }),
    ).toBe("owner");
    expect(settingsWriteClass(base, { ...base, manager: { envFiles: ["b"] } })).toBe("owner");
    expect(settingsWriteClass(base, { ...base, manager: { envFiles: ["a"], other: 1 } })).toBe(
      "maintainer",
    );
    expect(settingsWriteClass(base, { ...base, alerts: { x: 2 } })).toBe("maintainer");
    // Every listed path is the owner's, and the list is the one other surfaces read.
    expect(SECURITY_SETTINGS_PATHS.map((path) => path.join("."))).toEqual([
      "permissions",
      "hooks",
      "manager.hooks",
      "manager.envFiles",
    ]);
    expect(Object.isFrozen(SECURITY_SETTINGS_PATHS)).toBe(true);
    // Key order is not a change.
    expect(
      settingsWriteClass(
        { permissions: { mode: "default", rules: [] } },
        { permissions: { rules: [], mode: "default" } },
      ),
    ).toBe("maintainer");
  });
});

describe("the request store", () => {
  test("a filed request is a dec_ on the decision machine, with no free text", async () => {
    const r = governed();
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.maintainer, { display: "Mallory Q" }),
      via: "cli",
      always: true,
    });
    const text = readdirSync(join(r.harness, controlPaths(r.harness).decisionsDir))
      .map((name) =>
        readFileSync(join(r.harness, controlPaths(r.harness).decisionsDir, name), "utf8"),
      )
      .join("");
    expect(text).not.toContain("Mallory");
    const read = readProposals(r.harness);
    expect(read.state === "present" && read.rows[0]?.kind).toBe("standing-rule-proposal");
  });
});

describe("superseding an approval and the standing rules made from it", () => {
  const call = (harness: string, path: string) => ({
    toolName: "Write",
    input: { path },
    operativeValues: callValues("Write", { path }, harness) as never,
    readOnly: false,
    destructive: true,
  });
  const allowedNow = (harness: string, path: string): string =>
    evaluate(call(harness, path), "default", {
      ...emptyRuleSet,
      settings: loadSettingsRules(harness, { now: () => NOW + 1000 }),
    });
  const ruleState = (harness: string, id: string): string | undefined => {
    const read = readStandingRules(harness);
    return read.state === "present" ? read.rows.find((row) => row.id === id)?.state : read.state;
  };

  async function ownerRule(r: ReturnType<typeof governed>, path: string) {
    const p = await park(r.harness, "Write", { path });
    const made = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
      always: true,
    });
    if (made.rule === undefined) throw new Error("no rule");
    return { p, rule: made.rule };
  }

  test("the owner's supersede in error ends the rule its --always made, and the call is asked again", async () => {
    const r = governed();
    const { p, rule } = await ownerRule(r, "notes/a.md");
    expect(allowedNow(r.harness, "notes/a.md")).toBe("allow");
    const answer = await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: p.id,
      reason: "decided-in-error",
      actor: as(r.owner),
      via: "cli",
    });
    expect(answer.outcome).toBe("superseded");
    expect(answer.derivedRules).toEqual([{ id: rule.id, revoked: true }]);
    expect(answer.ruleError).toBeUndefined();
    expect(ruleState(r.harness, rule.id)).toBe("revoked");
    expect(allowedNow(r.harness, "notes/a.md")).toBe("ask");
  });

  test("a maintainer's policy-changed supersede leaves the rule standing and names its verb", async () => {
    const r = governed();
    const { p, rule } = await ownerRule(r, "notes/a.md");
    const answer = await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: p.id,
      reason: "policy-changed",
      actor: as(r.maintainer),
      via: "cli",
    });
    expect(answer.outcome).toBe("superseded");
    expect(answer.derivedRules).toEqual([
      {
        id: rule.id,
        revoked: false,
        verb: `crewhaus approvals revoke ${rule.id} --dir ${r.harness}`,
      },
    ]);
    expect(ruleState(r.harness, rule.id)).toBe("active");
    expect(allowedNow(r.harness, "notes/a.md")).toBe("allow");
  });

  test("the owner's policy-changed supersede, and a maintainer's in error, leave the rule standing", async () => {
    const r = governed();
    const first = await ownerRule(r, "notes/a.md");
    const byOwner = await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: first.p.id,
      reason: "policy-changed",
      actor: as(r.owner),
      via: "cli",
    });
    expect(byOwner.derivedRules?.map((rule) => rule.revoked)).toEqual([false]);
    const second = await ownerRule(r, "notes/b.md");
    const byMaintainer = await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: second.p.id,
      reason: "decided-in-error",
      actor: as(r.maintainer),
      via: "cli",
    });
    expect(byMaintainer.derivedRules?.map((rule) => rule.revoked)).toEqual([false]);
    expect(ruleState(r.harness, first.rule.id)).toBe("active");
    expect(ruleState(r.harness, second.rule.id)).toBe("active");
  });

  test("a rule the owner granted from a member's request ends with the approval it came from", async () => {
    const r = governed();
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    const asked = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.maintainer),
      via: "cli",
      always: true,
    });
    const granted = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: asked.proposal?.id ?? "",
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
    });
    const id = granted.rule?.id ?? "";
    expect(granted.rule?.derivedFrom).toBe(p.id);
    const answer = await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: p.id,
      reason: "decided-in-error",
      actor: as(r.owner),
      via: "cli",
    });
    expect(answer.derivedRules).toEqual([{ id, revoked: true }]);
    expect(ruleState(r.harness, id)).toBe("revoked");
  });

  test("a rule record that cannot be read is named, and the supersede stands", async () => {
    const r = governed();
    const { p } = await ownerRule(r, "notes/a.md");
    const file = join(r.harness, controlPaths(r.harness).standingRulesFile);
    rmSync(file);
    mkdirSync(file);
    const answer = await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: p.id,
      reason: "decided-in-error",
      actor: as(r.owner),
      via: "cli",
    });
    expect(answer.outcome).toBe("superseded");
    expect(answer.derivedRules).toEqual([]);
    expect(answer.ruleError).toContain(`crewhaus approvals rules --dir ${r.harness}`);
  });

  test("a rule record with a line that cannot be read is named, and the rule it holds still ends", async () => {
    const r = governed();
    const { p } = await ownerRule(r, "notes/a.md");
    const file = join(r.harness, controlPaths(r.harness).standingRulesFile);
    // A sealed line that does not parse: a gap the read reports.
    writeFileSync(file, `${readFileSync(file, "utf8")}{ torn\n`);
    const read = readStandingRules(r.harness);
    expect(read.state === "present" && read.anomalies.length > 0).toBe(true);
    const listed = r.service.rules.list(r.harness);
    expect(listed.unreadable.join("\n")).toContain(
      "a settings allow no readable rule names is not loaded",
    );
    const answer = await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: p.id,
      reason: "decided-in-error",
      actor: as(r.owner),
      via: "cli",
    });
    expect(answer.outcome).toBe("superseded");
    expect(answer.derivedRules?.map((d) => d.revoked)).toEqual([true]);
    expect(answer.ruleError).toContain(`crewhaus approvals rules --dir ${r.harness}`);
  });
});

describe("a rule's pattern holds no control or bidirectional-text character", () => {
  test("no narrow rule names such a call, and no wider pattern holds one", () => {
    const harness = tempDir();
    expect(standingPatternFor("Write", { path: "a\u001b[2Jb" }, harness)).toEqual({
      refused: "not-representable",
    });
    expect(standingPatternFor("Write", { path: "a\u202eb.md" }, harness)).toEqual({
      refused: "not-representable",
    });
    expect(widenedPatternProblem("Write", { path: "a.md" }, "Write(a\u202e*)", harness)).toContain(
      "control or bidirectional-text characters",
    );
    expect(widenedPatternProblem("Write", { path: "a.md" }, "Write(a*)", harness)).toBeUndefined();
  });

  test("createStandingRule refuses one and writes nothing", async () => {
    const harness = tempDir();
    for (const pattern of ["Write(a\u202eb)", "Write(a\u0085b)", "Write(a\u001bb)"]) {
      const answer = await createStandingRule({
        harnessDir: harness,
        tool: "Write",
        pattern,
        reason: "approval",
        createdBy: mintId("prn"),
        expiresAt: new Date(NOW + DAY).toISOString(),
        now: NOW,
      });
      expect(answer.ok).toBe(false);
    }
    expect(readStandingRules(harness).state).toBe("absent");
    expect(settingsOf(harness)).toBeUndefined();
    expect(existsSync(join(harness, ".crewhaus"))).toBe(false);
  });
});

describe("a request to the owner is granted only on the terms its approval gives", () => {
  async function filed() {
    const r = governed();
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    const asked = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.maintainer),
      via: "cli",
      always: true,
    });
    if (asked.proposal === undefined) throw new Error("no request filed");
    return { ...r, p, honest: asked.proposal };
  }
  const pendingOf = (harness: string, id: string): string | undefined => {
    const read = readProposals(harness);
    return read.state === "present" ? read.rows.find((row) => row.id === id)?.state : read.state;
  };

  test("a planted whole-tool pattern, a far end and an approval no store holds are invalid, and write nothing", async () => {
    const r = await filed();
    const planted = [
      { ...r.honest, terms: { ...r.honest.terms, pattern: "Write" } },
      { ...r.honest, terms: { ...r.honest.terms, expiresAt: "9999-12-31T00:00:00.000Z" } },
      { ...r.honest, derivedFrom: generateApprovalId() },
      // The tool changed, the pattern kept.
      { ...r.honest, terms: { ...r.honest.terms, tool: "Edit" } },
    ].map((row) => ({ ...row, id: mintId("dec", { now: NOW }) }));
    for (const row of planted) {
      const filedRow = await casAppend(decisionsLedger(r.harness), row.id, null, row);
      expect(filedRow.ok && filedRow.applied).toBe(true);
    }
    for (const row of planted) {
      const answer = await r.service.decisions.resolve({
        harnessDir: r.harness,
        ref: row.id,
        choice: "grant",
        actor: as(r.owner),
        via: "cli",
      });
      expect({ id: row.id, outcome: answer.outcome }).toEqual({ id: row.id, outcome: "invalid" });
      expect(answer.reason).toContain("ask for it again");
      expect(pendingOf(r.harness, row.id)).toBe("pending");
    }
    expect(readStandingRules(r.harness).state).toBe("absent");
    expect(settingsOf(r.harness)).toBeUndefined();
    // The honest request still grants.
    const honest = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: r.honest.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
    });
    expect(honest.outcome).toBe("decided");
    expect(honest.rule?.pattern).toBe("Write(notes/a.md)");
  });

  test("a request derived from an approval nobody granted, or one denied, is invalid", async () => {
    const r = await filed();
    const waiting = await park(r.harness, "Write", { path: "notes/b.md" });
    const denied = await park(r.harness, "Write", { path: "notes/c.md" });
    const no = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: denied.id,
      choice: "deny",
      actor: as(r.owner),
      via: "cli",
    });
    expect(no.outcome).toBe("decided");
    const planted = [
      { from: waiting.id, pattern: "Write(notes/b.md)" },
      { from: denied.id, pattern: "Write(notes/c.md)" },
    ].map(({ from, pattern }) => ({
      ...r.honest,
      id: mintId("dec", { now: NOW }),
      derivedFrom: from,
      terms: { ...r.honest.terms, pattern },
    }));
    for (const row of planted) {
      await casAppend(decisionsLedger(r.harness), row.id, null, row);
      const answer = await r.service.decisions.resolve({
        harnessDir: r.harness,
        ref: row.id,
        choice: "grant",
        actor: as(r.owner),
        via: "cli",
      });
      expect({ from: row.derivedFrom, outcome: answer.outcome }).toEqual({
        from: row.derivedFrom,
        outcome: "invalid",
      });
      expect(pendingOf(r.harness, row.id)).toBe("pending");
    }
    expect(readStandingRules(r.harness).state).toBe("absent");
    expect(settingsOf(r.harness)).toBeUndefined();
  });

  test("a request whose end holds control characters is not listed, not granted, and no rule keeps it", async () => {
    const r = await filed();
    // A date that parses, with a comment holding control characters.
    const end = "Tue Dec 01 2026 00:00:00 GMT+0000 (\r\u001b[2K  dec_x  Read(README.md))";
    expect(Number.isFinite(Date.parse(end))).toBe(true);
    const row = {
      ...r.honest,
      id: mintId("dec", { now: NOW }),
      terms: { ...r.honest.terms, expiresAt: end },
    };
    await casAppend(decisionsLedger(r.harness), row.id, null, row);
    const listed = r.service.rules.list(r.harness);
    expect(JSON.stringify(listed).includes(r.honest.id)).toBe(true);
    expect(JSON.stringify(listed).includes("\u001b")).toBe(false);
    expect(JSON.stringify(listed).includes(row.id)).toBe(false);
    const answer = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: row.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
    });
    expect(answer.outcome).not.toBe("decided");
    expect(readStandingRules(r.harness).state).toBe("absent");
    expect(ruleEndProblem(end, NOW)).toBe("the rule's end is not a time");
    const made = await createStandingRule({
      harnessDir: r.harness,
      tool: "Write",
      pattern: "Write(notes/a.md)",
      reason: "approval",
      createdBy: r.owner,
      expiresAt: end,
      now: NOW,
    });
    expect(made.ok).toBe(false);
    expect(readStandingRules(r.harness).state).toBe("absent");
  });

  test("a request whose approval was superseded is invalid", async () => {
    const r = await filed();
    const sup = await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: r.p.id,
      reason: "policy-changed",
      actor: as(r.owner),
      via: "cli",
    });
    expect(sup.outcome).toBe("superseded");
    const answer = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: r.honest.id,
      choice: "grant",
      actor: as(r.owner),
      via: "cli",
    });
    expect(answer.outcome).toBe("invalid");
    expect(pendingOf(r.harness, r.honest.id)).toBe("pending");
    expect(readStandingRules(r.harness).state).toBe("absent");
  });

  test("a deny needs none of it", async () => {
    const r = await filed();
    const row = { ...r.honest, id: mintId("dec", { now: NOW }), derivedFrom: generateApprovalId() };
    await casAppend(decisionsLedger(r.harness), row.id, null, row);
    const answer = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: row.id,
      choice: "deny",
      actor: as(r.owner),
      via: "cli",
    });
    expect(answer.outcome).toBe("decided");
    expect(pendingOf(r.harness, row.id)).toBe("denied");
  });

  test("no rule lasts more than 365 days from when it is made", async () => {
    const harness = tempDir();
    const write = (expiresAt: string) =>
      createStandingRule({
        harnessDir: harness,
        tool: "Write",
        pattern: "Write(a.md)",
        reason: "approval",
        createdBy: mintId("prn"),
        expiresAt,
        now: NOW,
      });
    const past = await write(new Date(NOW + 365 * DAY + 1).toISOString());
    expect(past.ok).toBe(false);
    expect(readStandingRules(harness).state).toBe("absent");
    expect((await write(new Date(NOW).toISOString())).ok).toBe(false);
    expect((await write("not a time")).ok).toBe(false);
    expect(ruleEndProblem(new Date(NOW + 365 * DAY).toISOString(), NOW)).toBeUndefined();
    const longest = await write(new Date(NOW + 365 * DAY).toISOString());
    expect(longest.ok).toBe(true);
  });
});

describe("a local user decides only through the Home that wrote the harness's approver list", () => {
  const RAE = { username: "rae", hostname: "laptop" } as const;
  const local = { kind: "local", identity: RAE } as const;

  async function homeWithMember() {
    const r = rig();
    const owner = await setUpOwner(r.hangarRoot);
    const member = linkLocalMember(r.hangarRoot, RAE, owner);
    return { ...r, owner, member };
  }

  test("principalOf names the member under the root that wrote it, and nobody under another", async () => {
    const r = await homeWithMember();
    const members = [{ principal: r.member, decide: "operator" }];
    const ours = tempDir();
    plantProjection(ours, r.owner, members, { accessRoot: realpathSync(r.hangarRoot) });
    const theirs = tempDir();
    plantProjection(theirs, r.owner, members, { accessRoot: tempDir("another-home-") });
    expect(r.service.decisions.principalOf(local, ours)).toEqual({ principal: r.member });
    expect(r.service.decisions.principalOf(local, theirs)).toEqual({});
    expect(r.service.decisions.mayManageRules(theirs, local)).toBe(false);
    // With no harness named, the access records answer as they are.
    expect(r.service.decisions.principalOf(local)).toEqual({ principal: r.member });
  });

  test("a decision under another root is refused as having no principal, and nothing is decided", async () => {
    const r = await homeWithMember();
    plantProjection(r.harness, r.owner, [{ principal: r.member, decide: "operator" }], {
      accessRoot: tempDir("another-home-"),
    });
    const p = await park(r.harness, "Write", { path: "a.md" });
    const answer = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: local,
      via: "cli",
    });
    expect(answer.outcome).toBe("forbidden");
    expect(answer.reason).toContain("Sign in to Home, or ask its owner.");
    const folded = foldReadOnly(join(r.harness, ".crewhaus", "sessions"));
    expect(folded.records[0]?.decision).toBeUndefined();
  });

  test("a list that names no Home root asks for crewhaus access sync, for every decision", async () => {
    const r = await homeWithMember();
    plantProjection(r.harness, r.owner, [{ principal: r.member, decide: "maintainer" }], {
      accessRoot: null,
    });
    const p = await park(r.harness, "Write", { path: "a.md" });
    const decide = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: local,
      via: "cli",
    });
    expect(decide.outcome).toBe("forbidden");
    expect(decide.reason).toContain("crewhaus access sync");
    const supersede = await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: p.id,
      reason: "other",
      actor: local,
      via: "cli",
    });
    expect(supersede.outcome).toBe("forbidden");
    expect(supersede.reason).toContain("crewhaus access sync");
    const defer = await r.service.decisions.defer({
      harnessDir: r.harness,
      ref: p.id,
      until: new Date(NOW + DAY).toISOString(),
      reason: "awaiting-information",
      actor: local,
      via: "cli",
    });
    expect(defer.outcome).toBe("forbidden");
    expect(r.service.decisions.principalOf(local, r.harness)).toEqual({});
    // A principal Home signed in is asked the same.
    const byOwner = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: as(r.owner),
      via: "home",
    });
    expect(byOwner.outcome).toBe("forbidden");
    expect(byOwner.reason).toContain("crewhaus access sync");
    expect(
      foldReadOnly(join(r.harness, ".crewhaus", "sessions")).records[0]?.decision,
    ).toBeUndefined();
  });

  test("a principal under a Home root that did not write the list is forbidden, and nothing is decided", async () => {
    const r = await homeWithMember();
    plantProjection(r.harness, r.owner, [{ principal: r.member, decide: "operator" }], {
      accessRoot: tempDir("another-home-"),
    });
    const p = await park(r.harness, "Write", { path: "a.md" });
    for (const actor of [as(r.owner), as(r.member)]) {
      const answer = await r.service.decisions.resolve({
        harnessDir: r.harness,
        ref: p.id,
        choice: "grant",
        actor,
        via: "home",
      });
      expect(answer.outcome).toBe("forbidden");
      expect(answer.reason).toContain("Sign in to Home, or ask its owner.");
    }
    const supersede = await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: p.id,
      reason: "other",
      actor: as(r.owner),
      via: "home",
    });
    expect(supersede.outcome).toBe("forbidden");
    expect(r.service.decisions.mayManageRules(r.harness, as(r.owner))).toBe(false);
    expect(r.service.decisions.principalOf(as(r.owner), r.harness)).toEqual({});
    const folded = foldReadOnly(join(r.harness, ".crewhaus", "sessions"));
    expect(folded.records[0]?.decision).toBeUndefined();
  });

  test("the Home root read is the one checked, even when its path is a link that moves", async () => {
    // Root B links the stranger to A's owner; the harness's list names A. The decision
    // service is given a link that leads to B, and moves to A each time the list is read.
    const a = await homeWithMember();
    const bRoot = tempDir("home-b-");
    const ZED = { username: "zed", hostname: "laptop" } as const;
    const bOwner = await setUpOwner(bRoot, { username: "bea", hostname: "laptop" });
    // B's own records hold A's owner id as an active member, linked from ZED.
    linkLocalMember(bRoot, ZED, bOwner, a.owner);
    plantProjection(a.harness, a.owner, [], { accessRoot: realpathSync(a.hangarRoot) });
    const p = await park(a.harness, "Write", { path: "a.md" });
    const linkDir = tempDir("home-link-");
    const link = join(linkDir, "root");
    try {
      symlinkSync(bRoot, link, "dir");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }
    // Windows removes a directory link with rmdir; elsewhere it is an unlink.
    const relink = (target: string): void => {
      if (process.platform === "win32") rmdirSync(link);
      else unlinkSync(link);
      symlinkSync(target, link, "dir");
    };
    try {
      relink(bRoot);
    } catch (err) {
      // A runner that cannot move a directory link cannot run this case.
      if (process.platform === "win32") return;
      throw err;
    }
    let flips = 0;
    const decisions = createDecisions({
      hangarRoot: link,
      identity: ZED,
      now: () => NOW,
      approvers: (dir) => {
        relink(flips++ % 2 === 0 ? a.hangarRoot : bRoot);
        return readApproverProjection(dir);
      },
    });
    const answer = await decisions.resolve({
      harnessDir: a.harness,
      ref: p.id,
      choice: "grant",
      actor: { kind: "local", identity: ZED },
      via: "cli",
    });
    expect(answer.outcome).toBe("forbidden");
    expect(
      foldReadOnly(join(a.harness, ".crewhaus", "sessions")).records[0]?.decision,
    ).toBeUndefined();
  });
});

describe("a session root reached through a link", () => {
  test("is matched to the harness it lies in, which governs it", () => {
    const h = tempDir();
    mkdirSync(join(h, ".crewhaus", "sessions"), { recursive: true });
    plantProjection(h, mintId("prn"));
    const link = join(tempDir(), "sessions");
    try {
      symlinkSync(join(h, ".crewhaus", "sessions"), link, "dir");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }
    expect(harnessForSessionRoot(link, { cwd: tempDir() })).toEqual({ state: "one", dir: h });
    expect(governedAncestorOf(link)).toBe(h);
    expect(governedAncestorOf(join(tempDir(), "s"))).toBeUndefined();
  });
});
