/**
 * Item 49 — unit tests for the scope-audit drift watch: stable finding ids,
 * snapshot building (actionable filter), the baseline diff gate, snapshot
 * load/validate, and the boundary-drift detector over fixture trees.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PhilosophyFinding,
  ScopeAuditBaselineError,
  buildScopeAuditSnapshot,
  detectBoundaryDrift,
  diffScopeAuditSnapshots,
  findingId,
  isActionableFinding,
  loadScopeAuditSnapshot,
  renderGateReport,
  scopeAuditBaselinePath,
  scopeAuditSnapshotPath,
} from "./scope-audit-drift";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-scope-audit-drift-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function finding(overrides: Partial<PhilosophyFinding> = {}): PhilosophyFinding {
  return {
    class: "boundary-site",
    file: "packages/tool-mcp/src/index.ts",
    symbol: "tool-mcp",
    label: "Pillar 3 — tool-mcp calls classifyBoundary",
    pass: false,
    reason: "no reference to classifyBoundary — security regression",
    ...overrides,
  };
}

describe("findingId", () => {
  test("is stable across label/reason rewording", () => {
    const a = findingId(finding());
    const b = findingId(finding({ label: "reworded", reason: "totally different text" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  test("changes when any identity component changes", () => {
    const base = findingId(finding());
    expect(findingId(finding({ class: "boundary-drift" }))).not.toBe(base);
    expect(findingId(finding({ file: "packages/other/src/index.ts" }))).not.toBe(base);
    expect(findingId(finding({ symbol: "other-site" }))).not.toBe(base);
  });
});

describe("findingId — de-binarized NUL separator (adversarial-review F2)", () => {
  // These values were computed with the ORIGINAL source (literal NUL bytes as
  // the separator) BEFORE the escape-sequence rewrite. Pinning them proves the
  // rewrite is hash-preserving: every previously issued findingId — and every
  // accepted baseline built from them — stays valid.
  test("pins known ids: the escape rewrite preserved every hash", () => {
    expect(
      findingId({ class: "boundary-drift", file: "packages/x/src", symbol: "mcp-sdk-ingress" }),
    ).toBe("6a88ee64ac11");
    expect(findingId({ class: "tool-scope", file: "", symbol: "shell" })).toBe("3ac200095796");
    expect(
      findingId({
        class: "boundary-site",
        file: "packages/runtime-core/src/loop.ts",
        symbol: "tool-result",
      }),
    ).toBe("65f2f98fe755");
  });

  test("the runtime separator is still NUL, keeping field boundaries unambiguous", () => {
    const NUL = String.fromCharCode(0);
    const manual = createHash("sha256")
      .update(["boundary-drift", "packages/x/src", "mcp-sdk-ingress"].join(NUL))
      .digest("hex")
      .slice(0, 12);
    expect(manual).toBe(
      findingId({ class: "boundary-drift", file: "packages/x/src", symbol: "mcp-sdk-ingress" }),
    );
  });

  test("the module source contains no literal control bytes (git must diff it as text)", () => {
    const src = readFileSync(join(import.meta.dir, "scope-audit-drift.ts"), "utf8");
    const controlBytes = [...src].filter((c) => {
      const code = c.charCodeAt(0);
      const allowed = code === 0x0a; // newline is the only control char a text source needs
      return !allowed && (code < 0x20 || code === 0x7f);
    });
    expect(controlBytes).toEqual([]);
  });
});

describe("buildScopeAuditSnapshot", () => {
  test("persists failures and drift reports; drops passes and benign warns", () => {
    const findings: PhilosophyFinding[] = [
      finding({ pass: true, warn: false }), // green — dropped
      finding({
        class: "pillar-doc",
        symbol: "sibling-checkout",
        pass: true,
        warn: true, // benign environment warn — dropped
      }),
      finding({ pass: false }), // hard failure — kept
      finding({
        class: "boundary-drift",
        file: "packages/mcp-host/src",
        symbol: "mcp-sdk-ingress",
        pass: true,
        warn: true, // drift report — kept despite warn+pass
      }),
    ];
    expect(findings.filter(isActionableFinding).length).toBe(2);
    const snap = buildScopeAuditSnapshot(findings, () => Date.parse("2026-07-02T12:00:00Z"));
    expect(snap.version).toBe(1);
    expect(snap.generatedAt).toBe("2026-07-02T12:00:00.000Z");
    expect(snap.findings.length).toBe(2);
    for (const f of snap.findings) expect(f.id).toBe(findingId(f));
    // Deterministic ordering (by id) so snapshots diff cleanly in git.
    const ids = snap.findings.map((f) => f.id);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe("diffScopeAuditSnapshots", () => {
  const now = (): number => Date.parse("2026-07-02T12:00:00Z");

  test("fails ONLY on new findings; accepted legacy findings never block", () => {
    const legacy = finding({ pass: false });
    const baseline = buildScopeAuditSnapshot([legacy], now);
    // Same finding still present, reworded — accepted, gate passes.
    const current = buildScopeAuditSnapshot([{ ...legacy, reason: "reworded" }], now);
    const gate = diffScopeAuditSnapshots(baseline, current);
    expect(gate.verdict).toBe("pass");
    expect(gate.acceptedFindings.length).toBe(1);
    expect(gate.newFindings.length).toBe(0);

    // A NEW finding appears — gate fails and names it.
    const drifted = buildScopeAuditSnapshot(
      [
        legacy,
        finding({
          class: "boundary-drift",
          file: "packages/new-ingress/src",
          symbol: "mcp-sdk-ingress",
          pass: true,
          warn: true,
        }),
      ],
      now,
    );
    const failGate = diffScopeAuditSnapshots(baseline, drifted);
    expect(failGate.verdict).toBe("fail");
    expect(failGate.newFindings.length).toBe(1);
    expect(failGate.newFindings[0]?.file).toBe("packages/new-ingress/src");
    expect(failGate.reason).toContain("1 NEW finding(s)");
  });

  test("reports resolved findings without failing", () => {
    const baseline = buildScopeAuditSnapshot([finding({ pass: false })], now);
    const current = buildScopeAuditSnapshot([], now);
    const gate = diffScopeAuditSnapshots(baseline, current);
    expect(gate.verdict).toBe("pass");
    expect(gate.resolvedFindings.length).toBe(1);
    const report = renderGateReport(gate).join("\n");
    expect(report).toContain("resolved");
    expect(report).toContain("baseline gate: pass");
  });

  test("missing baseline fails when findings exist, passes on a clean tree", () => {
    const dirty = diffScopeAuditSnapshots(undefined, buildScopeAuditSnapshot([finding()], now));
    expect(dirty.verdict).toBe("fail");
    expect(dirty.reason).toContain("--accept-baseline");
    const clean = diffScopeAuditSnapshots(undefined, buildScopeAuditSnapshot([], now));
    expect(clean.verdict).toBe("pass");
  });
});

describe("loadScopeAuditSnapshot", () => {
  test("round-trips a written snapshot and returns undefined when absent", () => {
    const path = scopeAuditBaselinePath(root);
    expect(loadScopeAuditSnapshot(path)).toBeUndefined();
    const snap = buildScopeAuditSnapshot([finding()], () => Date.parse("2026-07-02T12:00:00Z"));
    mkdirSync(join(root, ".crewhaus", "scope-audit"), { recursive: true });
    writeFileSync(path, JSON.stringify(snap));
    expect(loadScopeAuditSnapshot(path)).toEqual(snap);
  });

  test("rejects malformed JSON and non-v1 shapes loudly", () => {
    const path = scopeAuditBaselinePath(root);
    mkdirSync(join(root, ".crewhaus", "scope-audit"), { recursive: true });
    writeFileSync(path, "{not json");
    expect(() => loadScopeAuditSnapshot(path)).toThrow(ScopeAuditBaselineError);
    writeFileSync(path, JSON.stringify({ version: 2, findings: [] }));
    expect(() => loadScopeAuditSnapshot(path)).toThrow(ScopeAuditBaselineError);
    writeFileSync(path, JSON.stringify({ version: 1, findings: "nope" }));
    expect(() => loadScopeAuditSnapshot(path)).toThrow(ScopeAuditBaselineError);
  });

  test("snapshot path is the UTC date file under .crewhaus/scope-audit", () => {
    const path = scopeAuditSnapshotPath(root, () => Date.parse("2026-07-02T23:59:00Z"));
    expect(path).toBe(join(root, ".crewhaus", "scope-audit", "2026-07-02.json"));
  });
});

describe("detectBoundaryDrift", () => {
  function writePackage(name: string, files: Record<string, string>): void {
    const srcDir = join(root, "packages", name, "src");
    mkdirSync(srcDir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(srcDir, file), content);
    }
  }

  test("flags an MCP-SDK ingress that never references the fabric", () => {
    writePackage("my-mcp-bridge", {
      "index.ts":
        'import { Client } from "@modelcontextprotocol/sdk/client";\nexport const x = 1;\n',
    });
    const findings = detectBoundaryDrift(root);
    expect(findings.length).toBe(1);
    const f = findings[0] as PhilosophyFinding;
    expect(f.class).toBe("boundary-drift");
    expect(f.file).toBe("packages/my-mcp-bridge/src");
    expect(f.symbol).toBe("mcp-sdk-ingress");
    // Report-only: warn, never a hard failure in plain mode.
    expect(f.pass).toBe(true);
    expect(f.warn).toBe(true);
    expect(f.reason).toContain("classifyBoundary");
  });

  test("a package referencing the classification fabric is exempt", () => {
    writePackage("classified-bridge", {
      "index.ts":
        'import { Client } from "@modelcontextprotocol/sdk/client";\n' +
        'import { classifyBoundary } from "@crewhaus/boundary-classifier";\n',
    });
    expect(detectBoundaryDrift(root)).toEqual([]);
  });

  test("channel/chain adapter name signals fire, base packages are exempt", () => {
    writePackage("channel-adapter-carrierpigeon", {
      "index.ts": "export function parseInboundCoo(body: string): string { return body; }\n",
    });
    // -base packages are the chokepoint, not a drift candidate.
    writePackage("channel-adapter-base", {
      "index.ts": "export const base = true;\n",
    });
    // A chain adapter routing through chain-adapter-base is covered.
    writePackage("chain-adapter-evm", {
      "index.ts": 'import { ingest } from "@crewhaus/chain-adapter-base";\n',
    });
    writePackage("chain-adapter-solana", {
      "index.ts": "export function decodeLogs(raw: string): string { return raw; }\n",
    });
    const findings = detectBoundaryDrift(root);
    expect(findings.map((f) => `${f.file}:${f.symbol}`)).toEqual([
      "packages/chain-adapter-solana/src:chain-content-ingress",
      "packages/channel-adapter-carrierpigeon/src:channel-inbound-ingress",
    ]);
  });

  test("test/declaration files are excluded from signal matching", () => {
    writePackage("innocent-pkg", {
      "index.ts": "export const y = 2;\n",
      "index.test.ts": 'import "@modelcontextprotocol/sdk/client"; // test-only usage\n',
      "types.d.ts": 'declare module "@modelcontextprotocol/sdk";\n',
    });
    expect(detectBoundaryDrift(root)).toEqual([]);
  });

  test("returns [] outside a factory-shaped repo (no packages/)", () => {
    expect(detectBoundaryDrift(join(root, "nonexistent"))).toEqual([]);
  });

  test("finds the real drift candidates in THIS repo, all classified sites exempt", () => {
    // Grounding test against the actual factory tree: the known transports
    // (mcp-host, channel adapters, federation-protocol) are report-only
    // candidates, and every canonical classified site stays exempt. Kept
    // loose (subset assertions) so adding a package doesn't break the test.
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const findings = detectBoundaryDrift(repoRoot);
    const keys = findings.map((f) => `${f.file}:${f.symbol}`);
    expect(keys).toContain("packages/mcp-host/src:mcp-sdk-ingress");
    expect(keys).toContain("packages/channel-adapter-slack/src:channel-inbound-ingress");
    for (const f of findings) {
      expect(f.pass).toBe(true); // every drift finding is report-only
      expect(f.warn).toBe(true);
    }
    // The canonical sites classify and must never be flagged.
    expect(keys.find((k) => k.startsWith("packages/tool-mcp/"))).toBeUndefined();
    expect(keys.find((k) => k.startsWith("packages/federation-router/"))).toBeUndefined();
    expect(keys.find((k) => k.startsWith("packages/channel-adapter-base/"))).toBeUndefined();
  });
});
