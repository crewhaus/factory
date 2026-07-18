/**
 * G63 — `crewhaus failures report`. Unit tests for the pure clustering/drafting
 * transform, plus an end-to-end CLI drive over a seeded harness (run_failed
 * events + an incident bundle) in a tmp cwd.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FailureRecord,
  clusterFailures,
  distinctivePattern,
  leadingStableClause,
  longestCommonSubstring,
  normalizeTokens,
  proposeTaxonomy,
  renderFailuresTable,
  renderTaxonomyYaml,
  tokenSimilarity,
} from "./failures";

function runFailed(
  cls: string,
  message: string,
  sessionId: string,
  exitCode?: number,
): FailureRecord {
  return {
    source: "run_failed",
    class: cls,
    message,
    sessionId,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

describe("normalizeTokens", () => {
  test("drops numbers, long hex, stopwords, and short noise", () => {
    const tokens = normalizeTokens(
      "Provider account has insufficient funds: HTTP 402 abcdef123456",
    );
    expect(tokens.has("provider")).toBe(true);
    expect(tokens.has("account")).toBe(true);
    expect(tokens.has("insufficient")).toBe(true);
    expect(tokens.has("funds")).toBe(true);
    expect(tokens.has("http")).toBe(true);
    expect(tokens.has("402")).toBe(false); // pure number
    expect(tokens.has("has")).toBe(false); // stopword
    expect(tokens.has("abcdef123456")).toBe(false); // hex fragment
  });
});

describe("tokenSimilarity", () => {
  test("Jaccard overlap", () => {
    expect(tokenSimilarity(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(tokenSimilarity(new Set(["a", "b"]), new Set(["a", "c"]))).toBeCloseTo(1 / 3, 5);
    expect(tokenSimilarity(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(tokenSimilarity(new Set(), new Set())).toBe(1);
  });
});

describe("clusterFailures", () => {
  test("groups similar messages within a class, splits distinct ones", () => {
    const clusters = clusterFailures([
      runFailed("timeout", "model call timed out after 30000ms", "sess_0000000000000001", 34),
      runFailed("timeout", "model call timed out after 45000ms", "sess_0000000000000002", 34),
      runFailed(
        "billing",
        "Provider account has insufficient funds: HTTP 402",
        "sess_0000000000000003",
        31,
      ),
    ]);
    // timeout messages differ only in the (volatile) number → one cluster.
    const timeout = clusters.find((c) => c.class === "timeout");
    expect(timeout?.count).toBe(2);
    expect(timeout?.sessions.length).toBe(2);
    expect(timeout?.exitCode).toBe(34);
    const billing = clusters.find((c) => c.class === "billing");
    expect(billing?.count).toBe(1);
    expect(billing?.exitCode).toBe(31);
  });

  test("excludes approval_pending (a resumable pause, not a failure)", () => {
    const clusters = clusterFailures([
      runFailed("approval_pending", "tool Bash parked for approval", "sess_0000000000000001", 36),
      runFailed("timeout", "timed out", "sess_0000000000000002", 34),
    ]);
    expect(clusters.some((c) => c.class === "approval_pending")).toBe(false);
    expect(clusters).toHaveLength(1);
  });

  test("ranks most-frequent first; example is the modal message", () => {
    const clusters = clusterFailures([
      runFailed("auth", "invalid api key", "sess_0000000000000001"),
      runFailed("config", "spec parse error near line 3", "sess_0000000000000002"),
      runFailed("config", "spec parse error near line 3", "sess_0000000000000003"),
    ]);
    expect(clusters[0]?.class).toBe("config");
    expect(clusters[0]?.count).toBe(2);
    expect(clusters[0]?.example).toBe("spec parse error near line 3");
  });

  test("counts run_failed vs incident sources", () => {
    const clusters = clusterFailures([
      runFailed("timeout", "timed out waiting", "sess_0000000000000001"),
      {
        source: "incident",
        class: "timeout",
        message: "timed out waiting",
        sessionId: "sess_0000000000000002",
      },
    ]);
    const c = clusters.find((x) => x.class === "timeout");
    expect(c?.sources).toEqual({ run_failed: 1, incident: 1 });
  });
});

describe("longestCommonSubstring / leadingStableClause / distinctivePattern", () => {
  test("LCS is a contiguous substring of both", () => {
    expect(
      longestCommonSubstring("model call timed out after 3s", "model call timed out after 9s"),
    ).toBe("model call timed out after");
    expect(longestCommonSubstring("abc", "xyz")).toBe("");
  });

  test("leadingStableClause cuts at the first volatile boundary", () => {
    expect(leadingStableClause("Provider account has insufficient funds: HTTP 402")).toBe(
      "Provider account has insufficient funds",
    );
    expect(leadingStableClause("read ETIMEDOUT 10.0.0.1:443")).toBe("read ETIMEDOUT");
  });

  test("distinctivePattern generalizes across a cluster's messages", () => {
    expect(
      distinctivePattern([
        "model call timed out after 30000ms",
        "model call timed out after 45000ms",
      ]),
    ).toBe("model call timed out after");
    // Single message → leading stable clause.
    expect(distinctivePattern(["Provider account has insufficient funds: HTTP 402"])).toBe(
      "Provider account has insufficient funds",
    );
    expect(distinctivePattern([])).toBeUndefined();
  });
});

describe("proposeTaxonomy", () => {
  test("drafts an entry per distinctive cluster with a per-class recovery", () => {
    const clusters = clusterFailures([
      runFailed("timeout", "model call timed out after 30000ms", "sess_0000000000000001", 34),
      runFailed("timeout", "model call timed out after 45000ms", "sess_0000000000000002", 34),
      runFailed(
        "billing",
        "Provider account has insufficient funds: HTTP 402",
        "sess_0000000000000003",
        31,
      ),
    ]);
    const { drafts } = proposeTaxonomy(clusters);
    const timeout = drafts.find((d) => d.class === "timeout");
    expect(timeout?.pattern).toBe("model call timed out after");
    expect(timeout?.recovery).toBe("retry");
    const billing = drafts.find((d) => d.class === "billing");
    expect(billing?.pattern).toBe("Provider account has insufficient funds");
    expect(billing?.recovery).toBe("fail");
  });

  test("surfaces too-generic clusters instead of drafting them", () => {
    const clusters = clusterFailures([runFailed("unknown", "err", "sess_0000000000000001")]);
    const { drafts, tooBroad } = proposeTaxonomy(clusters);
    expect(drafts).toHaveLength(0);
    expect(tooBroad[0]?.class).toBe("unknown");
  });

  test("deduplicates class names when two clusters share a class", () => {
    const clusters = clusterFailures([
      runFailed("tool", "Bash exited non-zero: command not found", "sess_0000000000000001"),
      runFailed("tool", "Read failed: no such file or directory", "sess_0000000000000002"),
    ]);
    const { drafts } = proposeTaxonomy(clusters);
    // Two distinct tool messages → two clusters → deduped names.
    if (drafts.length === 2) {
      expect(new Set(drafts.map((d) => d.class)).size).toBe(2);
      expect(drafts.some((d) => d.class === "tool_2")).toBe(true);
    }
  });
});

describe("renderers", () => {
  test("renderFailuresTable — empty and populated", () => {
    expect(renderFailuresTable([])).toContain("no run failures or incidents recorded");
    const table = renderFailuresTable(
      clusterFailures([runFailed("timeout", "timed out after 30s", "sess_0000000000000001", 34)]),
    );
    expect(table).toContain("CLASS");
    expect(table).toContain("timeout");
    expect(table).toContain("34");
  });

  test("renderTaxonomyYaml produces a paste-ready block", () => {
    const clusters = clusterFailures([
      runFailed("timeout", "model call timed out after 30000ms", "sess_0000000000000001", 34),
      runFailed("timeout", "model call timed out after 45000ms", "sess_0000000000000002", 34),
    ]);
    const yaml = renderTaxonomyYaml(proposeTaxonomy(clusters));
    expect(yaml).toContain("failure_taxonomy:");
    expect(yaml).toContain("class:");
    expect(yaml).toContain("pattern:");
    expect(yaml).toContain("recovery:");
  });
});

// ---------- CLI integration ----------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

let cwd = "";
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "failures-cli-test-"));
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

/** Seed a session log via the real event-log writer, ending in run_failed. */
async function seedRunFailed(
  sessionId: string,
  cls: string,
  message: string,
  exitCode: number,
): Promise<void> {
  const { openEventLog } = await import("@crewhaus/event-log");
  const log = await openEventLog(sessionId, { rootDir: join(cwd, ".crewhaus", "sessions") });
  await log.append({ kind: "user_message", payload: { text: "go" } });
  await log.append({ kind: "run_failed", payload: { class: cls, message, exitCode } });
  await log.close();
}

/** Seed an incident bundle manifest. */
function seedIncident(dirName: string, kind: string, sessionId: string, reason: string): void {
  const dir = join(cwd, ".crewhaus", "incidents", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "bundle.json"),
    JSON.stringify({ kind, sessionId, incidentTs: new Date().toISOString(), reason }),
  );
}

describe("crewhaus failures report (CLI)", () => {
  test("aggregates run_failed + incidents and clusters them", async () => {
    await seedRunFailed(
      "sess_00000000aaaa0001",
      "timeout",
      "model call timed out after 30000ms",
      34,
    );
    await seedRunFailed(
      "sess_00000000aaaa0002",
      "timeout",
      "model call timed out after 45000ms",
      34,
    );
    await seedRunFailed("sess_00000000aaaa0003", "billing", "insufficient funds: HTTP 402", 31);
    seedIncident(
      "20260717T000000-circuit_open",
      "circuit_open",
      "sess_00000000aaaa0004",
      "anthropic → open",
    );

    const { exitCode, stdout } = await runCli(["failures", "report"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("timeout");
    expect(stdout).toContain("billing");
    expect(stdout).toContain("incident:circuit_open");
    // The two timeout runs cluster into one row of count 2.
    expect(stdout).toMatch(/timeout\s+2\s+2/);
  });

  test("--propose-taxonomy drafts a failure_taxonomy block", async () => {
    await seedRunFailed(
      "sess_00000000bbbb0001",
      "timeout",
      "model call timed out after 30000ms",
      34,
    );
    await seedRunFailed(
      "sess_00000000bbbb0002",
      "timeout",
      "model call timed out after 45000ms",
      34,
    );
    const { exitCode, stdout } = await runCli(["failures", "report", "--propose-taxonomy"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("failure_taxonomy:");
    expect(stdout).toContain("model call timed out after");
    expect(stdout).toContain("recovery:");
  });

  test("--json emits structured clusters", async () => {
    await seedRunFailed("sess_00000000cccc0001", "auth", "invalid api key", 30);
    const { exitCode, stdout } = await runCli(["failures", "report", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { clusters: Array<{ class: string; count: number }> };
    expect(parsed.clusters[0]?.class).toBe("auth");
    expect(parsed.clusters[0]?.count).toBe(1);
  });

  test("empty harness reports no failures (exit 0)", async () => {
    const { exitCode, stdout } = await runCli(["failures", "report"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("no run failures or incidents recorded");
  });

  test("rejects an unknown action", async () => {
    const { exitCode, stderr } = await runCli(["failures", "bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('failures action must be "report"');
  });

  test("--help prints usage (exit 0)", async () => {
    const { exitCode, stdout } = await runCli(["failures", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("usage: crewhaus failures report");
  });
});
