/**
 * Loop contract 0.4 (Batch C, G11) — `crewhaus approvals list|show|grant|deny`.
 * Unit tests for the pure formatters, plus an end-to-end CLI drive over a real
 * file-backed approvals store seeded in a tmp cwd.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingApproval } from "@crewhaus/session-store";
import {
  approvalStatus,
  formatApprovalAge,
  formatApprovalDetail,
  formatApprovalsTable,
} from "./approvals-cli";

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: "appr_00000000deadbeef",
    toolName: "Bash",
    inputHash: "a".repeat(64),
    input: { command: "ls -la" },
    runId: "run_1",
    sessionId: "sess_00000000deadbeef",
    surface: "single-turn",
    createdAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("approvalStatus", () => {
  test("derives from decision + consumedAt", () => {
    expect(approvalStatus(approval())).toBe("pending");
    expect(approvalStatus(approval({ decision: "grant" }))).toBe("granted");
    expect(approvalStatus(approval({ decision: "deny" }))).toBe("denied");
    expect(
      approvalStatus(approval({ decision: "grant", consumedAt: "2026-07-17T01:00:00.000Z" })),
    ).toBe("consumed");
  });
});

describe("formatApprovalAge", () => {
  const now = Date.parse("2026-07-17T00:00:00.000Z");
  test("renders coarse relative ages", () => {
    expect(formatApprovalAge("2026-07-17T00:00:00.000Z", now)).toBe("0s");
    expect(formatApprovalAge("2026-07-16T23:59:30.000Z", now)).toBe("30s");
    expect(formatApprovalAge("2026-07-16T23:55:00.000Z", now)).toBe("5m");
    expect(formatApprovalAge("2026-07-16T21:00:00.000Z", now)).toBe("3h");
    expect(formatApprovalAge("2026-07-14T00:00:00.000Z", now)).toBe("3d");
    expect(formatApprovalAge("not-a-date", now)).toBe("?");
  });
});

describe("formatApprovalsTable", () => {
  test("empty → friendly line", () => {
    expect(formatApprovalsTable([])).toContain("no approvals recorded");
  });

  test("renders a header + row + resolve hint", () => {
    const out = formatApprovalsTable([approval()], Date.parse("2026-07-17T00:00:00.000Z"));
    expect(out).toContain("ID");
    expect(out).toContain("STATUS");
    expect(out).toContain("appr_00000000deadbeef");
    expect(out).toContain("pending");
    expect(out).toContain("Bash");
    expect(out).toContain("crewhaus approvals grant|deny <id>");
  });
});

describe("formatApprovalDetail", () => {
  test("includes the verbatim input and resolution fields", () => {
    const out = formatApprovalDetail(
      approval({ decision: "grant", decidedBy: "max", decidedAt: "2026-07-17T00:05:00.000Z" }),
      Date.parse("2026-07-17T00:10:00.000Z"),
    );
    expect(out).toContain("id:");
    expect(out).toContain("appr_00000000deadbeef");
    expect(out).toContain("status:");
    expect(out).toContain("granted");
    expect(out).toContain("decidedBy:");
    expect(out).toContain("max");
    expect(out).toContain("input:");
    expect(out).toContain("ls -la");
  });

  test("notes a missing input", () => {
    const out = formatApprovalDetail(approval({ input: undefined }));
    expect(out).toContain("(not recorded)");
  });
});

// ---------- CLI integration ----------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

let cwd = "";
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "approvals-cli-test-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

async function runCli(args: ReadonlyArray<string>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Persist a pending approval through the real store so the CLI reads it back. */
async function seedApproval(id: string, toolName = "Bash"): Promise<void> {
  const { createPendingApprovalStore, hashApprovalInput } = await import("@crewhaus/session-store");
  const store = createPendingApprovalStore({ rootDir: join(cwd, ".crewhaus", "sessions") });
  const input = { command: "ls -la" };
  await store.persist({
    id,
    toolName,
    inputHash: hashApprovalInput(toolName, input),
    input,
    runId: "run_1",
    sessionId: "sess_00000000deadbeef",
    surface: "single-turn",
    createdAt: new Date().toISOString(),
  });
}

describe("crewhaus approvals (CLI)", () => {
  const ID = "appr_00000000deadbeef";

  test("list shows a seeded pending approval; empty is friendly", async () => {
    const empty = await runCli(["approvals", "list"]);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("no approvals recorded");

    await seedApproval(ID);
    const listed = await runCli(["approvals", "list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(ID);
    expect(listed.stdout).toContain("pending");
  });

  test("show prints detail incl. the tool input; --json is machine-readable", async () => {
    await seedApproval(ID);
    const shown = await runCli(["approvals", "show", ID]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("ls -la");

    const asJson = await runCli(["approvals", "show", ID, "--json"]);
    const parsed = JSON.parse(asJson.stdout) as PendingApproval;
    expect(parsed.id).toBe(ID);
    expect(parsed.toolName).toBe("Bash");
  });

  test("grant records a one-shot decision surfaced on the next list", async () => {
    await seedApproval(ID);
    const granted = await runCli(["approvals", "grant", ID, "--by", "max"]);
    expect(granted.exitCode).toBe(0);
    expect(granted.stdout).toContain("granted");
    expect(granted.stdout).toContain("one-shot");

    const listed = await runCli(["approvals", "list"]);
    expect(listed.stdout).toContain("granted");
    const shown = await runCli(["approvals", "show", ID, "--json"]);
    const parsed = JSON.parse(shown.stdout) as PendingApproval;
    expect(parsed.decision).toBe("grant");
    expect(parsed.decidedBy).toBe("max");
  });

  test("deny records a deny decision", async () => {
    await seedApproval(ID);
    const denied = await runCli(["approvals", "deny", ID]);
    expect(denied.exitCode).toBe(0);
    expect(denied.stdout).toContain("denied");
    const shown = await runCli(["approvals", "show", ID, "--json"]);
    expect((JSON.parse(shown.stdout) as PendingApproval).decision).toBe("deny");
  });

  test("grant/deny/show of an unknown id fails cleanly", async () => {
    const unknown = "appr_0000000000000000";
    const grant = await runCli(["approvals", "grant", unknown]);
    expect(grant.exitCode).toBe(1);
    expect(grant.stderr).toContain(`no approval "${unknown}"`);
    const show = await runCli(["approvals", "show", unknown]);
    expect(show.exitCode).toBe(1);
  });

  test("a malformed id is rejected with the store's message", async () => {
    const { exitCode, stderr } = await runCli(["approvals", "grant", "not-an-id"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid approvalId");
  });

  test("an unknown action is rejected", async () => {
    const { exitCode, stderr } = await runCli(["approvals", "bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("approvals action must be one of");
  });

  test("bare and --help both print usage (exit 0)", async () => {
    for (const args of [["approvals"], ["approvals", "--help"]]) {
      const { exitCode, stdout } = await runCli(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("usage: crewhaus approvals list|show|grant|deny");
    }
  });

  test("--dir points at another harness root", async () => {
    await seedApproval(ID);
    // Run from a sibling dir, pointing --dir back at the seeded harness.
    const sibling = mkdtempSync(join(tmpdir(), "approvals-sibling-"));
    try {
      const proc = Bun.spawn([process.execPath, CLI_PATH, "approvals", "list", "--dir", cwd], {
        cwd: sibling,
        env: { PATH: process.env["PATH"] ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      expect(stdout).toContain(ID);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test("#383 — grant --always records the grant AND writes the standing settings rule", async () => {
    await seedApproval(ID, "log_knowledge_gap");
    const granted = await runCli(["approvals", "grant", ID, "--always", "--by", "max"]);
    expect(granted.exitCode).toBe(0);
    expect(granted.stdout).toContain("granted");
    expect(granted.stdout).toContain("standing allow");
    expect(granted.stdout).not.toContain("one-shot");

    // The settings file carries the rule, in the exact shape buildRuleSet reads.
    const settings = JSON.parse(readFileSync(join(cwd, ".crewhaus", "settings.json"), "utf8")) as {
      permissions: { rules: Array<{ type: string; pattern: string }> };
    };
    expect(settings.permissions.rules).toEqual([
      { type: "alwaysAllow", pattern: "log_knowledge_gap" },
    ]);

    // The record carries always, and the display status says so.
    const shown = await runCli(["approvals", "show", ID, "--json"]);
    const parsed = JSON.parse(shown.stdout) as PendingApproval;
    expect(parsed.decision).toBe("grant");
    expect(parsed.always).toBe(true);
    const listed = await runCli(["approvals", "list"]);
    expect(listed.stdout).toContain("granted-always");
  });

  test("#383 — a second grant --always for the same tool is a dedupe no-op", async () => {
    await seedApproval(ID, "log_knowledge_gap");
    const other = "appr_00000000feedface";
    await seedApproval(other, "log_knowledge_gap");
    await runCli(["approvals", "grant", ID, "--always"]);
    const second = await runCli(["approvals", "grant", other, "--always"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already carries");
    const settings = JSON.parse(readFileSync(join(cwd, ".crewhaus", "settings.json"), "utf8")) as {
      permissions: { rules: unknown[] };
    };
    expect(settings.permissions.rules).toHaveLength(1);
  });

  test("#383 — --always preserves unrelated settings.json keys", async () => {
    mkdirSync(join(cwd, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(cwd, ".crewhaus", "settings.json"),
      `${JSON.stringify({ hooks: { "pre-tool": [] } }, null, 2)}\n`,
    );
    await seedApproval(ID);
    const granted = await runCli(["approvals", "grant", ID, "--always"]);
    expect(granted.exitCode).toBe(0);
    const settings = JSON.parse(readFileSync(join(cwd, ".crewhaus", "settings.json"), "utf8")) as {
      hooks: unknown;
      permissions: { rules: Array<{ pattern: string }> };
    };
    expect(settings.hooks).toEqual({ "pre-tool": [] });
    expect(settings.permissions.rules[0]?.pattern).toBe("Bash");
  });

  test("#383 — deny --always is rejected", async () => {
    await seedApproval(ID);
    const { exitCode, stderr } = await runCli(["approvals", "deny", ID, "--always"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--always applies only");
    // Nothing was decided or written.
    const shown = await runCli(["approvals", "show", ID, "--json"]);
    expect((JSON.parse(shown.stdout) as PendingApproval).decision).toBeUndefined();
    expect(existsSync(join(cwd, ".crewhaus", "settings.json"))).toBe(false);
  });

  test("#383 — a malformed settings.json fails the --always write loudly, grant stays recorded", async () => {
    mkdirSync(join(cwd, ".crewhaus"), { recursive: true });
    writeFileSync(join(cwd, ".crewhaus", "settings.json"), "{broken");
    await seedApproval(ID);
    const { exitCode, stderr } = await runCli(["approvals", "grant", ID, "--always"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("standing alwaysAllow rule failed");
    // The grant itself IS recorded (the operator's decision is not lost)…
    const shown = await runCli(["approvals", "show", ID, "--json"]);
    expect((JSON.parse(shown.stdout) as PendingApproval).decision).toBe("grant");
    // …and the unparseable file is untouched.
    expect(readFileSync(join(cwd, ".crewhaus", "settings.json"), "utf8")).toBe("{broken");
  });
});
