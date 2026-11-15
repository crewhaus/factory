import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import {
  readApproverProjection,
  readProposals,
  readStandingRules,
} from "@crewhaus/control-records";
import { createPendingApprovalStore } from "@crewhaus/session-store";
import {
  APPROVAL_GONE,
  approvalStillStands,
  authorizerFor,
  resolveToolApproval,
} from "./approval-resolve";
import { NOW, park, plantProjection, removeTempDirs, rig, settingsOf } from "./test-helpers";

afterAll(removeTempDirs);

describe("resolveToolApproval, called directly", () => {
  const sessions = (harness: string) => join(harness, ".crewhaus", "sessions");

  test("the owner's always makes the call's narrow rule, named by the stored actor it is given", async () => {
    const r = rig();
    const owner = mintId("prn");
    plantProjection(r.harness, owner);
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    let asked = 0;
    const answer = await resolveToolApproval(
      {
        harnessDir: r.harness,
        rootDir: sessions(r.harness),
        ref: p.id,
        choice: "grant",
        who: { principal: owner },
        storeActor: { principal: owner, display: "slack" },
        storedBy: async () => {
          asked += 1;
          return owner;
        },
        via: "slack",
        always: true,
      },
      { now: () => NOW },
    );
    expect(answer.outcome).toBe("decided");
    expect(answer.record?.decidedBy).toBe("slack");
    expect(answer.record?.decidedVia).toBe("slack");
    expect(answer.record?.always).toBe(true);
    expect(answer.rule?.pattern).toBe("Write(notes/a.md)");
    expect(answer.rule?.createdBy).toBe(owner);
    expect(asked).toBe(1);
    const rules = readStandingRules(r.harness);
    expect(rules.state === "present" && rules.rows.length).toBe(1);
    expect(settingsOf(r.harness)).toEqual({
      permissions: { rules: [{ type: "alwaysAllow", pattern: "Write(notes/a.md)" }] },
    });
  });

  test("a member's always grants once and files one request to the owner", async () => {
    const r = rig();
    const owner = mintId("prn");
    const member = mintId("prn");
    plantProjection(r.harness, owner, [{ principal: member, decide: "maintainer" }]);
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    const answer = await resolveToolApproval(
      {
        harnessDir: r.harness,
        rootDir: sessions(r.harness),
        ref: p.id,
        choice: "grant",
        who: { principal: member },
        storeActor: { principal: member },
        storedBy: async () => member,
        via: "slack",
        always: true,
      },
      { now: () => NOW },
    );
    expect(answer.outcome).toBe("decided");
    expect(answer.record?.always).toBeUndefined();
    expect(answer.record?.decidedByPrincipal).toBe(member);
    expect(answer.proposal?.terms.pattern).toBe("Write(notes/a.md)");
    expect(answer.proposal?.proposedBy).toBe(member);
    const proposals = readProposals(r.harness);
    expect(proposals.state === "present" && proposals.rows.length).toBe(1);
    expect(settingsOf(r.harness)).toBeUndefined();
  });

  test("a stored actor is never asked for when nothing was decided", async () => {
    const r = rig();
    const owner = mintId("prn");
    const operator = mintId("prn");
    plantProjection(r.harness, owner, [{ principal: operator, decide: "operator" }]);
    const p = await park(r.harness, "Write", { path: "a.md" }, { requiredClass: "maintainer" });
    let asked = 0;
    const answer = await resolveToolApproval(
      {
        harnessDir: r.harness,
        rootDir: sessions(r.harness),
        ref: p.id,
        choice: "grant",
        who: { principal: operator },
        storeActor: { principal: operator },
        storedBy: async () => {
          asked += 1;
          return operator;
        },
        via: "slack",
        always: true,
      },
      { now: () => NOW },
    );
    expect(answer.outcome).toBe("forbidden");
    expect(answer.reason).toBe("Needs a maintainer.");
    expect(asked).toBe(0);
  });

  test("an id that is not an approval id is refused before any read", async () => {
    const answer = await resolveToolApproval(
      {
        rootDir: "/nonexistent",
        ref: "../../etc",
        choice: "grant",
        who: {},
        storeActor: {},
        storedBy: async () => "x",
        via: "slack",
      },
      { now: () => NOW },
    );
    expect(answer.outcome).toBe("invalid");
  });
});

describe("authorizerFor", () => {
  const judged = { approvers: () => ({ state: "absent" as const }), now: () => NOW };
  const ask = (requiredClass: "operator" | "maintainer" | "owner", who: object) =>
    authorizerFor(
      undefined,
      who,
      judged,
    )({
      op: "decide",
      record: {} as never,
      requiredClass,
    });

  test("with no harness, a service decides operator requests only", async () => {
    const service = { principal: mintId("prn"), service: true as const };
    expect(await ask("maintainer", service)).toEqual({ ok: false, reason: "Needs a maintainer." });
    expect(await ask("owner", service)).toEqual({ ok: false, reason: "Needs the owner." });
    expect(await ask("operator", service)).toEqual({ ok: true, principal: service.principal });
  });

  test("with no harness, a person decides at every class, recorded when named", async () => {
    const principal = mintId("prn");
    expect(await ask("owner", { principal })).toEqual({ ok: true, principal });
    expect(await ask("maintainer", {})).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// What a channel daemon loads with it
// ---------------------------------------------------------------------------

const PACKAGES = resolve(import.meta.dir, "..", "..");

/** The Home packages a compiled daemon must not load through this module. */
const HOME_PACKAGES = [
  "@crewhaus/access-control",
  "@crewhaus/harness-supervisor",
  "@crewhaus/harness-registry",
  "@crewhaus/deployment-controller",
  "@crewhaus/preflight",
];

/** The package directory of each `@crewhaus/*` name in the workspace. */
function workspacePackages(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, name, "package.json");
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    if (typeof parsed.name === "string") out.set(parsed.name, join(PACKAGES, name));
  }
  return out;
}

/** The file a package's `exports` entry names for a subpath. */
function entryOf(dir: string, subpath: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
    main?: string;
  };
  const target = manifest.exports?.[subpath] ?? (subpath === "." ? manifest.main : undefined);
  if (typeof target === "string") return join(dir, target);
  if (typeof target === "object" && target !== null) {
    const pick =
      (target as Record<string, unknown>)["import"] ??
      (target as Record<string, unknown>)["default"];
    if (typeof pick === "string") return join(dir, pick);
  }
  return undefined;
}

/** A relative specifier as a file: as written, or with `.ts`, or `index.ts` in it. */
function relativeFile(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

/** The value imports and re-exports of one file: `import type` and `export type` are erased. */
function valueSpecifiers(source: string): string[] {
  const found: string[] = [];
  const re = /^\s*(import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (let match = re.exec(source); match !== null; match = re.exec(source)) {
    found.push(match[2] as string);
  }
  return found;
}

/** Every workspace package this module's static value imports reach, and every file read. */
function walk(start: string): { readonly packages: Set<string>; readonly files: number } {
  const workspace = workspacePackages();
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of valueSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const next = relativeFile(file, spec);
        if (next !== undefined) queue.push(next);
        continue;
      }
      const parts = spec.split("/");
      if (parts[0] !== "@crewhaus" || parts[1] === undefined) continue;
      const name = `${parts[0]}/${parts[1]}`;
      const dir = workspace.get(name);
      if (dir === undefined) continue;
      packages.add(name);
      const subpath = parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".";
      const entry = entryOf(dir, subpath);
      if (entry !== undefined) queue.push(entry);
    }
  }
  return { packages, files: seen.size };
}

describe("@crewhaus/control-service/approval-resolve loads no Home package", () => {
  const entry = entryOf(join(PACKAGES, "control-service"), "./approval-resolve");

  test("the subpath is exported, and its static value imports reach none of Home's packages", () => {
    expect(entry).toBe(join(PACKAGES, "control-service", "src", "approval-resolve.ts"));
    const reached = walk(entry as string);
    expect(HOME_PACKAGES.filter((name) => reached.packages.has(name))).toEqual([]);
    // The walk really walks: it reaches the packages the module is built on.
    expect(reached.packages.size).toBeGreaterThanOrEqual(6);
    for (const name of [
      "@crewhaus/control-contract",
      "@crewhaus/control-records",
      "@crewhaus/session-store",
      "@crewhaus/permission-engine",
    ]) {
      expect(reached.packages.has(name)).toBe(true);
    }
  });

  test("the walk sees a value import of the decision service, which reaches Home's access records", () => {
    // A value import of `./decisions` (not the type-only one `./rules` has) is what
    // the first test would catch.
    const decisions = join(PACKAGES, "control-service", "src", "decisions.ts");
    expect(walk(decisions).packages.has("@crewhaus/access-control")).toBe(true);
    expect(
      valueSpecifiers('import type { A } from "./decisions";\nexport type { B } from "./x";'),
    ).toEqual([]);
    expect(
      valueSpecifiers(
        'import { a } from "./decisions";\nexport { b } from "@crewhaus/x";\nimport "./side";',
      ),
    ).toEqual(["./decisions", "@crewhaus/x", "./side"]);
  });
});

describe("a standing rule is made only while the approval it comes from stands", () => {
  const sessions = (harness: string) => join(harness, ".crewhaus", "sessions");
  const supersede = async (harness: string, ref: string) => {
    const store = createPendingApprovalStore({
      rootDir: sessions(harness),
      now: () => new Date(NOW),
    });
    const answer = await store.supersede(
      ref,
      { actor: {}, via: "cli", reason: "decided-in-error" },
      {
        authorize: authorizerFor(
          harness,
          {},
          { approvers: readApproverProjection, now: () => NOW },
        ),
      },
    );
    expect(answer.outcome).toBe("superseded");
  };
  const noRuleFrom = (harness: string, ref: string) => {
    const rules = readStandingRules(harness);
    const rows = rules.state === "present" ? rules.rows : [];
    expect(rows.filter((row) => row.derivedFrom === ref && row.state === "active")).toEqual([]);
    expect(JSON.stringify(settingsOf(harness) ?? {})).not.toContain("alwaysAllow");
  };
  const grant = (harness: string, ref: string, storedBy: () => Promise<string>) => ({
    harnessDir: harness,
    rootDir: sessions(harness),
    ref,
    choice: "grant" as const,
    who: {},
    storeActor: {},
    storedBy,
    via: "cli" as const,
    always: true,
  });

  test("an approval superseded once it is granted makes no rule, and the grant says why", async () => {
    const r = rig();
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    const answer = await resolveToolApproval(
      grant(r.harness, p.id, async () => {
        // The grant is decided; it is superseded before the rule is written.
        await supersede(r.harness, p.id);
        return `local:#${"a".repeat(64)}`;
      }),
      { now: () => NOW },
    );
    expect(answer.outcome).toBe("decided");
    expect(answer.rule).toBeUndefined();
    expect(answer.ruleError).toBe(APPROVAL_GONE);
    noRuleFrom(r.harness, p.id);
  });

  test("an approval superseded just before the rule's step runs makes no rule", async () => {
    const r = rig();
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    const answer = await resolveToolApproval(
      grant(r.harness, p.id, async () => `local:#${"a".repeat(64)}`),
      { now: () => NOW },
      {
        ruleCommand: async (run) => {
          await supersede(r.harness, p.id);
          return run(undefined);
        },
      },
    );
    expect(answer.outcome).toBe("decided");
    expect(answer.ruleError).toBe(APPROVAL_GONE);
    noRuleFrom(r.harness, p.id);
  });

  test("an approval that stands makes its rule", async () => {
    const r = rig();
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    const answer = await resolveToolApproval(
      grant(r.harness, p.id, async () => `local:#${"a".repeat(64)}`),
      { now: () => NOW },
    );
    expect(answer.rule?.derivedFrom).toBe(p.id);
    expect(approvalStillStands(sessions(r.harness), p.id)).toBeUndefined();
  });

  test("approvalStillStands refuses a missing, pending, denied or superseded approval", async () => {
    const r = rig();
    const root = sessions(r.harness);
    expect(approvalStillStands(root, "appr_missing")).toBe(APPROVAL_GONE);
    const pending = await park(r.harness, "Write", { path: "notes/a.md" });
    expect(approvalStillStands(root, pending.id)).toBe(APPROVAL_GONE);
    const denied = await park(r.harness, "Write", { path: "notes/b.md" });
    const no = await resolveToolApproval(
      { ...grant(r.harness, denied.id, async () => ""), choice: "deny", always: false },
      { now: () => NOW },
    );
    expect(no.outcome).toBe("decided");
    expect(approvalStillStands(root, denied.id)).toBe(APPROVAL_GONE);
    const granted = await park(r.harness, "Write", { path: "notes/c.md" });
    const yes = await resolveToolApproval(
      { ...grant(r.harness, granted.id, async () => ""), always: false },
      { now: () => NOW },
    );
    expect(yes.outcome).toBe("decided");
    expect(approvalStillStands(root, granted.id)).toBeUndefined();
    await supersede(r.harness, granted.id);
    expect(approvalStillStands(root, granted.id)).toBe(APPROVAL_GONE);
  });
});
