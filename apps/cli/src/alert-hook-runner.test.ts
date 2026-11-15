/**
 * The settings.json `alert` hook runner `crewhaus run` wires into the alert and
 * SLO sinks: an alert hook that cannot run is logged with its command, and the
 * delivery goes on to the webhook.
 *
 * A hook "cannot be started" through a `Bun.spawn` spy that throws for one
 * marker command and delegates every other call to the real spawn. Webhook URLs
 * are built at runtime from parts.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { RunHooksOptions } from "@crewhaus/hooks-engine";
import type { AlertBreachPayload } from "@crewhaus/runtime-core";
import { buildAlertSink, settingsAlertHookRunner } from "./alert-sink";

const MARKER = "exit 0 # alert-cannot-start";
const realSpawn = Bun.spawn.bind(Bun);
let spawnSpy: ReturnType<typeof spyOn> | undefined;
let throws = 0;

function spawnFailsForMarker(): void {
  throws = 0;
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
    const first = args[0];
    if (Array.isArray(first) && first[2] === MARKER) {
      throws += 1;
      throw Object.assign(new Error("spawn failed"), { code: "EMFILE" });
    }
    return (realSpawn as (...a: unknown[]) => unknown)(...args);
  }) as unknown as typeof Bun.spawn);
}
afterEach(() => {
  spawnSpy?.mockRestore();
  spawnSpy = undefined;
});

type HookLogger = NonNullable<RunHooksOptions["logger"]>;

function recordingLogger(): { logger: HookLogger; warned: Array<[string, unknown]> } {
  const warned: Array<[string, unknown]> = [];
  const noop = () => {};
  const logger = {
    debug: noop,
    info: noop,
    error: noop,
    warn: (msg: string, data?: unknown) => {
      warned.push([msg, data]);
    },
  } as unknown as HookLogger;
  return { logger, warned };
}

const breach: AlertBreachPayload = {
  sessionId: "sess_alert",
  metric: "turn_p95_seconds",
  observed: 30,
  threshold: 5,
  baselineSessions: 6,
  detail: "turn_p95_seconds exceeded",
};

const WEBHOOK_URL = ["https://hooks.example.test", "services", "T000", "B000"].join("/");

describe("settingsAlertHookRunner", () => {
  test("an alert hook that cannot be started is logged with its command, and the webhook still runs", async () => {
    spawnFailsForMarker();
    const { logger, warned } = recordingLogger();
    const posted: string[] = [];
    const sinkWarnings: string[] = [];
    const sink = buildAlertSink({
      runAlertHooks: settingsAlertHookRunner([{ event: "alert", command: MARKER }], logger),
      webhookUrl: WEBHOOK_URL,
      fetchImpl: (async (url: string | URL | Request) => {
        posted.push(String(url));
        return new Response(null, { status: 200 });
      }) as typeof fetch,
      warn: (line) => {
        sinkWarnings.push(line);
      },
    });
    await sink?.fireAlertHook?.(breach);
    expect(throws).toBe(1);
    expect(warned).toEqual([["hook could not run", { command: MARKER, error: "spawn failed" }]]);
    expect(posted).toEqual([WEBHOOK_URL]);
    expect(sinkWarnings).toEqual([]);
  });

  test("an alert hook that exits non-zero is logged with its command", async () => {
    const { logger, warned } = recordingLogger();
    const command = "exit 3";
    await settingsAlertHookRunner([{ event: "alert", command }], logger)("alert", breach, "metric");
    expect(warned.map(([msg]) => msg)).toEqual(["hook nonzero exit"]);
    expect((warned[0]?.[1] as { command?: string } | undefined)?.command).toBe(command);
  });

  test("matches alert hooks by the breached metric", async () => {
    spawnFailsForMarker();
    const { logger, warned } = recordingLogger();
    await settingsAlertHookRunner(
      [
        { event: "alert", matcher: "cost_*", command: MARKER },
        { event: "alert", matcher: "turn_*", command: MARKER },
      ],
      logger,
    )("alert", breach, "metric");
    expect(throws).toBe(1);
    expect(warned).toHaveLength(1);
  });
});
