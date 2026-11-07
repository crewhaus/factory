/**
 * The benchmark's machinery: `bun src/perf/bench.ts --profile smoke --out <file>`.
 *
 * The smoke profile boots over the seed and navigates a few routes, to prove the
 * report can be written. Its numbers are labelled `baseline` and gate nothing. The
 * reference profile needs a reference dataset, which is not in this build, and it
 * refuses rather than measure something else under that name.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootHome } from "../boot";
import { LIBRARY_ROUTE, globalRoute, harnessRoute } from "../console-routes";
import { seedFleet } from "../seed/fleet";
import { closeSharedBrowser, openSession } from "../session";
import { type MachineFingerprint, machineFingerprint } from "./machine";
import { type ViewVerdict, viewVerdict } from "./stats";

export type BenchReport = {
  readonly label: "baseline";
  readonly profile: "smoke";
  readonly machine: MachineFingerprint;
  readonly dataset: { readonly name: string; readonly harnesses: number };
  readonly build: { readonly bun: string; readonly platform: string };
  readonly samples: Readonly<Record<string, readonly number[]>>;
  readonly verdicts: Readonly<Record<string, ViewVerdict>>;
};

/** Passes through a route this many times to collect samples. */
const SMOKE_PASSES = 2;

export const REFERENCE_REFUSAL =
  "the reference profile needs the reference dataset, which is not in this build";

/** Run the smoke profile, and write its report. */
export async function runBench(opts: {
  readonly profile: "smoke";
  readonly out: string;
}): Promise<BenchReport> {
  const dir = mkdtempSync(join(tmpdir(), "hangar-e2e-bench-"));
  try {
    const fleet = await seedFleet(dir, { seed: "bench", now: Date.now(), shapes: ["cli"] });
    const home = bootHome(fleet);
    try {
      const session = await openSession(home, { label: "bench" });
      const id = fleet.harnesses[0]?.id ?? "";
      const routes = [
        LIBRARY_ROUTE,
        globalRoute("runs"),
        harnessRoute(id, "overview"),
        harnessRoute(id, "sessions"),
      ];
      const samples: Record<string, number[]> = {};
      for (const route of routes) {
        const key = route.replace(id, ":id");
        samples[key] = [];
        for (let pass = 0; pass < SMOKE_PASSES; pass++) {
          // Leave the route first, or a second visit to it would not navigate.
          await session.visit(pass % 2 === 0 ? globalRoute("settings") : globalRoute("health"));
          const started = performance.now();
          await session.visit(route);
          samples[key]?.push(Math.round(performance.now() - started));
        }
      }
      session.assertClean();
      await session.close();
      const report: BenchReport = {
        label: "baseline",
        profile: opts.profile,
        machine: machineFingerprint(),
        dataset: { name: "seeded-fleet", harnesses: fleet.harnesses.length },
        build: { bun: Bun.version, platform: `${process.platform}-${process.arch}` },
        samples,
        verdicts: Object.fromEntries(
          Object.entries(samples).map(([key, values]) => [key, viewVerdict(values)]),
        ),
      };
      mkdirSync(dirname(opts.out), { recursive: true });
      writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
      return report;
    } finally {
      await home.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const REPORT_KEYS = ["machine", "dataset", "build", "samples", "verdicts"] as const;

/** Read a report back. Throws, naming the field, on anything malformed. */
export function readBenchReport(path: string): BenchReport {
  const report = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  for (const key of REPORT_KEYS) {
    const value = report[key];
    if (value === null || typeof value !== "object") {
      throw new Error(`the benchmark's report has no ${key}`);
    }
  }
  if (report["label"] !== "baseline") throw new Error("the benchmark's report is not labelled");
  const samples = report["samples"] as Record<string, unknown>;
  const verdicts = report["verdicts"] as Record<string, unknown>;
  for (const key of Object.keys(samples)) {
    if (!Array.isArray(samples[key])) throw new Error(`samples for ${key} is not a list`);
    if (verdicts[key] === undefined) throw new Error(`no verdict for ${key}`);
  }
  return report as unknown as BenchReport;
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** The CLI half, as a function of its arguments. Returns the exit code. */
export async function benchMain(argv: readonly string[]): Promise<number> {
  const profile = argValue(argv, "--profile");
  if (profile === "reference") {
    console.error(REFERENCE_REFUSAL);
    return 2;
  }
  if (profile !== "smoke") {
    console.error(`usage: bench --profile smoke --out <file> (got --profile ${profile})`);
    return 2;
  }
  const out = argValue(argv, "--out");
  if (out === undefined) {
    console.error("usage: bench --profile smoke --out <file>");
    return 2;
  }
  await runBench({ profile, out });
  await closeSharedBrowser();
  return 0;
}

if (import.meta.main) {
  process.exit(await benchMain(process.argv.slice(2)));
}
