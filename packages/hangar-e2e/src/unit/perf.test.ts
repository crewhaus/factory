import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFERENCE_REFUSAL, benchMain, readBenchReport } from "../perf/bench";
import { UNKNOWN, machineFingerprint, parseMachine } from "../perf/machine";
import { VIEW_BUDGET_MS, viewStats, viewVerdict } from "../perf/stats";

describe("viewStats", () => {
  test("percentiles and the maximum, in any input order", () => {
    const samples = Array.from({ length: 100 }, (_, index) => 100 - index);
    expect(viewStats(samples)).toEqual({ count: 100, p50: 50, p95: 95, max: 100 });
  });

  test("one sample is every statistic", () => {
    expect(viewStats([7])).toEqual({ count: 1, p50: 7, p95: 7, max: 7 });
  });

  test("no samples is no statistics, not zeros", () => {
    expect(viewStats([])).toBeUndefined();
  });

  test("it leaves its input alone", () => {
    const samples = [3, 1, 2];
    viewStats(samples);
    expect(samples).toEqual([3, 1, 2]);
  });
});

describe("viewVerdict", () => {
  test("the budget is 2,000 ms, and exactly on it is within", () => {
    expect(VIEW_BUDGET_MS).toBe(2_000);
    expect(viewVerdict([2_000]).verdict).toBe("within");
    expect(viewVerdict([2_001]).verdict).toBe("over");
  });

  test("it reads the 95th percentile, so one outlier in a hundred does not condemn a view", () => {
    const samples = [...Array.from({ length: 99 }, () => 100), 90_000];
    expect(viewVerdict(samples).verdict).toBe("within");
    const slow = [
      ...Array.from({ length: 90 }, () => 100),
      ...Array.from({ length: 10 }, () => 3_000),
    ];
    expect(viewVerdict(slow).verdict).toBe("over");
  });

  test("no samples is no data, never a pass", () => {
    expect(viewVerdict([])).toEqual({ verdict: "no-data" });
  });
});

describe("parseMachine", () => {
  const SYSCTL = [
    "machdep.cpu.brand_string: Apple M4 Pro",
    "hw.ncpu: 14",
    "hw.memsize: 51539607552",
    "hw.model: Mac16,8",
    "",
  ].join("\n");
  const SW_VERS = [
    "ProductName:\t\tmacOS",
    "ProductVersion:\t\t26.0",
    "BuildVersion:\t\t25A354",
    "",
  ].join("\n");

  test("recorded output reads as the fingerprint", () => {
    expect(parseMachine(SYSCTL, SW_VERS)).toEqual({
      cpu: "Apple M4 Pro",
      cores: "14",
      memoryBytes: "51539607552",
      model: "Mac16,8",
      os: "macOS",
      osVersion: "26.0",
    });
  });

  test("a host without the commands says unknown, without throwing or inventing", () => {
    const fingerprint = parseMachine(undefined, undefined);
    for (const value of Object.values(fingerprint)) expect(value).toBe(UNKNOWN);
    expect(Object.keys(fingerprint)).toHaveLength(6);
  });

  test("a field that is missing or empty is unknown, and the rest still read", () => {
    const fingerprint = parseMachine("hw.ncpu: 8\nhw.model: \n", undefined);
    expect(fingerprint.cores).toBe("8");
    expect(fingerprint.model).toBe(UNKNOWN);
    expect(fingerprint.cpu).toBe(UNKNOWN);
  });

  test("this machine gets a fingerprint with every field filled in", () => {
    for (const value of Object.values(machineFingerprint())) {
      expect(typeof value).toBe("string");
      expect(value).not.toBe("");
    }
  });
});

describe("the bench command", () => {
  const script = join(import.meta.dir, "..", "perf", "bench.ts");

  test("--profile reference refuses with exit 2, with its reason, from the real script", () => {
    const run = Bun.spawnSync(["bun", script, "--profile", "reference"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain(REFERENCE_REFUSAL);
  }, 20_000); // a real process that loads the console's server before it can refuse

  test("an unknown profile and a missing --out are usage errors, before any browser", async () => {
    expect(await benchMain(["--profile", "nope", "--out", "x"])).toBe(2);
    expect(await benchMain(["--profile", "smoke"])).toBe(2);
    expect(await benchMain([])).toBe(2);
  });
});

describe("readBenchReport", () => {
  const dir = mkdtempSync(join(tmpdir(), "hangar-e2e-perf-"));
  const write = (report: unknown): string => {
    const path = join(dir, "report.json");
    writeFileSync(path, JSON.stringify(report));
    return path;
  };
  const good = {
    label: "baseline",
    machine: {},
    dataset: {},
    build: {},
    samples: { "#/": [1, 2] },
    verdicts: { "#/": { verdict: "within" } },
  };

  test("a well-formed report reads", () => {
    expect(readBenchReport(write(good)).samples["#/"]).toEqual([1, 2]);
  });

  test.each(["machine", "dataset", "build", "samples", "verdicts"])("no %s fails", (field) => {
    const { [field as keyof typeof good]: _gone, ...rest } = good;
    expect(() => readBenchReport(write(rest))).toThrow(field);
  });

  test("an unlabelled report fails", () => {
    expect(() => readBenchReport(write({ ...good, label: "final" }))).toThrow("labelled");
  });

  test("a view with samples and no verdict fails", () => {
    expect(() => readBenchReport(write({ ...good, verdicts: {} }))).toThrow("no verdict");
    rmSync(dir, { recursive: true, force: true });
  });
});
