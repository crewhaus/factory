/**
 * The inbox through the API: `attention.list`, `attention.get` and `attention.metrics`
 * carry every field the "Needs you" view reads, from the projection Home keeps or a fold
 * on the spot when there is none; they read only the harnesses the caller may see, before
 * anything is counted or grouped; tool input reaches only a caller who may read a
 * harness's content, masked; an item about people is withheld as every list withholds
 * one; an item's ref answers only where its harness is visible, and an unknown ref and an
 * invisible one answer alike. No read gathers Advisor findings: a sweep does, a few
 * harnesses a minute.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advisorSnapshotRecord,
  advisorSnapshotRel,
  readAdvisorSnapshot,
} from "@crewhaus/attention";
import { mintRunId } from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import { append, runsLedger, writeIndexRecord } from "@crewhaus/control-records";
import { projectOnce } from "@crewhaus/control-service";
import type { AdvisorItem } from "@crewhaus/harness-advice/advisor";
import { type V1Home, v1Home } from "../__test__/v1-home";
import { maskDeep } from "../mask";
import type { SweepContext } from "../scheduler-host";
import type { HomePorts } from "../sweeps";
import {
  ADVISOR_SWEEP_EVERY_MS,
  ADVISOR_SWEEP_PER_TICK,
  ATTENTION_PROJECTION,
  advisorSnapshotSweep,
} from "./attention";

type Schema = { safeParse(value: unknown): { success: boolean; error?: unknown } };
const schemaOf = (id: string) => (SCHEMAS as unknown as Readonly<Record<string, Schema>>)[id];

type Item = Record<string, unknown> & {
  ref: string;
  kind: string;
  band: string;
  harness?: string;
  harnesses?: string[];
  affected: { runs: string[]; count: number };
};

/** A value shaped like a credential, built from parts, under a key the masker hides. */
const CANARY = ["thz", "live", "c".repeat(28)].join("_");
const SAID = "please send the weekly report";
const MODEL = "gemini/gemini-2.5-pro";
const AGO = (ms: number) => new Date(Date.now() - ms).toISOString();

function approval(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    toolName: "SendMessage",
    inputHash: `hash-${id}`,
    input: { channel: "ops", text: SAID, api_key: CANARY },
    runId: "run_00000000000000a0",
    sessionId: "sess_00000000000000aa",
    surface: "daemon",
    createdAt: AGO(60_000),
    ...extra,
  };
}

/** `n` runs that failed with `cls`, through the ledger's own writer. */
function failRuns(dir: string, n: number, cls = "auth"): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = mintRunId();
    const trigger = { kind: "api" };
    const started = append(runsLedger(dir), { id, state: "running", at: AGO(120_000), trigger });
    if (!started.ok) throw new Error(started.reason);
    const ended = append(runsLedger(dir), {
      id,
      state: "failed",
      at: AGO(90_000 - i),
      trigger,
      failureClass: cls,
    });
    if (!ended.ok) throw new Error(ended.reason);
    ids.push(id);
  }
  return ids;
}

/** Point a harness's env chain at the fleet's one shared file. */
function shareFleetEnv(dir: string): void {
  mkdirSync(join(dir, ".crewhaus"), { recursive: true });
  writeFileSync(
    join(dir, ".crewhaus", "settings.json"),
    JSON.stringify({ manager: { envFiles: ["../fleet.env"] } }),
  );
}

function finding(id: string, over: Partial<AdvisorItem> = {}): AdvisorItem {
  return {
    id,
    severity: "suggestion",
    title: "No eval has run",
    detail: "",
    explain: "",
    guidance: "",
    screen: "evals",
    source: "evals",
    action: { kind: "link", label: "Open evals", cliTwin: null, jobKind: null },
    status: "open",
    ...over,
  };
}

let home: V1Home;
let a: { id: string; dir: string };
let b: { id: string; dir: string };
let c: { id: string; dir: string };
let d: { id: string; dir: string };
let e: { id: string; dir: string };
const gathered: string[] = [];

beforeAll(async () => {
  home = await v1Home({
    advisorItems: async (harness) => {
      gathered.push(harness.id);
      return [];
    },
  });
  writeFileSync(join(home.t.harnessesRoot, "fleet.env"), "GEMINI_API_KEY=shared-file\n");
  a = await home.harness("seen-a", {
    model: MODEL,
    approvals: [
      approval("appr_00000000000000a1"),
      approval("appr_00000000000000a5", { sensitivity: "people", toolName: "PeopleLookup" }),
    ],
  });
  b = await home.harness("seen-b", { model: MODEL });
  c = await home.harness("hidden-c", {
    model: MODEL,
    approvals: [approval("appr_00000000000000c1")],
  });
  d = await home.harness("hidden-d", { model: MODEL });
  e = await home.harness("hidden-e", { model: MODEL });
  for (const h of [a, b, c, d]) shareFleetEnv(h.dir);
  failRuns(a.dir, 3);
  failRuns(b.dir, 2);
  failRuns(c.dir, 4);
  failRuns(d.dir, 1);
  writeIndexRecord(
    home.t.hangarRoot,
    advisorSnapshotRel(b.id),
    advisorSnapshotRecord(new Date().toISOString(), [finding("evals-none")]),
  );
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

const itemsOf = (body: Record<string, unknown>) => body["items"] as Item[];
const credentialGroup = (items: readonly Item[]) => items.find((i) => i.kind === "credential");

describe("attention.list", () => {
  test("carries every field the view reads, folded on the spot before any projection exists", async () => {
    const res = await home.call("GET", "/api/v1/attention");
    expect(res.status).toBe(200);
    expect(schemaOf("attentionList")?.safeParse(res.body).success).toBe(true);
    for (const field of ["items", "snapshotAt"]) {
      expect(`${field} ${field in res.body}`).toBe(`${field} true`);
    }
    const items = itemsOf(res.body);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      for (const field of [
        "ref",
        "kind",
        "band",
        "source",
        "title",
        "whyNow",
        "affected",
        "evidence",
        "choices",
        "requiredClass",
        "state",
        "evidenceRev",
        "since",
        "freshness",
      ]) {
        expect(`${item.ref} ${field} ${field in item}`).toBe(`${item.ref} ${field} true`);
      }
      const title = item["title"] as { template: string; params: Record<string, unknown> };
      expect(typeof title.template).toBe("string");
      expect(typeof title.params).toBe("object");
      expect(item["harness"] !== undefined || item["harnesses"] !== undefined).toBe(true);
    }
    expect(items.map((i) => (i["freshness"] as { mode: string }).mode)).toContain("direct-fold");
    // Decide first, then fix, then consider.
    const bands = items.map((i) => i.band);
    const order = ["decide", "fix", "consider"];
    expect([...bands].sort((x, y) => order.indexOf(x) - order.indexOf(y))).toEqual(bands);
    expect(bands).toContain("decide");
    expect(bands).toContain("fix");
    expect(bands).toContain("consider");
    const group = credentialGroup(items);
    expect((group?.["cause"] as { id: string; kind: string; label: string }).kind).toBe(
      "credential",
    );
    const choice = (
      items.find((i) => i.kind === "permission" && i.harness === a.id)?.["choices"] as {
        id: string;
        cliTwin: string | null;
      }[]
    )[0];
    expect(choice?.cliTwin).toContain(`crewhaus approvals ${choice?.id} appr_00000000000000a1`);
  });

  test("after Home's projector runs, the same items come from the projection", async () => {
    const before = itemsOf((await home.call("GET", "/api/v1/attention")).body);
    await projectOnce({
      hangarRoot: home.t.hangarRoot,
      harnesses: [a, b, c, d, e],
      projections: [ATTENTION_PROJECTION as never],
      now: Date.now(),
    });
    const after = itemsOf((await home.call("GET", "/api/v1/attention")).body);
    expect(after.map((i) => (i["freshness"] as { mode: string }).mode)).not.toContain(
      "direct-fold",
    );
    expect(after.map((i) => `${i.ref}:${i["evidenceRev"]}`)).toEqual(
      before.map((i) => `${i.ref}:${i["evidenceRev"]}`),
    );
  });

  test("names the harnesses the Advisor has not checked yet", async () => {
    const res = await home.call("GET", "/api/v1/attention");
    const unchecked = res.body["advisorUnchecked"] as string[];
    expect(unchecked).toContain(a.id);
    expect(unchecked).not.toContain(b.id);
    const advice = itemsOf(res.body).find((i) => i.band === "consider");
    expect(advice?.harness).toBe(b.id);
  });

  test("filters by kind and band, refuses a word that is neither, and says why it is empty", async () => {
    const fix = await home.call("GET", "/api/v1/attention?band=fix");
    expect(itemsOf(fix.body).every((i) => i.band === "fix")).toBe(true);
    const kind = await home.call("GET", "/api/v1/attention?kind=review");
    expect(itemsOf(kind.body)).toEqual([]);
    expect((kind.body["empty"] as { reason: string }).reason).toBe("filtered");
    for (const query of ["kind=nope", "band=urgent", "state=closed", "limit=0", "cursor=x"]) {
      const res = await home.call("GET", `/api/v1/attention?${query}`);
      expect(`${query} ${res.status}`).toBe(`${query} 400`);
    }
    const unknownField = await home.call("GET", "/api/v1/attention?mine=1");
    expect(unknownField.status).toBe(400);
  });

  test("an item about people is withheld, and the list says so", async () => {
    const res = await home.call("GET", "/api/v1/attention");
    expect(res.status).toBe(200);
    expect(JSON.stringify(itemsOf(res.body))).not.toContain("appr_00000000000000a5");
    expect(JSON.stringify(itemsOf(res.body))).not.toContain("PeopleLookup");
    expect(res.body["hidden"]).toEqual(["people"]);
  });
});

describe("only what the caller may read", () => {
  let viewer: { secret: string };

  beforeAll(async () => {
    viewer = await home.service("two-of-five", [a.id, b.id], { permissions: ["home.read"] });
  }, 60_000);

  test("items, a group's harnesses and its count cover only the two visible harnesses", async () => {
    const owner = credentialGroup(itemsOf((await home.call("GET", "/api/v1/attention")).body));
    expect([...(owner?.harnesses ?? [])].sort()).toEqual([a.id, b.id, c.id, d.id].sort());
    expect(owner?.affected.count).toBe(10);
    const res = await home.call("GET", "/api/v1/attention", { secret: viewer.secret });
    expect(res.status).toBe(200);
    const items = itemsOf(res.body);
    const named = new Set(items.flatMap((i) => [i.harness, ...(i.harnesses ?? [])]));
    named.delete(undefined);
    expect([...named].sort()).toEqual([a.id, b.id].sort());
    const group = credentialGroup(items);
    expect([...(group?.harnesses ?? [])].sort()).toEqual([a.id, b.id].sort());
    expect(group?.affected.count).toBe(5);
    expect(JSON.stringify(res.body)).not.toContain(c.id);
    expect(JSON.stringify(res.body)).not.toContain(d.id);
  });

  test("metrics count only the visible harnesses", async () => {
    const all = await home.call("GET", "/api/v1/attention/metrics");
    expect(all.status).toBe(200);
    expect(all.body["harnesses"]).toBe(5);
    const res = await home.call("GET", "/api/v1/attention/metrics", { secret: viewer.secret });
    expect(res.status).toBe(200);
    expect(schemaOf("attentionMetrics")?.safeParse(res.body).success).toBe(true);
    expect(res.body["harnesses"]).toBe(2);
    const open = res.body["open"] as { kind: string; open: number }[];
    // Counts, not items: the request about people is counted, as every count of decisions counts it.
    expect(open.find((row) => row.kind === "permission")?.open).toBe(2);
    const ownerOpen = all.body["open"] as { kind: string; open: number }[];
    expect(ownerOpen.find((row) => row.kind === "permission")?.open).toBe(3);
  });

  test("tool input reaches only a content reader, and only masked", async () => {
    const withheld = await home.call("GET", "/api/v1/attention?kind=permission", {
      secret: viewer.secret,
    });
    const item = itemsOf(withheld.body)[0];
    expect(item?.["body"]).toBeUndefined();
    expect(item?.["bodyWithheld"]).toBe(true);
    expect(JSON.stringify(withheld.body)).not.toContain(SAID);
    const reader = await home.service("reader", [a.id], {
      permissions: ["home.read"],
      contentRead: true,
    });
    const shown = await home.call("GET", "/api/v1/attention?kind=permission", {
      secret: reader.secret,
    });
    const body = itemsOf(shown.body)[0]?.["body"] as { input: Record<string, unknown> };
    expect(body.input["text"]).toBe(SAID);
    expect(body.input["api_key"]).toBe("[redacted]");
    for (const res of [withheld, shown, await home.call("GET", "/api/v1/attention")]) {
      expect(JSON.stringify(res.body)).not.toContain(CANARY);
    }
  });

  test("a breakdown that names a credential survives the masker with its count", async () => {
    const metrics = await home.call("GET", "/api/v1/attention/metrics");
    const open = metrics.body["open"] as { kind: string; open: number }[];
    expect(open.find((row) => row.kind === "credential")?.open).toBe(1);
    expect(maskDeep(metrics.body)).toEqual(metrics.body);
    const row = await home.call("GET", `/api/v1/harnesses/${a.id}`);
    const counts = (row.body["areas"] as Record<string, Record<string, Record<string, number>>>)[
      "attention"
    ]?.["attention"];
    expect(counts?.["fix"]).toBeGreaterThanOrEqual(1);
    expect(counts?.["decide"]).toBeGreaterThanOrEqual(1);
    expect(maskDeep(row.body["areas"])).toEqual(row.body["areas"]);
  });
});

describe("attention.get", () => {
  test("answers an item by its ref or its bare id, with the list's fields", async () => {
    const listed = itemsOf((await home.call("GET", "/api/v1/attention")).body);
    const item = listed.find((i) => i.kind === "permission" && i.harness === a.id) as Item;
    const id = item.ref.slice(item.ref.lastIndexOf("/") + 1);
    for (const asked of [item.ref, id]) {
      const res = await home.call("GET", `/api/v1/attention/${asked}`);
      expect(res.status).toBe(200);
      expect(schemaOf("attentionItem")?.safeParse(res.body).success).toBe(true);
      expect(res.body["ref"]).toBe(item.ref);
      expect(res.body["evidenceRev"]).toBe(item["evidenceRev"]);
    }
    const resolved = await home.call("GET", `/api/v1/refs/${item.ref}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body["href"]).toBe(`/#/home/needs-you?item=${id}`);
  });

  test("a member who reads one of two harnesses reads its item; the other's and an unknown ref answer the same 404", async () => {
    const member = await home.member("Mo", "viewer", { scope: `harness:${a.id}` });
    const listed = itemsOf((await home.call("GET", "/api/v1/attention?kind=permission")).body);
    const mine = listed.find((i) => i.harness === a.id) as Item;
    const theirs = listed.find((i) => i.harness === c.id) as Item;
    expect(theirs).toBeDefined();
    const ok = await home.call("GET", `/api/v1/attention/${mine.ref}`, { secret: member.secret });
    expect(ok.status).toBe(200);
    const hidden = await home.call("GET", `/api/v1/attention/${theirs.ref}`, {
      secret: member.secret,
    });
    const unknown = await home.call(
      "GET",
      `/api/v1/attention/home/attention/att_${"0".repeat(26)}`,
      { secret: member.secret },
    );
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(hidden.body).toEqual(unknown.body);
  });
});

describe("Advisor findings are gathered off the request path", () => {
  test("serving the list, an item and the metrics gathers nothing", async () => {
    const before = gathered.length;
    const listed = itemsOf((await home.call("GET", "/api/v1/attention")).body);
    await home.call("GET", `/api/v1/attention/${listed[0]?.ref}`);
    await home.call("GET", "/api/v1/attention/metrics");
    await home.call("GET", `/api/v1/harnesses/${a.id}`);
    expect(gathered.length).toBe(before);
  });

  test("the sweep gathers at most four harnesses a tick, oldest first, and none twice within a minute", async () => {
    const root = mkdtempSync(join(tmpdir(), "attention-sweep-"));
    try {
      const harnesses = Array.from({ length: 6 }, (_, i) => ({
        id: `hrn_00000000000000${String(i).padStart(2, "0")}`,
        dir: join(root, `h${i}`),
      }));
      const calls: string[] = [];
      const failing = harnesses[5]?.id;
      const ports = {
        hangarRoot: root,
        liveHarnesses: () => harnesses,
        advisorItems: async (h: { id: string }) => {
          calls.push(h.id);
          if (h.id === failing) throw new Error("preflight failed");
          return [finding("evals-none")];
        },
      } as unknown as HomePorts;
      const sweep = advisorSnapshotSweep();
      const warnings: string[] = [];
      const tick = (now: number) =>
        sweep.run({
          now,
          home: ports,
          jobs: {} as never,
          warn: (m) => warnings.push(m),
        } satisfies SweepContext<HomePorts>);
      const T = Date.parse("2026-11-10T12:00:00.000Z");
      await tick(T);
      expect(calls).toHaveLength(ADVISOR_SWEEP_PER_TICK);
      await tick(T + 1_000);
      expect(calls).toHaveLength(6);
      expect(new Set(calls).size).toBe(6);
      expect(warnings.some((w) => w.includes(String(failing)))).toBe(true);
      await tick(T + 2_000);
      await tick(T + ADVISOR_SWEEP_EVERY_MS - 1);
      expect(calls).toHaveLength(6);
      await tick(T + ADVISOR_SWEEP_EVERY_MS);
      expect(calls.slice(6)).toEqual(harnesses.slice(0, 4).map((h) => h.id));
      expect(readAdvisorSnapshot(root, harnesses[0]?.id as string)?.items.map((f) => f.id)).toEqual(
        ["evals-none"],
      );
      expect(readAdvisorSnapshot(root, failing as string)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
