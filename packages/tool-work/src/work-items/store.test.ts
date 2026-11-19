import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORK_LOG_KEYS, mintId, mintRunId } from "@crewhaus/control-contract";
import { append, runsLedger } from "@crewhaus/control-records";
import { ACCEPT_RULE, WORK_ACTOR_RULES } from "./actors";
import { foldWork, readWorkLines } from "./fold";
import { type WorkActor, revisionRelOf, workDirOf, workLedger } from "./records";
import { type WorkInput, type WorkRefusal, type WorkWrite, openWorkStore } from "./store";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function harness(): string {
  const dir = mkdtempSync(join(tmpdir(), "tool-work-store-"));
  dirs.push(dir);
  return dir;
}

const PERSON: WorkActor = { by: mintId("prn"), via: "home", role: "person" };
const SERVICE: WorkActor = { by: mintId("prn"), via: "sdk", role: "service" };
const RUN = mintRunId();
const HARNESS: WorkActor = { by: "sys:runtime", via: "tool", role: "harness", run: RUN };

const FIX: WorkInput = { title: "Fix the CSV import", kind: "fix", goal: "Dates parse." };
const OBSERVED = {
  problem: "Imports fail on ISO dates.",
  evidence: [
    { label: "observed", kind: "observed-usage", ref: "run:abc", note: "Three runs failed." },
  ],
  counterEvidence: [],
};
const HYPOTHESIS = {
  problem: "People might want CSV export.",
  evidence: [{ label: "hypothesis", kind: "simulated", note: "A simulated user liked it." }],
  counterEvidence: [],
  doNothing: "People keep copying rows by hand.",
};

function ok(write: WorkWrite): Extract<WorkWrite, { ok: true }> {
  if (!write.ok) throw new Error(`${write.code}: ${write.message}`);
  return write;
}

function refused(write: WorkWrite | WorkRefusal): WorkRefusal {
  if (write.ok) throw new Error("expected a refusal");
  return write;
}

/** Every file under a directory, with a digest of its bytes. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else
        out[path.slice(root.length)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  walk(root);
  return out;
}

describe("the lifecycle", () => {
  test("every legal row applies, and a person's create opens the item", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const opened = ok(await store.create(FIX, PERSON));
    expect(opened.item.state).toBe("open");
    expect(opened.item.sourceKind).toBe("operator");
    const proposed = ok(
      await store.propose(
        { ...FIX, title: "Another", basis: "user-pain", assessment: OBSERVED },
        HARNESS,
      ),
    );
    expect(proposed.item.state).toBe("proposed");
    const wi = proposed.item.id;
    expect(ok(await store.transition(wi, "open", {}, PERSON)).item.state).toBe("open");
    expect(ok(await store.link(wi, RUN, HARNESS)).item.runs).toEqual([RUN]);
    const closed = ok(
      await store.transition(wi, "closed", { outcome: "done", reasonCode: "fixed" }, HARNESS),
    );
    expect(closed.item.state).toBe("closed");
    expect(closed.item.outcome).toBe("done");
    expect(ok(await store.transition(wi, "open", {}, PERSON)).item.state).toBe("open");
    expect(
      ok(await store.transition(wi, "closed", { outcome: "cancelled" }, SERVICE)).item.outcome,
    ).toBe("cancelled");
    const other = ok(
      await store.propose(
        { ...FIX, title: "Third", basis: "user-pain", assessment: OBSERVED },
        HARNESS,
      ),
    );
    const declined = ok(
      await store.transition(
        other.item.id,
        "closed",
        { reasonCode: "duplicate", supersededBy: wi },
        PERSON,
      ),
    );
    expect(declined.item.outcome).toBe("superseded");
    expect(declined.item.supersededBy).toBe(wi);
    const fold = foldWork(dir);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.anomalies).toBe(0);
  });

  test("an illegal line written raw is kept, skipped by the fold, and counted", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(await store.create(FIX, PERSON)).item.id;
    // open → proposed is no move the machine has.
    const raw = {
      v: 1,
      at: new Date().toISOString(),
      id: wi,
      state: "proposed",
      event: "updated",
      by: "sys:runtime",
      via: "system",
    };
    expect(append(workLedger(dir), raw).ok).toBe(true);
    // A line for an item never opened.
    expect(
      append(workLedger(dir), { ...raw, id: mintId("wi"), state: "open", event: "accepted" }).ok,
    ).toBe(true);
    const fold = foldWork(dir);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.anomalies).toBe(2);
    expect(fold.items.get(wi)?.state).toBe("open");
    expect(readWorkLines(dir).lines).toHaveLength(3);
  });

  test("updated, linked, ranked and delivered lines leave the state as it was, with no anomaly", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const a = ok(await store.create(FIX, PERSON)).item.id;
    const b = ok(await store.create({ ...FIX, title: "Second" }, PERSON)).item.id;
    ok(await store.update(a, { expect: 1, note: "Seen again today." }, PERSON));
    ok(await store.link(a, RUN, HARNESS));
    ok(await store.rank(b, { below: a, scope: "item" }, PERSON));
    ok(await store.deliver(a, { kind: "report", ref: "reports/csv.md" }, HARNESS));
    const fold = foldWork(dir);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.anomalies).toBe(0);
    expect(fold.items.get(a)?.history.map((line) => line.event)).toEqual([
      "opened",
      "updated",
      "linked",
      "delivered",
    ]);
    expect(fold.corrections).toHaveLength(1);
  });

  test("illegal moves are refused with the current state, before anything is written", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(await store.create(FIX, PERSON)).item.id;
    const before = tree(dir);
    const accept = refused(await store.transition(wi, "open", {}, PERSON));
    expect(accept.code).toBe("conflict");
    expect(accept.current).toBe("open");
    expect(tree(dir)).toEqual(before);
    ok(await store.transition(wi, "closed", { outcome: "done" }, PERSON));
    const closed = tree(dir);
    const again = refused(await store.transition(wi, "closed", { outcome: "done" }, PERSON));
    expect(again).toMatchObject({ code: "conflict", reason: "already_closed", current: "closed" });
    expect(refused(await store.link(wi, RUN, PERSON)).code).toBe("conflict");
    expect(tree(dir)).toEqual(closed);
  });
});

describe("content revisions", () => {
  test("a stale expect is refused naming the current revision; revisions are never rewritten", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(await store.create(FIX, PERSON)).item.id;
    const first = join(dir, revisionRelOf(dir, wi, 1));
    const stat1 = statSync(first);
    const bytes1 = readFileSync(first);
    expect(stat1.mode & 0o777).toBe(0o600);
    ok(await store.update(wi, { expect: 1, goal: "Dates and times parse." }, PERSON));
    const stale = refused(await store.update(wi, { expect: 1, title: "Nope" }, PERSON));
    expect(stale).toMatchObject({ code: "precondition_failed", current: 2 });
    ok(await store.update(wi, { expect: 2, title: "Fix CSV dates" }, PERSON));
    const stat2 = statSync(first);
    expect(stat2.ino).toBe(stat1.ino);
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
    expect(readFileSync(first).equals(bytes1)).toBe(true);
    expect(store.revision(wi, 1)?.goal).toBe("Dates parse.");
    expect(store.revision(wi, 3)?.title).toBe("Fix CSV dates");
    expect(store.revision(wi, 3)?.goal).toBe("Dates and times parse.");
  });

  test("a revision file no line names (a writer that stopped before its line) never blocks the item", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(await store.create(FIX, PERSON)).item.id;
    // Revision 2 on disk, but no log line names it.
    const orphan = join(dir, revisionRelOf(dir, wi, 2));
    writeFileSync(orphan, `${JSON.stringify({ v: 1, wi, rev: 2, title: "Left behind" })}\n`, {
      mode: 0o600,
    });
    const noted = ok(await store.update(wi, { expect: 1, note: "Seen again today." }, PERSON));
    expect(noted.item.rev).toBe(2);
    expect(store.revision(wi, 2)?.title).toBe(FIX.title);
    // And again for a delivery, whose revision is above the folded one.
    const next = join(dir, revisionRelOf(dir, wi, 3));
    writeFileSync(next, `${JSON.stringify({ v: 1, wi, rev: 3, title: "Left behind" })}\n`, {
      mode: 0o600,
    });
    const delivered = ok(
      await store.deliver(wi, { kind: "report", ref: "reports/csv.md" }, HARNESS),
    );
    expect(delivered.item.rev).toBe(3);
    expect(store.revision(wi, 3)?.title).toBe(FIX.title);
    expect(statSync(next).mode & 0o777).toBe(0o600);
  });

  test("each field keeps the origin it was written through", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(
      await store.propose(
        {
          ...FIX,
          basis: "compatibility-security",
          assessment: {
            problem: "A dependency changed.",
            evidence: [
              { label: "reported", kind: "advisory", ref: "GHSA-x", note: "An advisory." },
            ],
            counterEvidence: [],
          },
        },
        HARNESS,
      ),
    ).item.id;
    ok(await store.update(wi, { expect: 1, goal: "Pin the parser." }, PERSON));
    const revision = store.revision(wi, 2);
    expect(revision?.fieldOrigins).toMatchObject({
      title: "memory",
      goal: "api",
      assessment: "memory",
    });
  });

  test("no title, goal or reference text enters the log, and every key is in the closed set", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(
      await store.propose(
        {
          title: "TITLE-CANARY",
          goal: "GOAL-CANARY",
          kind: "fix",
          basis: "user-pain",
          assessment: OBSERVED,
          source: {
            kind: "github-issue",
            ref: "acme/app#7",
            url: "https://example.test/URL-CANARY",
          },
        },
        HARNESS,
      ),
    ).item.id;
    ok(await store.update(wi, { expect: 1, note: "NOTE-CANARY" }, HARNESS));
    ok(await store.deliver(wi, { kind: "report", ref: "REF-CANARY" }, HARNESS));
    const log = readdirSync(join(dir, workDirOf(dir)))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFileSync(join(dir, workDirOf(dir), name), "utf8"))
      .join("");
    for (const canary of [
      "TITLE-CANARY",
      "GOAL-CANARY",
      "URL-CANARY",
      "NOTE-CANARY",
      "REF-CANARY",
      "acme/app#7",
    ]) {
      expect(log.includes(canary)).toBe(false);
    }
    for (const line of readWorkLines(dir).lines) {
      for (const key of Object.keys(line))
        expect(WORK_LOG_KEYS as readonly string[]).toContain(key);
    }
  });
});

describe("source claims", () => {
  test("two concurrent proposals of one source make one item, and the loser leaves nothing", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const input: WorkInput = {
      ...FIX,
      basis: "user-pain",
      assessment: OBSERVED,
      source: { kind: "github-issue", ref: "acme/app#41" },
    };
    const [a, b] = await Promise.all([
      store.propose(input, HARNESS),
      store.propose(input, HARNESS),
    ]);
    expect(ok(a).item.id).toBe(ok(b).item.id);
    const opened = readWorkLines(dir).lines.filter((line) => line["event"] === "opened");
    expect(opened).toHaveLength(1);
    expect(String(opened[0]?.["claim"])).toMatch(/^work-source\/[0-9a-f]{64}$/);
    expect(readdirSync(join(dir, workDirOf(dir), "items"))).toEqual([ok(a).item.id]);
  });

  test("a repeat writes nothing at all, claims included", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    let reads = 0;
    const read = async () => {
      reads += 1;
      return { title: "Triage the March reports", origin: "mcp" as const };
    };
    const first = ok(await store.adopt({ kind: "thredz-task", ref: "t_1" }, read, PERSON));
    expect(first.wrote).toBe(true);
    expect(first.item.state).toBe("open");
    expect(store.revision(first.item.id, 1)?.fieldOrigins.title).toBe("mcp");
    const before = tree(join(dir, ".crewhaus"));
    const again = ok(await store.adopt({ kind: "thredz-task", ref: "t_1" }, read, PERSON));
    expect(again).toMatchObject({ wrote: false, item: { id: first.item.id } });
    expect(tree(join(dir, ".crewhaus"))).toEqual(before);
    expect(reads).toBe(1);
  });
});

describe("who may do what", () => {
  test("the rules, as a table", () => {
    expect(WORK_ACTOR_RULES.accept).toEqual(["person", "system"]);
    expect(WORK_ACTOR_RULES.decline).toEqual(["person"]);
    // The system reopens only under the pull request tracker's rule.
    expect(WORK_ACTOR_RULES.reopen).toEqual(["person", "system"]);
    expect(WORK_ACTOR_RULES.cancel).not.toContain("harness");
    expect(WORK_ACTOR_RULES.rank).toEqual(["person"]);
    expect(WORK_ACTOR_RULES.open).not.toContain("harness");
  });

  test("the harness cannot accept, decline, cancel, edit an accepted item or claim a person's source", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const own = ok(
      await store.propose({ ...FIX, basis: "user-pain", assessment: OBSERVED }, HARNESS),
    ).item.id;
    expect(refused(await store.transition(own, "open", {}, HARNESS)).reason).toBe(
      "actor_not_allowed",
    );
    expect(
      refused(await store.transition(own, "closed", { reasonCode: "not-now" }, HARNESS)).reason,
    ).toBe("actor_not_allowed");
    const accepted = ok(await store.create(FIX, PERSON)).item.id;
    expect(
      refused(await store.transition(accepted, "closed", { outcome: "cancelled" }, HARNESS)).reason,
    ).toBe("actor_not_allowed");
    expect(
      refused(await store.update(accepted, { expect: 1, goal: "Rewritten." }, HARNESS)).reason,
    ).toBe("not_its_proposal");
    // An item a person proposed is not the harness's to edit either.
    const theirs = ok(
      await store.propose({ ...FIX, basis: "user-pain", assessment: OBSERVED }, PERSON),
    ).item.id;
    expect(
      refused(await store.update(theirs, { expect: 1, title: "Mine now" }, HARNESS)).reason,
    ).toBe("not_its_proposal");
    for (const kind of ["operator", "api"] as const) {
      const claimed = refused(
        await store.propose(
          { ...FIX, basis: "user-pain", assessment: OBSERVED, source: { kind } },
          HARNESS,
        ),
      );
      expect(claimed).toMatchObject({ code: "forbidden", reason: "source_not_allowed" });
    }
    expect(refused(await store.create(FIX, HARNESS)).reason).toBe("actor_not_allowed");
    expect(refused(await store.rank(own, { below: accepted, scope: "item" }, HARNESS)).reason).toBe(
      "actor_not_allowed",
    );
    // What it may do: a note on an accepted item, edit its own proposal, close with a reason.
    ok(await store.update(accepted, { expect: 1, note: "Started on it." }, HARNESS));
    ok(await store.update(own, { expect: 1, title: "Fix the CSV import of dates" }, HARNESS));
    const noReason = refused(
      await store.transition(accepted, "closed", { outcome: "done" }, HARNESS),
    );
    expect(noReason.reason).toBe("reason_required");
    ok(
      await store.transition(accepted, "closed", { outcome: "done", reasonCode: "fixed" }, HARNESS),
    );
  });

  test("a service principal cannot accept, decline or rank; the runtime accepts only under a rule", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(
      await store.propose({ ...FIX, basis: "user-pain", assessment: OBSERVED }, HARNESS),
    ).item.id;
    expect(refused(await store.transition(wi, "open", {}, SERVICE)).reason).toBe(
      "actor_not_allowed",
    );
    const system: WorkActor = { by: "sys:runtime", via: "system", role: "system" };
    expect(refused(await store.transition(wi, "open", {}, system)).reason).toBe("rule_required");
    const accepted = ok(await store.transition(wi, "open", {}, system, ACCEPT_RULE));
    expect(accepted.item.history.at(-1)?.rule).toBe(ACCEPT_RULE);
  });
});

/** Record a run of this harness in its runs ledger, so evidence can name it. */
function recordRun(dir: string): string {
  const run = mintRunId();
  const written = append(runsLedger(dir), {
    id: run,
    state: "running",
    at: new Date().toISOString(),
    trigger: { kind: "cli" },
    session: "sess_0000000000000001",
  });
  if (!written.ok) throw new Error("the run row could not be written");
  return run;
}

/** Observed evidence naming a run this harness's runs ledger holds. */
function observedIn(dir: string) {
  return {
    ...OBSERVED,
    evidence: [{ ...OBSERVED.evidence[0], ref: recordRun(dir) }],
  };
}

describe("the owner's accept policy", () => {
  test("a listed kind is accepted by the runtime with the rule; an unlisted one is not", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const policy = { accept: ["fix" as const] };
    const fix = ok(
      await store.propose({ ...FIX, basis: "user-pain", assessment: OBSERVED }, HARNESS, {
        policy,
      }),
    );
    expect(fix.item.state).toBe("open");
    const last = fix.item.history.at(-1);
    expect(last).toMatchObject({ event: "accepted", by: "sys:runtime", rule: ACCEPT_RULE });
    const feature = ok(
      await store.propose(
        {
          title: "CSV export",
          kind: "feature",
          basis: "user-pain",
          assessment: { ...OBSERVED, doNothing: "Manual copies." },
        },
        HARNESS,
        { policy },
      ),
    );
    expect(feature.item.state).toBe("proposed");
  });

  test("a speculative feature stays proposed without observed evidence, and is accepted with it", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const policy = { accept: ["feature" as const] };
    const guess = ok(
      await store.propose(
        { title: "CSV export", kind: "feature", basis: "speculative", assessment: HYPOTHESIS },
        HARNESS,
        {
          policy,
        },
      ),
    );
    expect(guess.item.state).toBe("proposed");
    const seen = ok(
      await store.propose(
        {
          title: "Excel export",
          kind: "feature",
          basis: "speculative",
          assessment: {
            ...HYPOTHESIS,
            evidence: [...HYPOTHESIS.evidence, ...observedIn(dir).evidence],
          },
        },
        HARNESS,
        { policy },
      ),
    );
    expect(seen.item.state).toBe("open");
  });
});

describe("the owner's accept policy, by basis", () => {
  test("a speculative proposal of any listed kind stays proposed without observed evidence", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const policy = { accept: ["fix" as const] };
    const guess = ok(
      await store.propose(
        { title: "Add a brand new billing dashboard", kind: "fix", basis: "speculative" },
        HARNESS,
        { policy },
      ),
    );
    expect(guess.item.state).toBe("proposed");
    expect(guess.item.history.map((line) => line.event)).toEqual(["opened"]);
    const seen = ok(
      await store.propose(
        {
          title: "Fix the CSV import",
          kind: "fix",
          basis: "speculative",
          assessment: observedIn(dir),
        },
        HARNESS,
        { policy },
      ),
    );
    expect(seen.item.state).toBe("open");
  });
});

describe("inputs", () => {
  test("a proposal is refused naming the field the assessment rules fault", async () => {
    const store = openWorkStore(harness());
    const noDoNothing = refused(
      await store.propose(
        { title: "Export", kind: "feature", basis: "speculative", assessment: OBSERVED },
        HARNESS,
      ),
    );
    expect(noDoNothing).toMatchObject({
      reason: "assessment_invalid",
      field: "assessment.doNothing",
    });
    const noBasis = refused(await store.propose({ ...FIX, assessment: OBSERVED }, HARNESS));
    expect(noBasis).toMatchObject({ reason: "assessment_invalid", field: "basis" });
    const longTitle = refused(await store.create({ ...FIX, title: "x".repeat(201) }, PERSON));
    expect(longTitle.field).toBe("title");
    const rawActor = refused(await store.create(FIX, { ...PERSON, by: "local:sam@laptop" }));
    expect(rawActor.reason).toBe("invalid_actor");
  });

  test("reads write nothing and create no key", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    expect(store.list().items).toEqual([]);
    expect(refused(store.get(mintId("wi")) as WorkRefusal).code).toBe("not_found");
    expect(existsSync(join(dir, ".crewhaus"))).toBe(false);
    writeFileSync(join(dir, "marker"), "x");
  });
});
