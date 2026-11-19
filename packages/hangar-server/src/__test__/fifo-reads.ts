/**
 * A child-process probe for reads of a named pipe with no writer: it boots a Home, plants
 * the pipes the scenario names in a registered harness, makes the requests that read them,
 * prints one JSON line of `{label: status}`, and exits. A read that waited on a pipe would
 * never print, so the parent test, which kills this process at its deadline, fails instead
 * of freezing its own runner.
 *
 * Usage: `bun fifo-reads.ts <runfile|ledger|capped|settings-beside>`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type V1Home, v1Home } from "./v1-home";

const SPEC = "pipes";

/** Make a named pipe at `path`, replacing whatever is there. */
function fifo(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  rmSync(path, { force: true });
  const made = Bun.spawnSync(["mkfifo", path]);
  if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
}

async function statuses(
  home: V1Home,
  requests: ReadonlyArray<readonly [string, string, string, unknown?]>,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [label, method, path, body] of requests) {
    out[label] = (await home.call(method, path, body === undefined ? {} : { body })).status;
  }
  return out;
}

async function main(scenario: string): Promise<Record<string, number>> {
  const home = await v1Home();
  try {
    const h = await home.harness(SPEC);
    const run = join(h.dir, ".crewhaus", "run");
    const harnessRoutes = [
      ["harness", "GET", `/api/v1/harnesses/${h.id}`],
      ["capabilities", "GET", `/api/v1/harnesses/${h.id}/capabilities`],
    ] as const;
    if (scenario === "runfile") {
      fifo(join(run, "daemon.json"));
      return await statuses(home, harnessRoutes);
    }
    if (scenario === "ledger") {
      mkdirSync(run, { recursive: true });
      writeFileSync(
        join(run, "daemon.json"),
        `${JSON.stringify({
          v: 1,
          pid: process.pid,
          pidStartTimeMs: Date.now(),
          argvFingerprint: "0".repeat(64),
          runId: "run_00000000000000c1",
          startedAt: new Date().toISOString(),
        })}\n`,
      );
      fifo(join(run, "runs.jsonl"));
      return await statuses(home, harnessRoutes);
    }
    if (scenario === "capped") {
      const ch = join(h.dir, ".crewhaus");
      fifo(join(ch, "wiki", SPEC, "articles", "piped.md"));
      fifo(join(ch, "state", SPEC, "focus.md"));
      fifo(join(ch, "settings.json"));
      return await statuses(home, [
        ["wiki", "GET", `/api/h/${h.id}/memory/wiki/piped/versions`],
        ["continuity", "GET", `/api/h/${h.id}/memory/continuity`],
        [
          "settings",
          "PUT",
          `/api/h/${h.id}/inspect/settings`,
          { settings: { permissions: { allow: ["Read"] } }, dryRun: true },
        ],
      ]);
    }
    if (scenario === "settings-beside") {
      // A named pipe beside the settings file: the write neither opens it nor waits on it.
      fifo(join(h.dir, ".crewhaus", "settings.json.hangar-tmp"));
      return await statuses(home, [
        [
          "settings",
          "PUT",
          `/api/h/${h.id}/inspect/settings`,
          { settings: { permissions: { allow: ["Read"] } }, confirmName: SPEC },
        ],
      ]);
    }
    throw new Error(`unknown scenario ${scenario}`);
  } finally {
    await home.t.stop();
  }
}

const result = await main(process.argv[2] ?? "");
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
