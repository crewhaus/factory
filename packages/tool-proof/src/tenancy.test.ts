/**
 * Inside a tenant scope — every managed turn runs in its request's
 * `withTenant` — the proof tools file artifacts under the tenant's own root
 * and read only its sessions, and a root outside the tenant fails closed
 * (design §5.3, §8; `./lib/roots`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createBuiltinChecker } from "@crewhaus/proof-checker";
import { proofsRoot } from "@crewhaus/provability";
import { TenancyError, type Tenant, buildTenant, withTenant } from "@crewhaus/tenancy";
import type { ToolExecuteContext } from "@crewhaus/tool-catalog";
import {
  ProofToolError,
  createProofTools,
  defaultProofsRoot,
  defaultSessionRoot,
  tenantRootOf,
} from "./index";
import {
  MEETINGS,
  SESSION,
  call,
  config,
  fakeRun,
  fetched,
  now,
  tempDirs,
  userMessage,
  writeLog,
} from "./test-helpers";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
type Json = any;

const POLICY = "https://acme.example/policy";
const BODY = "Refunds are accepted within 14 days of purchase when the item is unused.";
const GROUNDED = `Refunds are accepted within 14 days of purchase [1].\n\n[1]: ${POLICY}\n`;

function artifactsUnder(root: string): string[] {
  const dir = join(root, "artifacts");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

async function run<T>(tenant: Tenant, fn: () => Promise<T>): Promise<T> {
  return (await withTenant(tenant, fn)) as T;
}

async function runTool(
  tool: { execute(input: unknown, ctx?: ToolExecuteContext): Promise<unknown> },
  input: unknown,
  ctx: ToolExecuteContext,
): Promise<Json> {
  return JSON.parse((await tool.execute(input, ctx)) as string);
}

describe("artifacts are filed under the active tenant's root", () => {
  test("ProofCheck inside withTenant writes under <tenantRoot>/proofs/<spec>, nothing under the workspace", async () => {
    const cwd = dirs.make();
    const tenants = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    const tools = createProofTools({ workspaceRoot: cwd, checkers: [createBuiltinChecker()], now });
    const out = await run(acme, () =>
      runTool(tools.proofCheck, { checker: "builtin", ...MEETINGS }, fakeRun().ctx),
    );
    expect(out.ok).toBe(true);
    const root = join(tenants, "acme", "proofs", "default");
    expect(defaultProofsRoot(cwd, "default", acme)).toBe(root);
    expect(artifactsUnder(root)).toEqual([`${out.id}.json`]);
    expect(existsSync(join(cwd, ".crewhaus"))).toBe(false);
    // The spec name the run carries still names the directory.
    const named = await run(acme, () =>
      runTool(
        tools.proofCheck,
        { checker: "builtin", ...MEETINGS },
        fakeRun({ specName: "support-bot" }).ctx,
      ),
    );
    expect(artifactsUnder(join(tenants, "acme", "proofs", "support-bot"))).toEqual([
      `${named.id}.json`,
    ]);
    // Outside any tenant the same tools use the workspace, as before.
    const plain = await runTool(
      tools.proofCheck,
      { checker: "builtin", ...MEETINGS },
      fakeRun().ctx,
    );
    expect(artifactsUnder(join(cwd, ".crewhaus", "proofs", "default"))).toEqual([
      `${plain.id}.json`,
    ]);
  });

  test("one tenant's proof is proven in its own preflight and missing in another's", async () => {
    const cwd = dirs.make();
    const tenants = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    const globex = buildTenant("globex", { tenantsRoot: tenants });
    const tools = createProofTools({
      config: config("proven"),
      workspaceRoot: cwd,
      checkers: [createBuiltinChecker()],
      now,
    });
    const proof = await run(acme, () =>
      runTool(tools.proofCheck, { checker: "builtin", ...MEETINGS }, fakeRun().ctx),
    );
    const draft = `No two of the three meetings overlap [1].\n\n[1]: proof:${proof.id}\n`;
    const own = await run(acme, () =>
      runTool(
        tools.provabilityPreflight,
        { draft },
        fakeRun({ sessionRootDir: acme.sessionRoot }).ctx,
      ),
    );
    expect(own.verdict).toBe("pass");
    expect(own.table[0].evidence[0]).toMatchObject({ kind: "formal", rung: "proven", ok: true });
    const other = await run(globex, () =>
      runTool(
        tools.provabilityPreflight,
        { draft },
        fakeRun({ sessionRootDir: globex.sessionRoot }).ctx,
      ),
    );
    expect(other.verdict).toBe("fail");
    expect(other.table[0].evidence[0].reason).toBe("proof_missing");
  });

  test("a proofs root outside the tenant is refused before the check runs; nothing is written", async () => {
    const tenants = dirs.make();
    const outside = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    let checked = 0;
    const builtin = createBuiltinChecker();
    const tools = createProofTools({
      proofsRoot: outside,
      checkers: [
        {
          ...builtin,
          id: builtin.id,
          language: builtin.language,
          available: () => builtin.available(),
          check: (input) => {
            checked += 1;
            return builtin.check(input);
          },
        },
      ],
    });
    const err = await run(acme, () =>
      tools.proofCheck.execute({ checker: "builtin", ...MEETINGS }, fakeRun().ctx),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenancyError);
    expect((err as Error).message).toContain("cross-tenant access denied");
    expect(checked).toBe(0);
    expect(artifactsUnder(outside)).toEqual([]);
    // The preflight refuses to read it too.
    const pre = await run(acme, () =>
      tools.provabilityPreflight.execute({ draft: GROUNDED }, fakeRun().ctx),
    ).catch((e: unknown) => e);
    expect(pre).toBeInstanceOf(TenancyError);
    // The same root outside any tenant is the caller's to choose.
    const ok = await runTool(tools.proofCheck, { checker: "builtin", ...MEETINGS }, fakeRun().ctx);
    expect(artifactsUnder(outside)).toEqual([`${ok.id}.json`]);
  });
});

describe("a composition root builds the tools once, at boot, and serves every tenant", () => {
  // An emitted bundle's boot block runs before any request, so no tenant is
  // active when it calls createProofTools; each managed turn then runs in
  // its own withTenant.
  test("given specName and workspaceRoot, each call files under its own tenant's root", async () => {
    const cwd = dirs.make();
    const tenants = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    const globex = buildTenant("globex", { tenantsRoot: tenants });
    const tools = createProofTools({
      config: config("proven"),
      specName: "support",
      workspaceRoot: cwd,
      checkers: [createBuiltinChecker()],
      now,
    });
    const a = await run(acme, () =>
      runTool(tools.proofCheck, { checker: "builtin", ...MEETINGS }, fakeRun().ctx),
    );
    const g = await run(globex, () =>
      runTool(tools.proofCheck, { checker: "builtin", ...MEETINGS }, fakeRun().ctx),
    );
    const plain = await runTool(
      tools.proofCheck,
      { checker: "builtin", ...MEETINGS },
      fakeRun().ctx,
    );
    expect(artifactsUnder(join(tenants, "acme", "proofs", "support"))).toEqual([`${a.id}.json`]);
    expect(artifactsUnder(join(tenants, "globex", "proofs", "support"))).toEqual([`${g.id}.json`]);
    expect(artifactsUnder(proofsRoot(cwd, "support"))).toEqual([`${plain.id}.json`]);
    // The gate resolves its store the same way, per turn, so the citation holds there.
    const draft = `No two of the three meetings overlap [1].\n\n[1]: proof:${a.id}\n`;
    const pre = await run(acme, () =>
      runTool(
        tools.provabilityPreflight,
        { draft },
        fakeRun({ sessionRootDir: acme.sessionRoot }).ctx,
      ),
    );
    expect(pre.verdict).toBe("pass");
    expect(defaultProofsRoot(cwd, "support", acme)).toBe(
      join(tenants, "acme", "proofs", "support"),
    );
  });

  test("a fixed proofsRoot resolved at boot is refused in every managed turn — the trap the option's doc names", async () => {
    const cwd = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: dirs.make() });
    const tools = createProofTools({
      proofsRoot: proofsRoot(cwd, "support"),
      workspaceRoot: cwd,
      checkers: [createBuiltinChecker()],
    });
    const err = await run(acme, () =>
      tools.proofCheck.execute({ checker: "builtin", ...MEETINGS }, fakeRun().ctx),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenancyError);
    const pre = await run(acme, () =>
      tools.provabilityPreflight.execute({ draft: GROUNDED }, fakeRun().ctx),
    ).catch((e: unknown) => e);
    expect(pre).toBeInstanceOf(TenancyError);
  });

  test("a proofsRoot resolver is asked on every call, with the call's tenant", async () => {
    const cwd = dirs.make();
    const tenants = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    const asked: Array<string | undefined> = [];
    const tools = createProofTools({
      proofsRoot: (tenant) => {
        asked.push(tenant?.id);
        return defaultProofsRoot(cwd, "support", tenant);
      },
      workspaceRoot: cwd,
      checkers: [createBuiltinChecker()],
      now,
    });
    const a = await run(acme, () =>
      runTool(tools.proofCheck, { checker: "builtin", ...MEETINGS }, fakeRun().ctx),
    );
    const plain = await runTool(
      tools.proofCheck,
      { checker: "builtin", ...MEETINGS },
      fakeRun().ctx,
    );
    expect(asked).toEqual(["acme", undefined]);
    expect(artifactsUnder(join(tenants, "acme", "proofs", "support"))).toEqual([`${a.id}.json`]);
    expect(artifactsUnder(proofsRoot(cwd, "support"))).toEqual([`${plain.id}.json`]);
  });

  test("a resolver's root is still fenced, and one that returns no directory is refused", async () => {
    const acme = buildTenant("acme", { tenantsRoot: dirs.make() });
    const outside = dirs.make();
    const escaping = createProofTools({
      proofsRoot: () => outside,
      checkers: [createBuiltinChecker()],
    });
    const err = await run(acme, () =>
      escaping.proofCheck.execute({ checker: "builtin", ...MEETINGS }, fakeRun().ctx),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenancyError);
    expect(artifactsUnder(outside)).toEqual([]);
    const empty = createProofTools({
      proofsRoot: () => "",
      checkers: [createBuiltinChecker()],
    });
    const none = await empty.proofCheck
      .execute({ checker: "builtin", ...MEETINGS }, fakeRun().ctx)
      .catch((e: unknown) => e);
    expect(none).toBeInstanceOf(ProofToolError);
    expect((none as Error).message).toContain("proofsRoot resolver returned no directory");
  });

  test("a sessionRootDir resolver reads the call's tenant's sessions", async () => {
    const tenants = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    const globex = buildTenant("globex", { tenantsRoot: tenants });
    await writeLog(acme.sessionRoot, SESSION, [
      userMessage("what is the refund window?"),
      ...call("toolu_fetch1", "WebFetch", { url: POLICY }, fetched(POLICY, BODY)),
    ]);
    const tools = createProofTools({
      sessionRootDir: (tenant) => tenant?.sessionRoot ?? dirs.make(),
      workspaceRoot: dirs.make(),
      checkers: [createBuiltinChecker()],
      now,
    });
    const own = await run(acme, () =>
      runTool(tools.provabilityPreflight, { draft: GROUNDED }, fakeRun().ctx),
    );
    expect(own.verdict).toBe("pass");
    const other = await run(globex, () =>
      runTool(tools.provabilityPreflight, { draft: GROUNDED }, fakeRun().ctx),
    );
    expect(other.verdict).toBe("fail");
  });
});

describe("evidence is read from the tenant's sessions", () => {
  async function fetchedPolicy(sessions: string): Promise<void> {
    await writeLog(sessions, SESSION, [
      userMessage("what is the refund window?"),
      ...call("toolu_fetch1", "WebFetch", { url: POLICY }, fetched(POLICY, BODY)),
    ]);
  }

  test("with no root from the run, the tenant's sessionRoot is the one read", async () => {
    const tenants = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    await fetchedPolicy(acme.sessionRoot);
    const tools = createProofTools({
      workspaceRoot: dirs.make(),
      checkers: [createBuiltinChecker()],
      now,
    });
    // fakeRun() hands over no sessionRootDir.
    const out = await run(acme, () =>
      runTool(tools.provabilityPreflight, { draft: GROUNDED }, fakeRun().ctx),
    );
    expect(out.verdict).toBe("pass");
    expect(defaultSessionRoot(acme)).toBe(acme.sessionRoot);
  });

  test("a sessions root outside the tenant is refused", async () => {
    const tenants = dirs.make();
    const elsewhere = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    await fetchedPolicy(elsewhere);
    const tools = createProofTools({
      workspaceRoot: dirs.make(),
      sessionRootDir: elsewhere,
      checkers: [createBuiltinChecker()],
    });
    const err = await run(acme, () =>
      tools.provabilityPreflight.execute({ draft: GROUNDED }, fakeRun().ctx),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenancyError);
    // And one the run hands over from outside the tenant, likewise.
    const viaRun = createProofTools({
      workspaceRoot: dirs.make(),
      checkers: [createBuiltinChecker()],
    });
    const err2 = await run(acme, () =>
      viaRun.provabilityPreflight.execute(
        { draft: GROUNDED },
        fakeRun({ sessionRootDir: elsewhere }).ctx,
      ),
    ).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(TenancyError);
  });

  test("outside a tenant the default is CREWHAUS_SESSION_DIR when set, as the runtime reads it", () => {
    const prior = process.env["CREWHAUS_SESSION_DIR"];
    try {
      process.env["CREWHAUS_SESSION_DIR"] = "/srv/sessions";
      expect(defaultSessionRoot(undefined)).toBe("/srv/sessions");
      process.env["CREWHAUS_SESSION_DIR"] = "";
      expect(defaultSessionRoot(undefined)).toBeUndefined();
      Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
      expect(defaultSessionRoot(undefined)).toBeUndefined();
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
      else process.env["CREWHAUS_SESSION_DIR"] = prior;
    }
  });

  test("the tenant's root is the parent of its sessionRoot (continuity-store's rule)", () => {
    const acme = buildTenant("acme", { tenantsRoot: "/srv/tenants" });
    expect(tenantRootOf(acme)).toBe("/srv/tenants/acme");
  });
});
