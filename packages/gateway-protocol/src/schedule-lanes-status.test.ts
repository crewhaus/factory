/**
 * The rendered schedule lanes, run against the real control plane and the
 * real `armScheduleLanes`: `/control/v1/status` reports each lane's next wake
 * from its armed timer. The clock and the timers are fakes; formatter
 * constructions are counted, never timed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armScheduleLanes } from "@crewhaus/durable-execution";
import { type ControlPlane, type ControlTimerReport, createControlPlane } from "./control";
import { type ScheduleLaneEmit, renderScheduleLanes } from "./control-codegen";

// Built from parts so no realistic-shaped credential literal lands in the repo.
const TOKEN = ["ctl", "0".repeat(8), "abcd"].join("-");

let tmp: string;
const planes: ControlPlane[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-schedule-status-"));
});
afterEach(async () => {
  for (const plane of planes.splice(0)) await plane.stop();
  rmSync(tmp, { recursive: true, force: true });
});

function plane(): ControlPlane {
  const made = createControlPlane({
    name: "acme-bot",
    target: "channel",
    cwd: tmp,
    env: { CREWHAUS_CONTROL_TOKEN: TOKEN },
    sessionRootDir: join(tmp, "sessions"),
    audit: () => {},
    exit: () => {},
    stdout: () => {},
    stderr: () => {},
    drainSettleMs: 1,
  });
  planes.push(made);
  return made;
}

async function scheduleRows(control: ControlPlane): Promise<ControlTimerReport[]> {
  const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
  const res = await control.fetch(
    new Request("http://127.0.0.1:9999/control/v1/status", { headers }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { timers: ControlTimerReport[] };
  return body.timers.filter((t) => t.lane.startsWith("schedule:"));
}

type Armed = { cancel(): void; nextAt(name: string): number | undefined };
type FakeTimer = { readonly fn: () => void; readonly ms: number; cleared: boolean };

/** Render the lanes and run them; the rendered text returns its armed handle. */
function runRendered(
  lanes: ReadonlyArray<ScheduleLaneEmit>,
  control: ControlPlane,
  arm: typeof armScheduleLanes,
  armGuard?: string,
): { readonly armed: Armed | undefined; readonly seen: string[] } {
  const out = renderScheduleLanes({
    lanes,
    body: ({ laneId }) => `__seen.push(${JSON.stringify(laneId)});`,
    onErrorBody: "throw __err;",
    ...(armGuard !== undefined ? { armGuard } : {}),
  });
  const js = `${new Bun.Transpiler({ loader: "ts" }).transformSync(out)}\nreturn __scheduleLanesArmed;`;
  const seen: string[] = [];
  const armed = new Function("__control", "armScheduleLanes", "__seen", js)(control, arm, seen) as
    | Armed
    | undefined;
  return { armed, seen };
}

/** Run `fn` with `Intl.DateTimeFormat` swapped for a proxy that counts constructions. */
async function countFormatters(fn: () => Promise<void>): Promise<number> {
  const original = Intl.DateTimeFormat;
  let built = 0;
  const counting = new Proxy(original, {
    construct(target, args, newTarget) {
      built += 1;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    Intl.DateTimeFormat = counting;
    await fn();
  } finally {
    Intl.DateTimeFormat = original;
  }
  return built;
}

const EIGHT: ReadonlyArray<ScheduleLaneEmit> = Array.from({ length: 8 }, (_, i) => ({
  name: `l${i}`,
  kind: "cron" as const,
  cron: "0 17 * * 5",
  timezone: "Europe/Berlin",
  instructions: `lane ${i}`,
}));

describe("rendered schedule lanes in /control/v1/status", () => {
  test("a status read over eight time-zone cron lanes builds no formatter and reads each armed timer", async () => {
    const control = plane();
    let now = Date.parse("2026-11-14T12:00:00Z");
    const timers: FakeTimer[] = [];
    const arm: typeof armScheduleLanes = (lanes, handlers) =>
      armScheduleLanes(lanes, {
        ...handlers,
        now: () => now,
        setTimer: (fn, ms) => {
          const timer: FakeTimer = { fn, ms, cleared: false };
          timers.push(timer);
          return timer;
        },
        clearTimer: (handle) => {
          (handle as FakeTimer).cleared = true;
        },
      });
    const { armed, seen } = runRendered(EIGHT, control, arm);
    try {
      expect(armed).toBeDefined();
      expect(timers).toHaveLength(8);

      let rows: ControlTimerReport[] = [];
      const built = await countFormatters(async () => {
        rows = await scheduleRows(control);
      });
      expect(built).toBe(0);
      expect(rows.map((r) => r.lane).sort()).toEqual(EIGHT.map((l) => `schedule:${l.name}`));
      for (const row of rows) {
        const name = row.lane.slice("schedule:".length);
        expect(row.nextDueAt).toBe("2026-11-20T16:00:00.000Z");
        expect(row.nextDueAt).toBe(new Date(armed?.nextAt(name) ?? Number.NaN).toISOString());
      }

      // Lanes arm in name order, so the first timer is lane l0's.
      const first = timers[0] as FakeTimer;
      now = Date.parse("2026-11-14T12:00:00Z") + first.ms;
      expect(new Date(now).toISOString()).toBe("2026-11-20T16:00:00.000Z");
      first.fn();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
      expect(seen).toEqual(["schedule:l0"]);
      expect(timers).toHaveLength(9);

      const after = await scheduleRows(control);
      for (const row of after) {
        expect(row.nextDueAt).toBe(
          row.lane === "schedule:l0" ? "2026-11-27T16:00:00.000Z" : "2026-11-20T16:00:00.000Z",
        );
      }
    } finally {
      armed?.cancel();
    }
    // Arming searches about a week of minutes per lane, eight lanes over.
  }, 20_000);

  test("an unarmed lane reports no next wake", async () => {
    const control = plane();
    let calls = 0;
    const arm: typeof armScheduleLanes = (lanes, handlers) => {
      calls += 1;
      return armScheduleLanes(lanes, handlers);
    };
    const { armed } = runRendered(EIGHT, control, arm, "false");
    expect(armed).toBeUndefined();
    expect(calls).toBe(0);
    const rows = await scheduleRows(control);
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.nextDueAt).toBeUndefined();
  });
});
