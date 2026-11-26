/**
 * The inspection area through the API: each operation answers its schema; content needs
 * `h.read.content` and its absence is said, never faked; the raw lines need
 * `h.files.raw` and label the model's thinking, which no other answer carries; a
 * credential in a recorded tool result never leaves, whole or split; free text in a
 * fixed line is one line; the timeline pages after an entry; a caught-up read model
 * spares the ledger scan and rebuilds to the same answer; and `runs.create` with `from`
 * starts a run again with the recorded request, needing the right to read it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSPECTION_MODULE, mintRunId } from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import {
  _setIoTapForTest,
  append,
  controlPaths,
  readPage,
  runsLedger,
} from "@crewhaus/control-records";
import { projectOnce } from "@crewhaus/control-service";
import { type V1Home, v1Home } from "../__test__/v1-home";
import { HOME_AREAS, handlersOf, projectionsOf } from "./areas";

type Schema = { safeParse(value: unknown): { success: boolean; error?: unknown } };
const schemaOf = (id: string) => (SCHEMAS as unknown as Readonly<Record<string, Schema>>)[id];
const responseOf = (op: string) =>
  schemaOf(INSPECTION_MODULE.operations.find((row) => row.id === op)?.response as string);

const SESSION = "sess_00000000000000d1";
const ROOT = "0000000000000101";
const MODEL = "0000000000000103";
const TOOL = "0000000000000104";
const ANSWER_MODEL = "0000000000000105";
const AT = Date.parse("2026-11-20T10:00:00.000Z");

/** Built from parts: no credential-shaped literal is committed. */
const PASSWORD = ["pw", "7q1"].join("-");
const API_KEY = ["k", "ab9"].join("");
const ENV_VALUE = ["Zt4", "mQ8w", "Rv2N", "x6Lp"].join("");
const SPLIT = `${ENV_VALUE.slice(0, 6)}\u0007${ENV_VALUE.slice(6)}`;
const THINKING = ["THINK", "CANARY", "41f"].join("-");

let home: V1Home;
let h: { id: string; dir: string };
const RUN = mintRunId();

/** A session log, line by line, with each line's byte offset. */
class Log {
  private readonly parts: string[] = [];
  private bytes = 0;
  private ts = AT;
  add(kind: string, payload: unknown, extra: Record<string, unknown> = {}): number {
    const off = this.bytes;
    this.ts += 10;
    const line = JSON.stringify({ ts: this.ts, version: 1, kind, payload, ...extra });
    this.parts.push(`${line}\n`);
    this.bytes += Buffer.byteLength(line) + 1;
    return off;
  }
  get size(): number {
    return this.bytes;
  }
  text(): string {
    return this.parts.join("");
  }
}

/** The run's session log: a wake marker, then a stamped run that fetched once and answered. */
function runLog(): { text: string; sessionAt: number } {
  const b = new Log();
  b.add("user_message", {
    content: "[crewhaus.control.v1 wake]",
    synthetic: true,
    control: {
      lane: "heartbeat",
      synthetic: true,
      reason: "first\nsecond \u202Ethird",
      by: "max",
    },
  });
  const sessionAt = b.size;
  const on = (span: string) => ({ run: RUN, span });
  b.add(
    "run_stamp",
    { v: 1, run: RUN, trigger: { kind: "heartbeat", lane: "heartbeat", synthetic: true } },
    on(ROOT),
  );
  b.add("user_message", { content: "please check the notes" }, on(ROOT));
  b.add(
    "context_manifest",
    {
      v: 1,
      run: RUN,
      span: MODEL,
      turn: { run: 1, session: 1 },
      call: 1,
      blocks: [{ kind: "instructions", bytes: 12, fingerprint: "a".repeat(64), cached: true }],
      tools: { fingerprint: "b".repeat(64), advertised: 1, inSpec: 1, names: ["Fetch"] },
      model: { wire: "test-model", provider: "anthropic", params: { maxTokens: 1024 } },
      messages: { count: 1, afterCompaction: false },
    },
    on(MODEL),
  );
  b.add(
    "assistant_message",
    {
      content: [
        { type: "thinking", thinking: THINKING, signature: "sig" },
        { type: "text", text: "Looking at the notes." },
        { type: "tool_use", id: "tu_1", name: "Fetch", input: { url: "https://example.test" } },
      ],
    },
    on(MODEL),
  );
  b.add(
    "span_closed",
    { v: 1, run: RUN, span: MODEL, kind: "model", parent: ROOT, call: 1, status: "ok" },
    on(MODEL),
  );
  b.add(
    "tool_use",
    { id: "tu_1", name: "Fetch", input: { url: "https://example.test" } },
    on(TOOL),
  );
  b.add(
    "tool_result",
    {
      toolUseId: "tu_1",
      content: JSON.stringify({ password: PASSWORD, api_key: API_KEY, value: SPLIT }),
      isError: false,
    },
    on(TOOL),
  );
  b.add(
    "span_closed",
    { v: 1, run: RUN, span: TOOL, kind: "tool", parent: ROOT, toolUseId: "tu_1", call: 1 },
    on(TOOL),
  );
  b.add("assistant_message", { content: [{ type: "text", text: "All done." }] }, on(ANSWER_MODEL));
  b.add(
    "span_closed",
    { v: 1, run: RUN, span: ANSWER_MODEL, kind: "model", parent: ROOT, call: 2, status: "ok" },
    on(ANSWER_MODEL),
  );
  b.add("span_closed", { v: 1, run: RUN, span: ROOT, kind: "run", status: "ok" }, on(ROOT));
  return { text: b.text(), sessionAt };
}

/** A harness with its own `crewhaus` on hand, so a cli job plans without one on PATH. */
async function cliHarness(name: string) {
  const made = await home.harness(name);
  const bin = join(made.dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "crewhaus"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "crewhaus"), 0o755);
  return made;
}

/** Every row of a harness's run ledger, oldest first. */
function rowsOf(dir: string): Record<string, unknown>[] {
  return readPage(runsLedger(dir), { limit: 1000 })
    .items.map((item) => ({ ...item.record }))
    .reverse();
}

beforeAll(async () => {
  home = await v1Home({
    apiRunLimits: { perHome: Number.MAX_SAFE_INTEGER, perHarness: Number.MAX_SAFE_INTEGER },
  });
  h = await home.harness("inspected", { envLines: [`EDGE_SECRET=${ENV_VALUE}`] });
  const log = runLog();
  writeFileSync(join(h.dir, ".crewhaus", "sessions", `${SESSION}.jsonl`), log.text);
  const at = new Date(AT).toISOString();
  for (const row of [
    {
      id: RUN,
      state: "running",
      at,
      trigger: { kind: "heartbeat", lane: "heartbeat", synthetic: true },
      session: SESSION,
      sessionAt: log.sessionAt,
    },
    { id: RUN, state: "succeeded", at },
  ]) {
    const written = append(runsLedger(h.dir), row);
    if (!written.ok) throw new Error("row not written");
  }
}, 60_000);

afterAll(async () => {
  _setIoTapForTest(undefined);
  await home?.t.stop();
});

const errorOf = (body: Record<string, unknown>) => body["error"] as Record<string, unknown>;

/** Every inspect.* read of the run, as `who` makes them. */
async function everyRead(secret?: string) {
  const opts = secret !== undefined ? { secret } : {};
  const out: Record<string, { status: number; body: Record<string, unknown> }> = {};
  for (const [op, path] of [
    ["inspect.summary", `/api/v1/runs/${RUN}/inspect`],
    ["inspect.timeline", `/api/v1/runs/${RUN}/timeline?view=full`],
    ["inspect.why", `/api/v1/runs/${RUN}/why/tool:${TOOL}`],
    ["inspect.context", `/api/v1/runs/${RUN}/context/all`],
    ["inspect.request", `/api/v1/runs/${RUN}/request`],
    ["inspect.export", `/api/v1/runs/${RUN}/export`],
    ["inspect.raw", `/api/v1/runs/${RUN}/raw`],
    ["inspect.session", `/api/v1/harnesses/${h.id}/sessions/${SESSION}/inspect`],
  ] as const) {
    out[op] = await home.call("GET", path, opts);
  }
  return out;
}

describe("the inspection area", () => {
  test("every operation has a handler, and each answer the owner gets fits its schema", async () => {
    const handlers = handlersOf(HOME_AREAS);
    for (const row of INSPECTION_MODULE.operations) expect(handlers.has(row.id)).toBe(true);
    const reads = await everyRead();
    for (const [op, res] of Object.entries(reads)) {
      expect([op, res.status]).toEqual([op, 200]);
      expect([op, responseOf(op)?.safeParse(res.body).success]).toEqual([op, true]);
    }
    const summary = reads["inspect.summary"]?.body as Record<string, unknown>;
    expect(summary["asked"]).toMatchObject({ state: "recorded", value: "please check the notes" });
    expect(summary["subject"]).toEqual({ kind: "run", run: RUN, session: SESSION });
  }, 20_000); // eight reads of one run

  test("without the content right: content left out, said so, and no-access named", async () => {
    const reader = await home.service("inspect-no-content", [h.id], { permissions: ["h.read"] });
    const summary = await home.call("GET", `/api/v1/runs/${RUN}/inspect`, {
      secret: reader.secret,
    });
    expect(summary.status).toBe(200);
    expect(summary.body["hidden"]).toEqual(["content"]);
    expect(summary.body["asked"]).toBeUndefined();
    expect(summary.body["outcome"]).toBeUndefined();
    expect(summary.body["wake"]).toBeUndefined();
    expect((summary.body["gaps"] as Array<{ reason: string }>).map((g) => g.reason)).toContain(
      "no-access",
    );
    expect(JSON.stringify(summary.body)).not.toContain("please check the notes");
    const page = await home.call("GET", `/api/v1/runs/${RUN}/timeline?view=full`, {
      secret: reader.secret,
    });
    expect(page.status).toBe(200);
    const entries = page.body["entries"] as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e["detail"] === undefined)).toBe(true);
    expect(page.body["hidden"]).toEqual(["content"]);
    const why = await home.call("GET", `/api/v1/runs/${RUN}/why/tool:${TOOL}`, {
      secret: reader.secret,
    });
    expect(why.status).toBe(403);
    expect(errorOf(why.body)["needs"]).toBe("h.read.content");
  });

  test("the query takes only its own names; a bad view is 400 naming view", async () => {
    const bogus = await home.call("GET", `/api/v1/runs/${RUN}/timeline?bogus=1`);
    expect(bogus.status).toBe(400);
    expect(errorOf(bogus.body)["reason"]).toBe("unknown_fields");
    const page = await home.call("GET", `/api/v1/runs/${RUN}/timeline?view=full`);
    const anchor = (page.body["entries"] as Array<{ id: string }>)[3]?.id as string;
    const after = await home.call(
      "GET",
      `/api/v1/runs/${RUN}/timeline?view=full&after=${anchor}&harness=${h.id}`,
    );
    expect(after.status).toBe(200);
    expect((after.body["entries"] as Array<{ id: string }>).map((e) => e.id)).toEqual(
      (page.body["entries"] as Array<{ id: string }>).slice(0, 3).map((e) => e.id),
    );
    const bad = await home.call("GET", `/api/v1/runs/${RUN}/timeline?view=everything`);
    expect(bad.status).toBe(400);
    expect(errorOf(bad.body)["details"]).toMatchObject({ field: "view" });
    const both = await home.call(
      "GET",
      `/api/v1/runs/${RUN}/timeline?before=${anchor}&after=${anchor}`,
    );
    expect(both.status).toBe(400);
  });

  test("raw lines are the owner's, and label the model's thinking; no other answer carries it", async () => {
    const maintainer = await home.member("inspect-maintainer", "maintainer");
    const refused = await home.call("GET", `/api/v1/runs/${RUN}/raw`, {
      secret: maintainer.secret,
    });
    expect(refused.status).toBe(403);
    expect(errorOf(refused.body)["needs"]).toBe("h.files.raw");
    const reads = await everyRead();
    const raw = reads["inspect.raw"]?.body as Record<string, unknown>;
    expect(raw["annotations"]).toEqual([
      expect.objectContaining({ path: ["payload", "content", 0], label: "thinking" }),
    ]);
    for (const [op, res] of Object.entries(reads)) {
      if (op === "inspect.raw") continue;
      expect([op, JSON.stringify(res.body).includes(THINKING)]).toEqual([op, false]);
    }
    for (const who of [maintainer.secret]) {
      for (const path of [`/api/v1/runs/${RUN}/inspect`, `/api/v1/runs/${RUN}/export`]) {
        const res = await home.call("GET", path, { secret: who });
        expect(JSON.stringify(res.body)).not.toContain(THINKING);
      }
    }
  }, 20_000); // two sign-ins and eight reads

  test("a credential in a tool result never leaves, by name or split by a control", async () => {
    const reads = await everyRead();
    for (const [op, res] of Object.entries(reads)) {
      const text = JSON.stringify(res.body);
      expect([op, text.includes(PASSWORD), text.includes(API_KEY)]).toEqual([op, false, false]);
      expect([op, text.includes(ENV_VALUE)]).toEqual([op, false]);
      expect([op, text.includes("\\u0007")]).toEqual([op, false]);
    }
  }, 20_000); // eight reads of one run

  test("a wake's reason with a newline and a direction override is one line", async () => {
    const summary = await home.call("GET", `/api/v1/runs/${RUN}/inspect`);
    const wake = summary.body["wake"] as { value: { words: string } };
    expect(wake.value.words).toBe("operator wake: first second third (by max)");
    const page = await home.call("GET", `/api/v1/runs/${RUN}/timeline?view=full`);
    const details = (page.body["entries"] as Array<{ kind: string; detail?: string }>)
      .filter((e) => e.kind === "operator-wake" || e.kind === "run-start")
      .map((e) => e.detail ?? "");
    expect(details.length).toBe(2);
    for (const detail of details) {
      expect(detail).toContain("first second third");
      expect(detail).not.toMatch(/[\n\u202E]/);
    }
  });

  test("an export is a JSON document to save, every entry in it", async () => {
    const res = await home.call("GET", `/api/v1/runs/${RUN}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${RUN}.json"`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const page = await home.call("GET", `/api/v1/runs/${RUN}/timeline?view=full&limit=500`);
    expect((res.body["timeline"] as unknown[]).length).toBe(
      (page.body["entries"] as unknown[]).length,
    );
    expect(res.body).toMatchObject({ v: 1, run: RUN, why: null, truncated: false });
  });

  test("a caught-up read model spares the ledger scan, and rebuilds to the same answer", async () => {
    const harnesses = [{ id: h.id, dir: h.dir }];
    const projections = projectionsOf(HOME_AREAS).map((row) => row.projection);
    const project = () =>
      projectOnce({ hangarRoot: home.t.hangarRoot, harnesses, projections, now: Date.now() });
    await project();
    const ledgerOpens = async (): Promise<{ opens: number; body: unknown }> => {
      let opens = 0;
      _setIoTapForTest({
        open: (given) => {
          if (/control[\\/]runs[\\/]/.test(given)) opens += 1;
        },
      });
      try {
        const res = await home.call("GET", `/api/v1/runs/${RUN}/inspect`);
        expect(res.status).toBe(200);
        return { opens, body: res.body };
      } finally {
        _setIoTapForTest(undefined);
      }
    };
    const fresh = await ledgerOpens();
    const saved = join(home.t.hangarRoot, "cache", "index", h.id, "inspect.json");
    expect(existsSync(saved)).toBe(true);
    rmSync(saved, { force: true });
    const stale = await ledgerOpens();
    expect(stale.opens).toBeGreaterThan(fresh.opens);
    await project();
    expect(existsSync(saved)).toBe(true);
    const rebuilt = await ledgerOpens();
    expect(rebuilt.opens).toBe(fresh.opens);
    expect(rebuilt.body).toEqual(fresh.body);
    expect(stale.body).toEqual(fresh.body);
  }, 20_000); // two projector passes and three reads

  test("a work item's runs, newest first, and why none are listed", async () => {
    const unknown = "wi_01jd0000000000000000000001";
    const missing = await home.call("GET", `/api/v1/work/${h.id}/work/${unknown}/inspect`);
    expect(missing.status).toBe(404);
    const w = await home.harness("inspect-work");
    const added = await home.call("POST", `/api/v1/harnesses/${w.id}/work`, {
      body: { title: "Fix the import error", kind: "fix" },
    });
    expect(added.status).toBe(200);
    const wi = String((added.body["item"] as Record<string, unknown>)["id"]);
    const ref = `/api/v1/work/${w.id}/work/${wi}/inspect`;
    const none = await home.call("GET", ref);
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ runs: [], empty: { reason: "no-data" } });
    const [older, newer] = [mintRunId(), mintRunId()];
    const at = new Date(AT).toISOString();
    append(runsLedger(w.dir), { id: older, state: "queued", at, workItem: wi });
    append(runsLedger(w.dir), { id: mintRunId(), state: "queued", at });
    append(runsLedger(w.dir), { id: newer, state: "queued", at, workItem: wi });
    append(runsLedger(w.dir), { id: older, state: "succeeded", at });
    const listed = await home.call("GET", ref);
    expect(listed.status).toBe(200);
    expect(responseOf("inspect.work")?.safeParse(listed.body).success).toBe(true);
    expect(listed.body["runs"]).toEqual([
      expect.objectContaining({ run: newer, state: "queued", workItem: wi }),
      expect.objectContaining({ run: older, state: "succeeded", workItem: wi }),
    ]);
    expect(listed.body["empty"]).toBeUndefined();
  });
});

describe("runs.create with from", () => {
  test("starts a run again with the recorded input, and says which run it repeats", async () => {
    const c = await cliHarness("rerun-cli");
    const first = await home.call("POST", `/api/v1/harnesses/${c.id}/runs`, {
      body: { input: "Summarise the report." },
    });
    expect(first.status).toBe(202);
    const source = String((first.body["run"] as Record<string, unknown>)["id"]);
    // As a run started for someone records it: who it served is in its input file.
    const sourceFile = join(c.dir, controlPaths(c.dir).inputsDir, `${source}.json`);
    writeFileSync(
      sourceFile,
      `${JSON.stringify({ v: 1, run: source, input: "Summarise the report.", subject: "customer-7" })}\n`,
    );
    const again = await home.call("POST", `/api/v1/harnesses/${c.id}/runs`, {
      body: { from: source },
    });
    expect(again.status).toBe(202);
    const runId = String((again.body["run"] as Record<string, unknown>)["id"]);
    expect(again.body["run"]).toMatchObject({ attemptOf: source, state: "queued" });
    const inputs = join(c.dir, controlPaths(c.dir).inputsDir);
    const saved = JSON.parse(readFileSync(join(inputs, `${runId}.json`), "utf8"));
    expect(saved).toEqual({ v: 1, run: runId, input: "Summarise the report." });
    const queued = rowsOf(c.dir).find((row) => row["id"] === runId && row["state"] === "queued");
    expect(queued?.["attemptOf"]).toBe(source);
    // The request view shows the receipt and the input file's input.
    const request = await home.call("GET", `/api/v1/runs/${source}/request`);
    expect(request.body).toMatchObject({
      present: true,
      input: { source: "input-file", text: "Summarise the report." },
    });
    expect(JSON.stringify(request.body)).not.toContain("customer-7");
    expect(responseOf("inspect.request")?.safeParse(request.body).success).toBe(true);
  });

  test("once the input file is gone, the seed message from its transcript", async () => {
    const c = await cliHarness("rerun-seed");
    const source = mintRunId();
    const sessions = join(c.dir, ".crewhaus", "sessions");
    const seedSession = "sess_00000000000000d2";
    const stamp = { run: source, span: ROOT };
    writeFileSync(
      join(sessions, `${seedSession}.jsonl`),
      `${[
        JSON.stringify({ ts: AT, kind: "run_stamp", payload: { v: 1, run: source }, ...stamp }),
        JSON.stringify({
          ts: AT,
          kind: "user_message",
          payload: { content: "the seed" },
          ...stamp,
        }),
      ].join("\n")}\n`,
    );
    append(runsLedger(c.dir), {
      id: source,
      state: "running",
      at: new Date(AT).toISOString(),
      trigger: { kind: "api" },
      session: seedSession,
      sessionAt: 0,
    });
    const res = await home.call("POST", `/api/v1/harnesses/${c.id}/runs`, {
      body: { from: source },
    });
    expect(res.status).toBe(202);
    const runId = String((res.body["run"] as Record<string, unknown>)["id"]);
    const inputs = join(c.dir, controlPaths(c.dir).inputsDir);
    expect(JSON.parse(readFileSync(join(inputs, `${runId}.json`), "utf8"))["input"]).toBe(
      "the seed",
    );
    // A seed past the API's body cap is not started again.
    const big = mintRunId();
    const bigSession = "sess_00000000000000d3";
    writeFileSync(
      join(sessions, `${bigSession}.jsonl`),
      `${[
        JSON.stringify({ ts: AT, kind: "run_stamp", payload: { v: 1, run: big }, run: big }),
        JSON.stringify({
          ts: AT,
          kind: "user_message",
          payload: { content: "z".repeat(256 * 1024 + 1) },
          run: big,
        }),
      ].join("\n")}\n`,
    );
    append(runsLedger(c.dir), {
      id: big,
      state: "running",
      at: new Date(AT).toISOString(),
      session: bigSession,
      sessionAt: 0,
    });
    const tooLarge = await home.call("POST", `/api/v1/harnesses/${c.id}/runs`, {
      body: { from: big },
    });
    expect(tooLarge.status).toBe(501);
    expect(errorOf(tooLarge.body)).toMatchObject({
      code: "unsupported",
      reason: "input_too_large",
    });
  });

  test("needs the right to read content; another harness's run is 404; both fields are 400", async () => {
    const c = await cliHarness("rerun-rights");
    const first = await home.call("POST", `/api/v1/harnesses/${c.id}/runs`, {
      body: { input: "Brief." },
    });
    const source = String((first.body["run"] as Record<string, unknown>)["id"]);
    const submitter = await home.service("rerun-no-content", [c.id], {
      permissions: ["h.read", "h.run.submit"],
    });
    const refused = await home.call("POST", `/api/v1/harnesses/${c.id}/runs`, {
      body: { from: source },
      secret: submitter.secret,
      headers: { "Idempotency-Key": "rerun-1" },
    });
    expect(refused.status).toBe(403);
    expect(errorOf(refused.body)["needs"]).toBe("h.read.content");
    const other = await cliHarness("rerun-other");
    const elsewhere = await home.call("POST", `/api/v1/harnesses/${other.id}/runs`, {
      body: { from: source },
    });
    expect(elsewhere.status).toBe(404);
    const both = await home.call("POST", `/api/v1/harnesses/${c.id}/runs`, {
      body: { input: "x", from: source },
    });
    expect(both.status).toBe(400);
    expect(errorOf(both.body)["code"]).toBe("invalid");
  });

  test("a shape that cannot start runs refuses as it does for any input", async () => {
    const ch = await home.harness("rerun-channel", { target: "channel" });
    const source = mintRunId();
    append(runsLedger(ch.dir), { id: source, state: "queued", at: new Date(AT).toISOString() });
    const inputs = join(ch.dir, controlPaths(ch.dir).inputsDir);
    mkdirSync(inputs, { recursive: true });
    writeFileSync(join(inputs, `${source}.txt`), "hello");
    const res = await home.call("POST", `/api/v1/harnesses/${ch.id}/runs`, {
      body: { from: source },
    });
    expect(res.status).toBe(501);
    expect(errorOf(res.body)["reason"]).toBe("unsupported_by_shape");
  });
});
