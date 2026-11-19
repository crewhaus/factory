import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintId, mintRunId } from "@crewhaus/control-contract";
import { append, runsLedger } from "@crewhaus/control-records";
import { ACCEPT_RULE, OUTCOME_RULE } from "./actors";
import { readWorkLines } from "./fold";
import { REVISION_MAX_BYTES, type WorkActor, itemDirOf } from "./records";
import {
  APPEND_MAX_BYTES,
  DELIVERED_MAX,
  NOTES_MAX,
  type WorkRefusal,
  type WorkWrite,
  openWorkStore,
} from "./store";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function harness(): string {
  const dir = mkdtempSync(join(tmpdir(), "tool-work-limits-"));
  dirs.push(dir);
  return dir;
}

const PERSON: WorkActor = { by: mintId("prn"), via: "home", role: "person" };

function harnessActor(run = mintRunId()): WorkActor {
  return { by: "sys:runtime", via: "tool", role: "harness", run };
}

function ok(write: WorkWrite): Extract<WorkWrite, { ok: true }> {
  if (!write.ok) throw new Error(`${write.code}: ${write.message}`);
  return write;
}

function refused(write: WorkWrite | WorkRefusal): WorkRefusal {
  if (write.ok) throw new Error("expected a refusal");
  return write;
}

/** A control character: one character of text, six bytes once JSON writes it. */
const WIDE = "\u0001";

function revisionFiles(dir: string, wi: string): string[] {
  const at = join(dir, itemDirOf(dir, wi));
  return existsSync(at) ? readdirSync(at).sort() : [];
}

describe("an item's notes and deliveries are capped", () => {
  test(`the note after ${NOTES_MAX} is refused item_full, and the item stays readable and editable`, async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(await store.create({ title: "Fix the import", kind: "fix" }, PERSON)).item.id;
    const run = harnessActor();
    for (let i = 0; i < NOTES_MAX; i++) {
      ok(await store.apply(wi, { note: `Step ${i}.` }, run));
    }
    const full = refused(await store.apply(wi, { note: "One more." }, run));
    expect(full).toMatchObject({ code: "conflict", reason: "item_full" });
    const read = store.get(wi);
    if ("ok" in read) throw new Error(read.message);
    expect(read.revision?.notes?.length).toBe(NOTES_MAX);
    ok(await store.update(wi, { expect: read.item.rev, title: "Fix the CSV import" }, PERSON));
  }, 20_000); // a hundred locked writes, each folding the whole log

  test(`the delivery after ${DELIVERED_MAX} is refused item_full`, async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(await store.create({ title: "Reports", kind: "report" }, PERSON)).item.id;
    const run = harnessActor();
    for (let i = 0; i < DELIVERED_MAX; i++) {
      ok(await store.apply(wi, { deliver: { kind: "report", ref: `r/${i}.md` } }, run));
    }
    const full = refused(await store.deliver(wi, { kind: "report", ref: "r/x.md" }, run));
    expect(full).toMatchObject({ code: "conflict", reason: "item_full" });
  }, 20_000); // a hundred locked writes, each folding the whole log

  test("wide notes stop at the append budget, before the count, and a person's widest edit still fits", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(await store.create({ title: "Fix the import", kind: "fix" }, PERSON)).item.id;
    const run = harnessActor();
    let written = 0;
    for (;;) {
      const answer = await store.apply(wi, { note: WIDE.repeat(4096) }, run);
      if (!answer.ok) {
        expect(answer).toMatchObject({ code: "conflict", reason: "item_full" });
        break;
      }
      written += 1;
    }
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(NOTES_MAX);
    const before = store.get(wi);
    if ("ok" in before || before.revision === undefined) throw new Error("unreadable");
    expect(Buffer.byteLength(JSON.stringify(before.revision))).toBeLessThanOrEqual(
      APPEND_MAX_BYTES,
    );
    const edited = ok(
      await store.update(
        wi,
        {
          expect: before.item.rev,
          title: WIDE.repeat(200),
          goal: WIDE.repeat(8192),
          acceptance: Array.from({ length: 20 }, () => WIDE.repeat(500)),
        },
        PERSON,
      ),
    );
    const after = store.get(wi);
    if ("ok" in after) throw new Error(after.message);
    expect(after.revision?.rev).toBe(edited.item.rev);
    expect(after.revision?.notes?.length).toBe(written);
    expect(after.revision?.acceptance?.length).toBe(20);
  }, 20_000); // each wide note rewrites a revision of up to 400 KiB

  test("a revision past the file limit is refused before any file or line exists", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(
      await store.propose(
        { title: "An idea", kind: "fix", basis: "speculative" },
        { by: PERSON.by, via: "home", role: "person" },
      ),
    ).item.id;
    const lines = readWorkLines(dir).lines.length;
    const files = revisionFiles(dir, wi);
    const huge = {
      problem: "Too much to say.",
      evidence: Array.from({ length: 50 }, () => ({
        label: "hypothesis",
        kind: "inferred",
        note: WIDE.repeat(2048),
      })),
      counterEvidence: [],
    };
    const answer = refused(await store.update(wi, { expect: 1, assessment: huge }, PERSON));
    expect(answer).toMatchObject({ code: "invalid", reason: "item_full" });
    expect(answer.message).toContain(`${REVISION_MAX_BYTES / 1024} KiB`);
    expect(readWorkLines(dir).lines.length).toBe(lines);
    expect(revisionFiles(dir, wi)).toEqual(files);
  });
});

describe("apply: one write, every check first", () => {
  test("a close refused for supersededBy writes no line and no revision; the retry records one note", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(await store.create({ title: "Fix the import", kind: "fix" }, PERSON)).item.id;
    const other = ok(await store.create({ title: "Fix all imports", kind: "fix" }, PERSON)).item.id;
    const run = harnessActor();
    const lines = readWorkLines(dir).lines.length;
    const files = revisionFiles(dir, wi);
    const change = {
      link: { run: run.run as string, whileOpen: true },
      note: "Folded into the wider fix.",
      deliver: { kind: "report" as const, ref: "reports/import.md" },
    };
    const bad = refused(
      await store.apply(
        wi,
        {
          ...change,
          close: {
            outcome: "superseded",
            reasonCode: "merged-elsewhere",
            supersededBy: mintId("wi"),
          },
        },
        run,
      ),
    );
    expect(bad).toMatchObject({ code: "invalid", field: "supersededBy" });
    expect(readWorkLines(dir).lines.length).toBe(lines);
    expect(revisionFiles(dir, wi)).toEqual(files);
    const done = ok(
      await store.apply(
        wi,
        {
          ...change,
          close: { outcome: "superseded", reasonCode: "merged-elsewhere", supersededBy: other },
        },
        run,
      ),
    );
    expect(done.item.state).toBe("closed");
    expect(done.item.runs).toEqual([run.run as string]);
    const read = store.get(wi);
    if ("ok" in read) throw new Error(read.message);
    expect(read.revision?.notes?.map((n) => n.text)).toEqual(["Folded into the wider fix."]);
    expect(read.revision?.delivered?.map((d) => d.ref)).toEqual(["reports/import.md"]);
    // One revision for the note and the delivery; the lines in order.
    expect(revisionFiles(dir, wi)).toEqual(["1.json", "2.json"]);
    expect(done.item.history.slice(1).map((l) => l.event)).toEqual([
      "linked",
      "updated",
      "delivered",
      "closed",
    ]);
  });

  test("a close the harness may not make is refused before the note it carries", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(await store.create({ title: "Fix the import", kind: "fix" }, PERSON)).item.id;
    const run = harnessActor();
    const lines = readWorkLines(dir).lines.length;
    const answer = refused(
      await store.apply(wi, { note: "Giving up.", close: { outcome: "cancelled" } }, run),
    );
    expect(answer.reason).toBe("actor_not_allowed");
    expect(readWorkLines(dir).lines.length).toBe(lines);
  });

  test("a link while open is skipped on a closed item; an explicit link is refused there", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(await store.create({ title: "Fix the import", kind: "fix" }, PERSON)).item.id;
    ok(await store.transition(wi, "closed", { outcome: "done" }, PERSON));
    const run = harnessActor();
    const noted = ok(
      await store.apply(
        wi,
        { link: { run: run.run as string, whileOpen: true }, note: "Late." },
        run,
      ),
    );
    expect(noted.item.runs).toEqual([]);
    expect(refused(await store.apply(wi, { link: { run: run.run as string } }, run)).reason).toBe(
      "closed",
    );
  });
});

/** Record a run row; `fields` adds `continues`, `parent` or a session. */
function recordRun(dir: string, fields: Record<string, unknown> = {}, run = mintRunId()): string {
  const written = append(runsLedger(dir), {
    id: run,
    state: "running",
    at: new Date().toISOString(),
    trigger: { kind: "cli" },
    ...fields,
  });
  if (!written.ok) throw new Error("the run row could not be written");
  return run;
}

function observed(ref: string) {
  return {
    problem: "Exports fail.",
    evidence: [{ label: "observed", kind: "observed-usage", ref, note: "Seen failing." }],
    counterEvidence: [],
    doNothing: "People copy rows by hand.",
  };
}

const POLICY = { policy: { accept: ["feature" as const] } };

async function stateOf(dir: string, ref: string, actor: WorkActor): Promise<string> {
  const store = openWorkStore(dir);
  const written = ok(
    await store.propose(
      { title: `Export ${ref}`, kind: "feature", basis: "user-pain", assessment: observed(ref) },
      actor,
      POLICY,
    ),
  );
  return written.item.state;
}

describe("auto-accept counts only evidence this harness's records hold", () => {
  test("a label alone, the proposing run, the run it continues and another harness's run do not count", async () => {
    const dir = harness();
    const elsewhere = harness();
    const proposer = mintRunId();
    const earlier = recordRun(dir, { session: "sess_earlier" });
    const continued = recordRun(dir, { session: "sess_continued" });
    recordRun(dir, { session: "sess_mine", continues: continued }, proposer);
    const actor = harnessActor(proposer);
    expect(await stateOf(dir, "run:abc", actor)).toBe("proposed");
    expect(await stateOf(dir, proposer, actor)).toBe("proposed");
    expect(await stateOf(dir, `run:${proposer}`, actor)).toBe("proposed");
    expect(await stateOf(dir, continued, actor)).toBe("proposed");
    expect(await stateOf(dir, recordRun(elsewhere), actor)).toBe("proposed");
    expect(await stateOf(dir, "session:sess_mine", actor)).toBe("proposed");
    expect(await stateOf(dir, "session:sess_continued", actor)).toBe("proposed");
    // Another run of this harness counts, by either spelling.
    expect(await stateOf(dir, earlier, actor)).toBe("open");
    expect(await stateOf(dir, `run:${recordRun(dir)}`, actor)).toBe("open");
  });

  test("a session counts when its log is here and it is not the proposer's", async () => {
    const dir = harness();
    const proposer = recordRun(dir, { session: "sess_mine" });
    mkdirSync(join(dir, ".crewhaus", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".crewhaus", "sessions", "sess_other.jsonl"), "{}\n");
    writeFileSync(join(dir, ".crewhaus", "sessions", "sess_mine.jsonl"), "{}\n");
    const actor = harnessActor(proposer);
    expect(await stateOf(dir, "session:sess_missing", actor)).toBe("proposed");
    expect(await stateOf(dir, "session:sess_mine", actor)).toBe("proposed");
    expect(await stateOf(dir, "session:../../etc/passwd", actor)).toBe("proposed");
    expect(await stateOf(dir, "session:sess_other", actor)).toBe("open");
  });

  test("an item counts when a person adopted it from a Thredz task or an issue; the harness's own does not", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const adopted = ok(
      await store.adopt(
        { kind: "thredz-task", ref: "t_1" },
        async () => ({ title: "Exports fail", origin: "mcp" }),
        PERSON,
      ),
    ).item.id;
    const own = ok(
      await store.propose(
        {
          title: "Issue 7",
          kind: "fix",
          basis: "speculative",
          source: { kind: "github-issue", ref: "acme/app#7" },
        },
        harnessActor(),
      ),
    ).item.id;
    const actor = harnessActor();
    expect(await stateOf(dir, own, actor)).toBe("proposed");
    expect(await stateOf(dir, adopted, actor)).toBe("open");
  });

  test("the system accepts with the accept rule; it reopens only under the tracker's rule", async () => {
    const dir = harness();
    const store = openWorkStore(dir);
    const wi = ok(await store.create({ title: "Fix", kind: "fix" }, PERSON)).item.id;
    ok(await store.transition(wi, "closed", { outcome: "done" }, PERSON));
    const system: WorkActor = { by: "sys:outcomes", via: "system", role: "system" };
    expect(refused(await store.transition(wi, "open", {}, system)).reason).toBe("rule_required");
    expect(refused(await store.transition(wi, "open", {}, system, ACCEPT_RULE)).reason).toBe(
      "rule_required",
    );
    // A person closed it: the tracker's rule alone does not reopen it.
    expect(refused(await store.transition(wi, "open", {}, system, OUTCOME_RULE)).reason).toBe(
      "not_closed_by_outcome",
    );
  });
});
