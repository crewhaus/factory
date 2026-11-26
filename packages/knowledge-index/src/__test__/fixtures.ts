/** Harnesses with real stores in temporary directories, and what tests ask of them. */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createContinuityStore, moveToTrash } from "@crewhaus/continuity-store";
import { mintId } from "@crewhaus/control-contract";
import type { KnowledgeItem } from "@crewhaus/control-contract/knowledge";
import { createMemoryStore } from "@crewhaus/memory-store";
import { openWorkStore } from "@crewhaus/tool-work/work-items";
import { createWikiStore } from "@crewhaus/wiki-store";

const dirs: string[] = [];

export function tempDir(prefix = "knowledge-index-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const SESS = "sess_00000000000000aa";
export const OTHER_SESS = "sess_00000000000000bb";
export const GONE_SESS = "sess_00000000000000cc";
export const HRN = "hrn_00000000000000a1";
export const NOW = new Date("2026-11-01T00:00:00.000Z");
export const now = (): Date => NOW;

/** A word of its own, built from parts, so no test file holds it whole. */
export const marker = (name: string): string => ["PLANTED", name, "4411"].join("");

export function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export const writeJson = (dir: string, rel: string, value: unknown): void =>
  write(dir, rel, `${JSON.stringify(value)}\n`);

export const memories = (dir: string, spec = "bot", base = ".crewhaus") =>
  createMemoryStore({ specName: spec, rootDir: join(dir, base, "memories"), now });
export const wiki = (dir: string, spec = "bot", base = ".crewhaus") =>
  createWikiStore({ specName: spec, rootDir: join(dir, base, "wiki"), now });
export const state = (dir: string, opts: { session?: string; base?: string; spec?: string } = {}) =>
  createContinuityStore({
    specName: opts.spec ?? "bot",
    rootDir: join(dir, opts.base ?? ".crewhaus", "state"),
    now,
    ...(opts.session !== undefined
      ? { scope: { kind: "session", sessionId: opts.session } as const }
      : {}),
  });

/** A session's log and metadata, last touched on `at`. */
export function session(dir: string, id: string, at = new Date("2026-10-20T00:00:00.000Z")): void {
  write(dir, join(".crewhaus", "sessions", `${id}.jsonl`), '{"kind":"user_message"}\n');
  writeJson(dir, join(".crewhaus", "sessions", `${id}.json`), {
    id,
    name: "support",
    target: "cli",
    model: "m",
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
    lastTurnIndex: 1,
  });
  for (const suffix of ["jsonl", "json"]) {
    utimesSync(join(dir, ".crewhaus", "sessions", `${id}.${suffix}`), at, at);
  }
}

export const GRADERS = `combine: all
graders:
  - name: exact
    type: exact_match
criteria:
  - id: dates-local
    description: Dates are written the local way
    severity: high
    protected: true
    measured_by: [exact]
`;

/** A harness that knows something of every kind. */
export async function seedHarness(dir: string) {
  write(dir, "crewhaus.yaml", "name: bot\ntarget: cli\n");
  session(dir, SESS);
  const facts = memories(dir);
  const refunds = await facts.remember("Refunds over 500 need a manager", ["billing"], {
    provenance: { sessionId: SESS, author: { kind: "agent", via: "remember" } },
  });
  const wrong = await facts.remember("The office opens at 8", [], {
    provenance: { sessionId: SESS, evidence: ["tu_1"] },
  });
  const { successor: right } = await facts.supersede(wrong.id, "The office opens at 9", {
    reason: "checked the door",
    author: { kind: "operator", via: "cli" },
  });
  const old = await facts.remember("The old printer is on floor 2", [], {
    provenance: { sessionId: GONE_SESS },
  });
  await facts.forget(old.id, { reason: "it was removed" });
  await facts.compact(); // `wrong` and `old` move to the archive
  const loose = await facts.remember("Nobody knows where this came from");
  const passing = await facts.remember("The fair is on this week", [], { ttlMs: 1000 });
  writeJson(dir, join(".crewhaus", "memories", "shared.jsonl"), {
    id: "mem_shared_1",
    text: "Invoices go out on Mondays",
    tags: ["billing", "shared:finance"],
    createdAt: "2026-10-01T00:00:00.000Z",
  });

  const articles = wiki(dir);
  await articles.write({
    slug: "billing-faq",
    title: "Billing FAQ",
    body: "Refund windows are thirty days long.",
    tags: ["billing"],
    createdBy: { sessionId: SESS, agentIdentity: "writer" },
  });
  await articles.write({
    slug: "billing-faq",
    title: "Billing FAQ",
    body: "Refund windows are forty days long.",
    tags: ["billing"],
    sources: ["https://example.com/policy"],
    expectedVersion: 1,
    author: { kind: "operator", via: "cli" },
  });
  await articles.write({ slug: "old-news", title: "Old news", body: "It is over." });
  await articles.setStatus("old-news", "archived", { expectedVersion: 1 });

  const spec = state(dir);
  await spec.writeFocus("ship the quarterly report");
  await spec.appendRequirement({
    text: "send it every Friday",
    source: { sessionId: SESS, turn: 3 },
  });
  const plan = await spec.createPlan({
    title: "Migrate invoices",
    steps: ["draft the map", "send it"],
  });
  await spec.setActivePlan(plan.id);
  await spec.writeGoal({ title: "Report sent" });
  await state(dir, { session: OTHER_SESS }).writeFocus("answer the customer");
  const cleared = state(dir, { session: SESS });
  await cleared.writeFocus("something cleared");
  const { ts } = await moveToTrash(
    [join(dir, ".crewhaus", "state", "bot", "sessions", SESS, "focus.md")],
    join(dir, ".crewhaus"),
    { now },
  );

  writeJson(dir, join(".crewhaus", "sessions-index", `${SESS}.json`), {
    schemaVersion: 1,
    sessionId: SESS,
    turnCount: 2,
    toolsUsed: [],
    ratings: { positive: 0, negative: 0 },
    outcome: "The refund was granted.",
    keyFacts: ["The refund needed a manager."],
    hadError: false,
    summarizedAt: "2026-10-20T01:00:00.000Z",
  });

  const lesson = "Confirm the currency before quoting";
  write(
    dir,
    "LESSONS.md",
    `# LESSONS\n\n- a person's own note\n\n<!-- crewhaus:lessons -->\n\n## Corrections & preferences\n\n- ${lesson}\n\n## Known failure patterns\n\n- Watch out: the mail tool times out.\n`,
  );
  writeJson(dir, join(".crewhaus", "lessons", "provenance.jsonl"), {
    v: 1,
    at: "2026-10-05T00:00:00.000Z",
    lesson: lessonId(lesson),
    kind: "correction",
    sessions: [SESS],
  });
  writeJson(dir, join(".crewhaus", "lessons", "retired.jsonl"), {
    v: 1,
    at: "2026-10-06T00:00:00.000Z",
    lesson: "l00000000000000ff",
  });
  write(dir, join(".crewhaus", "watchme", "synthesized", "support-draft.yaml"), "name: x\n");
  writeJson(dir, join(".crewhaus", "dream", "bot", "idempotency.json"), {
    version: 1,
    records: {
      old: {
        key: "old",
        completedAt: "2026-10-01T00:00:00.000Z",
        result: { phase1: { findings: ['promotion candidate: "stale" corroborated (mem_x)'] } },
      },
      newest: {
        key: "newest",
        completedAt: "2026-10-20T00:00:00.000Z",
        result: {
          phase1: {
            findings: [
              `promotion candidate: "Refunds over 500 need a manager" corroborated across 2 sessions (${refunds.id})`,
              "stale fact (>90d): something else",
            ],
          },
        },
      },
    },
  });
  writeJson(dir, join(".crewhaus", "run", "knowledge", "corpus.json"), {
    v: 1,
    at: "2026-10-31T00:00:00.000Z",
    spec: "bot",
    embedderModel: "mock/det",
    vectorBackend: "in-memory",
    sources: [
      {
        label: "docs/billing.md",
        kind: "path",
        status: "included",
        docs: [{ source: "a1b2c3d4e5f6", parts: 12, contentHash16: "0123456789abcdef" }],
      },
      { label: "docs/gone.md", kind: "path", status: "failed", reason: "not-found", docs: [] },
    ],
  });
  for (const version of ["v2", "v10"]) {
    writeJson(dir, join(".crewhaus", "datasets", "golden", `${version}.json`), {
      name: "golden",
      version,
      splits: { train: [{ id: "a", input: marker("sample") }], dev: [] },
      sampleHashes: {},
      createdAt: "2026-10-02T00:00:00.000Z",
    });
  }
  write(dir, join("eval", "graders.yaml"), GRADERS);
  const work = openWorkStore(dir, { now: () => NOW.getTime() });
  const item = await work.create(
    { title: `Fix the ${marker("worktitle")} import`, kind: "fix", goal: "Dates parse." },
    { by: mintId("prn"), via: "home", role: "person" },
  );
  if (!item.ok) throw new Error(item.message);
  return {
    refunds: refunds.id,
    wrong: wrong.id,
    right: right.id,
    old: old.id,
    loose: loose.id,
    passing: passing.id,
    plan: plan.id,
    trash: ts,
    work: item.item.id,
  };
}

export function lessonId(text: string): string {
  const key = text.toLowerCase().replace(/\s+/g, " ").trim();
  return `l${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** A customer's stores, inside the harness. */
export async function seedTenant(dir: string, tenant = "acme"): Promise<string> {
  const base = join(".crewhaus", "tenants", tenant);
  const fact = await memories(dir, "bot", base).remember(`${marker("tenant")} pays by invoice`);
  await wiki(dir, "bot", base).write({
    slug: "account",
    title: `Account of ${marker("tenant")}`,
    body: `${marker("tenant")} renews in May`,
  });
  await state(dir, { base }).writeFocus(`${marker("tenant")} focus`);
  return fact.id;
}

/** Every file under `dir`, by path: name, size, time, mode and bytes. */
export function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const stats = lstatSync(full);
      const text = entry.isFile() ? readFileSync(full, "utf8") : "";
      out.set(full, `${stats.size} ${stats.mtimeMs} ${stats.mode} ${text}`);
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(dir);
  return out;
}

/** The files under `dir` that hold `text`, relative to it. */
export function holding(dir: string, text: string): string[] {
  const out: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && (full.includes(text) || readFileSync(full).includes(text))) {
        out.push(
          full
            .slice(dir.length + 1)
            .split("\\")
            .join("/"),
        );
      }
    }
  };
  visit(dir);
  return out.sort();
}

/** An item as a golden row: what it is, with ids replaced by the names given. */
export function row(
  item: Omit<KnowledgeItem, "freshness" | "usage">,
  names: Readonly<Record<string, string>> = {},
): string {
  let id = item.id;
  for (const [name, value] of Object.entries(names)) id = id.split(value).join(`<${name}>`);
  const parts = [
    id,
    item.lifecycle,
    item.status ?? "-",
    item.scope.kind,
    item.author.kind,
    item.origin.kind,
    item.evidence.status,
    item.title,
  ];
  return parts.join(" | ");
}
