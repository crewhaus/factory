/**
 * `crewhaus budget show|history|extend` (#516): a harness's spending period read from its
 * spec and its ledger, and raised by a person, through the control service, as a
 * receipted command that works with Home stopped.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_FOR_ERROR } from "@crewhaus/control-contract";
import {
  foldBudget,
  openBudgetLedger,
  periodOf,
  readBudgetState,
} from "@crewhaus/control-records/budget";
import { AREA_RUNTIMES, type ControlService, wireControl } from "@crewhaus/control-service";
import { runBudgetCommand, specPeriodOf } from "./budget-cmd";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const temp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `budget-cmd-${label}-`));
  roots.push(dir);
  return dir;
};

const IDENTITY = { username: "sam", hostname: "laptop" } as const;
const NOW = Date.parse("2026-11-18T12:00:00.000Z");

function harness(budget: string | undefined): string {
  const dir = temp("h");
  writeFileSync(
    join(dir, "crewhaus.yaml"),
    `name: spend\ntarget: cli\nagent: {model: claude-opus-4-7, instructions: Help.}\n${budget ?? ""}`,
  );
  return dir;
}

function setup(budget: string | undefined) {
  const dir = harness(budget);
  const hangarRoot = temp("hangar");
  const service: ControlService = wireControl(
    {
      hangarRoot,
      supervisorFor: () => undefined,
      drainRequest: () => async () => undefined,
      identity: IDENTITY,
      probe: { isAlive: () => true, startTimeMs: () => Date.now() - 1000 },
    },
    { mode: "direct", areas: AREA_RUNTIMES },
  );
  const env = {
    CREWHAUS_REGISTRY_ROOT: join(hangarRoot, "registry"),
    CREWHAUS_HANGAR_ROOT: hangarRoot,
    HOME: hangarRoot,
  };
  const run = (argv: readonly string[], extra: Record<string, string> = {}) =>
    runBudgetCommand(argv, {
      env: { ...env, ...extra },
      cwd: dir,
      now: () => NOW,
      control: () => service,
    });
  return { dir, run };
}

const PERIOD = "budget:\n  usd: 5\n  period: {every: month, usd: 10}\n";

describe("crewhaus budget", () => {
  test("without a period, show says why and extend refuses", async () => {
    const { run } = setup(undefined);
    const show = await run(["show"]);
    expect(show.exitCode).toBe(0);
    expect(show.lines.join("\n")).toContain("No spending limit for a period");
    const extend = await run(["extend", "--usd", "5", "--reason", "incident"]);
    expect(extend.exitCode).toBe(EXIT_FOR_ERROR.conflict);
  });

  test("a directory with no spec is not a harness: every verb refuses, never 'no limit'", async () => {
    const empty = temp("empty");
    const run = (argv: readonly string[]) =>
      runBudgetCommand(argv, { env: { HOME: empty }, cwd: empty, now: () => NOW });
    for (const argv of [["show"], ["history"], ["extend", "--usd", "5", "--reason", "other"]]) {
      const out = await run(argv);
      expect([argv[0], out.exitCode]).toEqual([argv[0], EXIT_FOR_ERROR.not_found]);
      expect(out.lines.join("\n")).toContain("no harness here (no crewhaus.yaml)");
      expect(out.lines.join("\n")).not.toContain("No spending limit");
    }
  });

  test("a spec whose period cannot be used refuses naming the problem, never 'no limit'", async () => {
    for (const budget of [
      "budget:\n  usd: 5\n  period: {every: month, usd: 10, timezone: Mars/Olympus}\n",
      "budget: [unclosed\n",
    ]) {
      const { run } = setup(budget);
      for (const argv of [["show"], ["extend", "--usd", "5", "--reason", "other"]]) {
        const out = await run(argv);
        expect([argv[0], out.exitCode]).toEqual([argv[0], EXIT_FOR_ERROR.invalid]);
        const text = out.lines.join("\n");
        expect(text).toContain("could not be read, so its spending limit is unknown");
        expect(text).toContain("crewhaus lint crewhaus.yaml");
        expect(text).not.toContain("No spending limit");
      }
    }
    // The optimizer's reader answers no ledger, as before.
    expect(
      specPeriodOf(
        harness("budget:\n  usd: 5\n  period: {every: month, usd: 10, timezone: Mars/Olympus}\n"),
      ),
    ).toBeUndefined();
  });

  test("the renewal day is read in the period's own zone", async () => {
    const { run } = setup(
      "budget:\n  usd: 5\n  period: {every: month, usd: 10, timezone: Europe/Berlin}\n",
    );
    const show = await run(["show"]);
    expect(show.exitCode).toBe(0);
    // A Berlin month renews at local midnight on 1 Dec (23:00 UTC on 30 Nov).
    expect(show.lines.join("\n")).toContain("It renews on 1 Dec 2026.");
  });

  test("show prints this period's spend, unknown calls and the renewal", async () => {
    const { dir, run } = setup(PERIOD);
    const def = specPeriodOf(dir);
    expect(def).toEqual({ every: "month", usdMicros: 10_000_000 });
    const ledger = openBudgetLedger(dir, def as NonNullable<typeof def>, { now: () => NOW });
    await ledger.reserve({ id: "rsv_a", usdMicros: 10 });
    await ledger.settle({ id: "rsv_a", usdMicros: 1_200_000 });
    await ledger.reserve({ id: "rsv_b", usdMicros: 10 });
    await ledger.settle({ id: "rsv_b", usdMicros: null });
    const out = await run(["show"]);
    expect(out.lines[0]).toBe("Spending limit this month: $1.20 + unknown of $10.00 used.");
    expect(out.lines.join("\n")).toContain("crewhaus models audit");
    expect(out.lines.join("\n")).toContain("It renews on 1 Dec 2026.");
    const json = JSON.parse((await run(["show", "--json"])).lines.join("\n"));
    expect(json.fold.unknownCalls).toBe(1);
    expect((await run(["history"])).lines).toEqual(["No period has closed yet."]);
  });

  test("extend raises the current period with a receipt, and clears a used-up period", async () => {
    const { dir, run } = setup(PERIOD);
    const def = specPeriodOf(dir) as NonNullable<ReturnType<typeof specPeriodOf>>;
    const ledger = openBudgetLedger(dir, def, { now: () => NOW });
    await ledger.reserve({ id: "rsv_a", usdMicros: 10 });
    await ledger.settle({ id: "rsv_a", usdMicros: 10_000_000 });
    expect((await ledger.reserve({ id: "rsv_b", usdMicros: 10 })).admit).toBe(false);
    expect(readBudgetState(dir).state).toBe("present");
    const out = await run(["extend", "--usd", "50", "--reason", "planned-work"]);
    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toBe("Raised by $50.00 for this month. It resets on 1 Dec 2026.");
    expect(out.lines[1]).toMatch(/^receipt cmd_/);
    expect(foldBudget(dir, def, NOW).extensionsUsdMicros).toBe(50_000_000);
    expect(readBudgetState(dir).state).toBe("absent");
  });

  test("extend refuses a stale period, a bad amount, an unknown reason and an agent's tool", async () => {
    const { dir, run } = setup(PERIOD);
    const def = specPeriodOf(dir) as NonNullable<ReturnType<typeof specPeriodOf>>;
    const stale = await run([
      "extend",
      "--usd",
      "5",
      "--reason",
      "incident",
      "--expect",
      "month-2026-10-01",
    ]);
    expect(stale.exitCode).toBe(EXIT_FOR_ERROR.precondition_failed);
    expect(stale.lines[0]).toContain(periodOf(def, NOW).periodId);
    for (const usd of ["0", "-5", "1.234", "lots"]) {
      expect((await run(["extend", "--usd", usd, "--reason", "incident"])).exitCode).toBe(
        EXIT_FOR_ERROR.invalid,
      );
    }
    expect((await run(["extend", "--usd", "5", "--reason", "because"])).exitCode).toBe(
      EXIT_FOR_ERROR.invalid,
    );
    const agent = await run(["extend", "--usd", "5", "--reason", "incident"], {
      CREWHAUS_AGENT_TOOL: "Bash",
    });
    expect(agent.exitCode).toBe(EXIT_FOR_ERROR.forbidden);
    expect(foldBudget(dir, def, NOW).extensionsUsdMicros).toBe(0);
  });
});
