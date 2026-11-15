/**
 * A harness's supervisor ledger is read on the v1 paths as one contained record file: a
 * regular file inside the harness, never a FIFO and never through a link. A ledger that is
 * either answers as one that names no execution, for `refs.resolve` (a scoped ref and a
 * bare id) and for `access.scopedTokens.mint`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSeal } from "@crewhaus/control-contract/http";
import { newRunId } from "@crewhaus/harness-supervisor";
import { type V1Home, v1Home } from "../__test__/v1-home";

let home: V1Home;
let h: { id: string; dir: string };
let service: { secret: string };
let outside: string;

beforeAll(async () => {
  home = await v1Home();
  h = await home.harness("ledger-shapes");
  service = await home.service("ledger-portal", [h.id]);
  outside = mkdtempSync(join(tmpdir(), "ledger-outside-"));
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
  rmSync(outside, { recursive: true, force: true });
});

/** One supervisor ledger line naming `id`, as the supervisor writes it. */
function ledgerLine(id: string): string {
  return JSON.stringify({
    runId: id,
    kind: "daemon",
    argv: ["crewhaus", "run"],
    startedAt: "2026-11-11T00:00:00.000Z",
    logFile: `logs/${id}.log`,
  });
}

/** The three answers that look an execution up in the supervisor ledger. */
async function lookups(id: string) {
  const scoped = await home.call("GET", `/api/v1/refs/${h.id}/exec/${id}`);
  const bare = await home.call("GET", `/api/v1/refs/${id}?harness=${h.id}`);
  const minted = await home.call("POST", "/api/v1/access/scoped-tokens", {
    body: {
      refs: [`${h.id}/exec/${id}`],
      acts: ["run.result.read"],
      seal: (await makeSeal()).seal,
    },
    secret: service.secret,
  });
  const reason = (res: { body: Record<string, unknown> }) =>
    (res.body["error"] as Record<string, unknown> | undefined)?.["reason"];
  return [
    [scoped.status, reason(scoped)],
    [bare.status, reason(bare)],
    [minted.status, reason(minted)],
  ];
}

const NOT_ON_RECORD = [
  [404, "ref_unknown"],
  [422, "ref_unknown"],
  [422, "refs"],
];

describe.skipIf(process.platform === "win32")(
  "a supervisor ledger that is not a regular file inside the harness",
  () => {
    test("a FIFO names no execution", async () => {
      const id = newRunId();
      const run = join(h.dir, ".crewhaus", "run");
      mkdirSync(run, { recursive: true });
      const fifo = join(run, "runs.jsonl");
      rmSync(fifo, { force: true });
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      // A writer that answers every open of the FIFO with a line naming `id`: a read that
      // opened it would get that line rather than wait on an empty pipe.
      const writer = Bun.spawn(["sh", "-c", 'while :; do printf "%s\\n" "$LINE" > "$FIFO"; done'], {
        env: { ...process.env, LINE: ledgerLine(id), FIFO: fifo },
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        expect(await lookups(id)).toEqual(NOT_ON_RECORD);
      } finally {
        writer.kill();
        await writer.exited;
        rmSync(fifo, { force: true });
      }
    }, 20_000); // a Home, a writer process and three requests; slow on a loaded runner

    test("a link to a file outside the harness names no execution", async () => {
      const id = newRunId();
      const target = join(outside, "runs.jsonl");
      writeFileSync(target, `${ledgerLine(id)}\n`);
      const run = join(h.dir, ".crewhaus", "run");
      mkdirSync(run, { recursive: true });
      const link = join(run, "runs.jsonl");
      rmSync(link, { force: true });
      symlinkSync(target, link);
      try {
        expect(await lookups(id)).toEqual(NOT_ON_RECORD);
      } finally {
        rmSync(link, { force: true });
      }
    });

    test("the same line in the harness's own ledger names the execution", async () => {
      const id = newRunId();
      const run = join(h.dir, ".crewhaus", "run");
      mkdirSync(run, { recursive: true });
      writeFileSync(join(run, "runs.jsonl"), `${ledgerLine(id)}\n`);
      const answers = await lookups(id);
      expect(answers.map(([status]) => status)).toEqual([200, 200, 200]);
    });
  },
);
