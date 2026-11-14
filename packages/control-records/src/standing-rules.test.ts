import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { casAppend, casAppendLocked, withLedgerLock } from "./ledger";
import { controlPaths } from "./paths";
import {
  PROPOSAL_TTL_MS,
  createStandingRuleReader,
  decisionsLedger,
  proposalState,
  readProposals,
  readStandingRules,
  ruleIsLive,
  standingRuleOf,
  standingRulesLedger,
} from "./standing-rules";
import { plant, removeTempDirs, snapshotTree, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const T0 = Date.parse("2026-11-12T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const PRN = mintId("prn");
const APPR = "appr_0123456789abcdef";

function rule(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: "allow",
    tool: "Write",
    pattern: "Write(notes/a.md)",
    derivedFrom: APPR,
    createdBy: PRN,
    reason: "approval",
    createdAt: iso(T0),
    expiresAt: iso(T0 + 30 * 86_400_000),
    state: "active",
    ...over,
  };
}

describe("the standing-rule ledger", () => {
  test("lives at .crewhaus/run/control/standing-rules.jsonl on the rule machine, beside the shared lock", () => {
    const root = tempDir();
    const ledger = standingRulesLedger(root);
    expect(ledger.records).toEqual({ file: controlPaths(root).standingRulesFile });
    expect(ledger.machine).toBe("rule");
    expect(ledger.lock).toBe(controlPaths(root).lockFile);
    expect(decisionsLedger(root).lock).toBe(ledger.lock);
    expect(decisionsLedger(root).machine).toBe("decision");
    expect(decisionsLedger(root).records).toEqual({ dir: controlPaths(root).decisionsDir });
  });

  test("absent with no file; a read creates nothing", () => {
    const root = tempDir();
    const before = snapshotTree(root);
    expect(readStandingRules(root)).toEqual({ state: "absent" });
    expect(readProposals(root)).toEqual({ state: "absent" });
    expect(snapshotTree(root)).toEqual(before);
  });

  test("unreadable when its place is a directory", () => {
    const root = tempDir();
    mkdirSync(join(root, controlPaths(root).standingRulesFile), { recursive: true });
    expect(readStandingRules(root).state).toBe("unreadable");
  });

  test("a revoked rule reads revoked, and the machine refuses a move back to active", async () => {
    const root = tempDir();
    const ledger = standingRulesLedger(root);
    const id = mintId("rule");
    expect((await casAppend(ledger, id, null, rule(id))).ok).toBe(true);
    const revoked = await casAppend(ledger, id, "active", {
      ...rule(id),
      state: "revoked",
      revokedAt: iso(T0 + 1),
      revokedBy: PRN,
    });
    expect(revoked.ok && revoked.applied).toBe(true);
    const back = await casAppend(ledger, id, "revoked", rule(id));
    expect(back.ok && !back.applied && back.illegal).toBe(true);
    const read = readStandingRules(root);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.rows.map((r) => [r.id, r.state, r.revokedBy])).toEqual([[id, "revoked", PRN]]);
    // The ledger's bookkeeping never reaches a reader.
    expect(Object.keys(read.rows[0] ?? {})).not.toContain("gen");
    expect(Object.keys(read.rows[0] ?? {})).not.toContain("claim");
  });

  test("a row of another shape is left out and reported, never thrown on", () => {
    const root = tempDir();
    const file = join(root, controlPaths(root).standingRulesFile);
    const good = mintId("rule");
    const bad = mintId("rule");
    plant(
      file,
      `${JSON.stringify(rule(good))}\n${JSON.stringify(rule(bad, { createdBy: "local:sam@laptop" }))}\n{ torn\n`,
    );
    const read = readStandingRules(root);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.rows.map((r) => r.id)).toEqual([good]);
    expect(read.anomalies).toEqual([
      `${bad}: the row is not a standing rule`,
      "1 line(s) cannot be read",
    ]);
    // A raw local actor is refused: only a prn_, a keyed digest or a system actor is stored.
    expect(standingRuleOf(rule(bad, { createdBy: "local:sam@laptop" }))).toBeUndefined();
    expect(standingRuleOf(rule(bad, { reason: "because" }))).toBeUndefined();
    expect(standingRuleOf(rule(bad, { createdBy: `local:#${"a".repeat(64)}` }))).toBeDefined();
  });

  test("a rule's times are read only in the form the writers write", () => {
    const id = mintId("rule");
    expect(standingRuleOf(rule(id))).toBeDefined();
    // A date that parses, with a comment holding control characters.
    const commented = "Tue Dec 01 2026 00:00:00 GMT+0000 (\r\u001b[2K x)";
    expect(Number.isFinite(Date.parse(commented))).toBe(true);
    for (const expiresAt of [commented, "2026-12-01T00:00:00Z", "2026-12-01"]) {
      expect({ expiresAt, row: standingRuleOf(rule(id, { expiresAt })) }).toEqual({
        expiresAt,
        row: undefined,
      });
    }
    expect(standingRuleOf(rule(id, { createdAt: commented }))).toBeUndefined();
  });

  test("live means active and before its end; an end that cannot be read has passed", () => {
    const row = standingRuleOf(rule(mintId("rule")));
    if (row === undefined) throw new Error("not a row");
    const ends = Date.parse(row.expiresAt);
    expect(ruleIsLive(row, ends - 1)).toBe(true);
    expect(ruleIsLive(row, ends)).toBe(false);
    expect(ruleIsLive({ ...row, state: "revoked" }, T0)).toBe(false);
    expect(ruleIsLive({ ...row, expiresAt: "soon" }, T0)).toBe(false);
  });

  test("the cached reader answers from its cache for one second, by the injected clock", async () => {
    const root = tempDir();
    let now = T0;
    const read = createStandingRuleReader({ now: () => now });
    expect(read(root).state).toBe("absent");
    const id = mintId("rule");
    await casAppend(standingRulesLedger(root), id, null, rule(id));
    now += 999;
    expect(read(root).state).toBe("absent");
    now += 2;
    expect(read(root).state).toBe("present");
  });
});

describe("casAppendLocked", () => {
  test("one lock covers a compare-and-set on two ledgers that share it", async () => {
    const root = tempDir();
    const dec = mintId("dec");
    const id = mintId("rule");
    const answer = await withLedgerLock(standingRulesLedger(root), async () => {
      const proposal = await casAppendLocked(decisionsLedger(root), dec, null, {
        kind: "standing-rule-proposal",
        createdAt: iso(T0),
        expiresAt: iso(T0 + PROPOSAL_TTL_MS),
        requiredClass: "owner",
        derivedFrom: APPR,
        proposedBy: PRN,
        terms: { ruleKind: "allow", tool: "Write", pattern: "Write(a)", expiresAt: iso(T0) },
        state: "pending",
      });
      const made = await casAppendLocked(standingRulesLedger(root), id, null, rule(id));
      return [proposal.ok && proposal.applied, made.ok && made.applied];
    });
    expect(answer).toEqual([true, true]);
    expect(readProposals(root).state).toBe("present");
    expect(readStandingRules(root).state).toBe("present");
    // Size segments: the requests' directory holds numbered files.
    expect(
      readdirSync(join(root, controlPaths(root).decisionsDir)).every((name) =>
        /^\d{6}\.jsonl$/.test(name),
      ),
    ).toBe(true);
  });

  test("the first decision on a request wins by its generation claim", async () => {
    const root = tempDir();
    const ledger = decisionsLedger(root);
    const dec = mintId("dec");
    const pending = {
      kind: "standing-rule-proposal",
      createdAt: iso(T0),
      expiresAt: iso(T0 + PROPOSAL_TTL_MS),
      requiredClass: "owner",
      derivedFrom: APPR,
      proposedBy: PRN,
      terms: { ruleKind: "allow", tool: "Write", pattern: "Write(a)", expiresAt: iso(T0) },
      state: "pending",
    };
    await casAppend(ledger, dec, null, pending);
    const [a, b] = await Promise.all([
      casAppend(ledger, dec, "pending", { ...pending, state: "granted", decision: "grant" }),
      casAppend(ledger, dec, "pending", { ...pending, state: "denied", decision: "deny" }),
    ]);
    const applied = [a, b].filter((x) => x.ok && x.applied);
    expect(applied).toHaveLength(1);
    const claims = join(root, controlPaths(root).claimsDir, "gen", dec);
    expect(readFileSync(join(claims, "2.json"), "utf8")).toContain('"state":"');
  });
});

describe("a request to the owner", () => {
  test("reads expired once it has waited past its end, and a read writes nothing", async () => {
    const root = tempDir();
    const dec = mintId("dec");
    await casAppend(decisionsLedger(root), dec, null, {
      kind: "standing-rule-proposal",
      createdAt: iso(T0),
      expiresAt: iso(T0 + PROPOSAL_TTL_MS),
      requiredClass: "owner",
      derivedFrom: APPR,
      proposedBy: PRN,
      terms: { ruleKind: "allow", tool: "Write", pattern: "Write(a)", expiresAt: iso(T0) },
      state: "pending",
    });
    const before = snapshotTree(root);
    const read = readProposals(root);
    if (read.state !== "present") throw new Error(read.state);
    const row = read.rows[0];
    if (row === undefined) throw new Error("no row");
    expect(proposalState(row, T0 + PROPOSAL_TTL_MS)).toBe("pending");
    expect(proposalState(row, T0 + PROPOSAL_TTL_MS + 1)).toBe("expired");
    expect(proposalState({ ...row, state: "granted" }, T0 + PROPOSAL_TTL_MS + 1)).toBe("granted");
    expect(snapshotTree(root)).toEqual(before);
  });
});
