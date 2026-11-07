/**
 * A link planted at a record's name: every write refused with its reason, every read
 * unreadable with its reason, and nothing appears outside. Dangling and existing targets
 * both, because a create through a dangling link makes the file it points at.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApproverReader } from "./approvers";
import { resume } from "./cursor";
import { ensureDigestKey, readDigestKey } from "./digest";
import { intakeVerdict } from "./intake";
import { acquireMutatingLease, readMutatingLease } from "./lease";
import {
  append,
  appendClaim,
  casAppend,
  foldStates,
  publishClaim,
  readClaim,
  withLedgerLock,
} from "./ledger";
import { createOperatorReader } from "./operator";
import { controlPaths } from "./paths";
import { readPage, readTail } from "./tail";
import {
  controlFile,
  jsonLine,
  plant,
  removeTempDirs,
  runsLedger,
  segmentPath,
  snapshotTree,
  tempDir,
} from "./test-helpers";

afterAll(removeTempDirs);

const CAPS = { maxLines: 10, maxBytes: 4096 };

type Planted = {
  readonly root: string;
  readonly outside: string;
  readonly before: ReadonlyMap<string, string>;
  /** Nothing appeared or changed outside the root. */
  readonly nothingEscaped: () => void;
};

/** A link at the path `make` names (inside the root) to a path outside, whose target exists or not. */
function plantLink(
  make: (root: string) => string,
  target: "dangling" | "existing",
  dir = false,
): Planted {
  const root = tempDir();
  const outside = tempDir();
  const link = make(root);
  mkdirSync(dirname(link), { recursive: true });
  const to = join(outside, target === "existing" ? "there" : "not-there");
  if (target === "existing") {
    if (dir) mkdirSync(to);
    else plant(to, "outside bytes\n");
  }
  symlinkSync(to, link, dir ? "dir" : "file");
  const before = snapshotTree(outside);
  return {
    root,
    outside,
    before,
    nothingEscaped: () => expect(snapshotTree(outside)).toEqual(before),
  };
}

const refusedAsLink = expect.objectContaining({ ok: false, code: "is-symlink" });
const refusedOutside = expect.objectContaining({ ok: false, code: "escapes-root" });

for (const target of ["dangling", "existing"] as const) {
  describe(`a ${target} link`, () => {
    test("at a segment: appends refused, reads refused", async () => {
      const at = plantLink((root) => segmentPath(runsLedger(root), 1), target);
      const ledger = runsLedger(at.root);
      expect(append(ledger, { n: 1 })).toEqual(refusedAsLink);
      expect(await withLedgerLock(ledger, (locked) => locked({ n: 1 }))).toEqual(refusedAsLink);
      const rel = join(ledger.records.dir as string, "000001.jsonl");
      expect(readTail(at.root, rel, CAPS)).toMatchObject({ state: "refused", code: "is-symlink" });
      expect(readPage(ledger, { limit: 5 }).gaps[0]).toMatchObject({
        seg: 1,
        reason: "unreadable",
      });
      const answer = resume({ runs: ledger }, undefined, CAPS);
      expect(answer.items[0]).toMatchObject({ kind: "gap", reason: "unreadable" });
      expect(foldStates(ledger)).toEqual(refusedAsLink);
      at.nothingEscaped();
    });

    test("at a claim: publish refused, read refused", () => {
      const at = plantLink(
        (root) => join(root, runsLedger(root).claims, "idem", "one.json"),
        target,
      );
      const ledger = runsLedger(at.root);
      expect(publishClaim(ledger, "idem/one", { n: 1 })).toEqual(refusedAsLink);
      expect(readClaim(ledger, "idem/one")).toEqual(refusedAsLink);
      at.nothingEscaped();
    });

    test("at a claim: appendClaim answers the refusal, it does not win", async () => {
      const at = plantLink(
        (root) => join(root, runsLedger(root).claims, "idem", "one.json"),
        target,
      );
      expect(
        await appendClaim(runsLedger(at.root), { claim: "idem/one", record: { n: 1 } }),
      ).toEqual(refusedAsLink);
      at.nothingEscaped();
    });

    test("at the lock: the lock's own refusal, message intact", async () => {
      const at = plantLink((root) => controlFile(root, "lock"), target);
      const ledger = runsLedger(at.root);
      await expect(appendClaim(ledger, { claim: "idem/one", record: { n: 1 } })).rejects.toThrow(
        /not a lock file/,
      );
      await expect(casAppend(ledger, "x", null, { state: "a" })).rejects.toThrow(/not a lock file/);
      at.nothingEscaped();
    });

    test("at the lease: taking it refused, reading it unreadable", async () => {
      const at = plantLink((root) => controlFile(root, "leases/mutating.json"), target);
      expect(
        await acquireMutatingLease(at.root, { head: "cli", kind: "eval" }, { waitMs: 0 }),
      ).toEqual(refusedAsLink);
      const lease = readMutatingLease(at.root);
      expect(lease.state === "unreadable" && lease.reason).toContain("symbolic link");
      at.nothingEscaped();
    });

    test("at the digest key: refused and never replaced", async () => {
      const at = plantLink((root) => controlFile(root, "keys/digest.key"), target);
      const read = await readDigestKey(at.root);
      expect(read.state === "unreadable" && read.reason).toContain("symbolic link");
      const ensured = await ensureDigestKey(at.root);
      expect(ensured.state === "unreadable" && ensured.reason).toContain("symbolic link");
      at.nothingEscaped();
    });

    test("at operator.json: unreadable, so intake closes", () => {
      const at = plantLink((root) => controlFile(root, "operator.json"), target);
      const read = createOperatorReader()(at.root);
      expect(read.state === "unreadable" && read.reason).toContain("symbolic link");
      expect(intakeVerdict(at.root, { read: createOperatorReader() })).toMatchObject({
        state: "closed",
        code: "paused",
      });
      at.nothingEscaped();
    });

    test("at approvers.json: unreadable", () => {
      const at = plantLink((root) => controlFile(root, "approvers.json"), target);
      const read = createApproverReader()(at.root);
      expect(read.state === "unreadable" && read.reason).toContain("symbolic link");
      at.nothingEscaped();
    });

    test("at the control directory itself: every write and every read refused", async () => {
      const at = plantLink((root) => join(root, controlPaths(root).controlDir), target, true);
      const { root } = at;
      const ledger = runsLedger(root);
      expect(append(ledger, { n: 1 })).toEqual(refusedOutside);
      expect(await appendClaim(ledger, { claim: "idem/one", record: { n: 1 } })).toEqual(
        refusedOutside,
      );
      expect(await casAppend(ledger, "x", null, { state: "a" })).toEqual(refusedOutside);
      expect(publishClaim(ledger, "idem/one", { n: 1 })).toEqual(refusedOutside);
      expect(
        await acquireMutatingLease(root, { head: "cli", kind: "eval" }, { waitMs: 0 }),
      ).toEqual(refusedOutside);
      expect((await ensureDigestKey(root)).state).toBe("unreadable");

      expect(readClaim(ledger, "idem/one")).toEqual(refusedOutside);
      const outsideReason = "resolves outside";
      const lease = readMutatingLease(root);
      expect(lease.state === "unreadable" && lease.reason).toContain(outsideReason);
      const key = await readDigestKey(root);
      expect(key.state === "unreadable" && key.reason).toContain(outsideReason);
      const operator = createOperatorReader()(root);
      expect(operator.state === "unreadable" && operator.reason).toContain(outsideReason);
      const approvers = createApproverReader()(root);
      expect(approvers.state === "unreadable" && approvers.reason).toContain(outsideReason);
      expect(foldStates(ledger)).toEqual(refusedOutside);
      expect(readPage(ledger, { limit: 5 }).gaps[0]).toMatchObject({ reason: "unreadable" });
      expect(resume({ runs: ledger }, undefined, CAPS).items[0]).toMatchObject({
        kind: "gap",
        reason: "unreadable",
      });
      at.nothingEscaped();
    });
  });
}

describe("a hard link and a contained link", () => {
  test("a hard-linked segment is refused for append", () => {
    const root = tempDir();
    const outside = tempDir();
    const ledger = runsLedger(root);
    const other = join(outside, "other");
    plant(other, jsonLine({ n: 0 }));
    mkdirSync(dirname(segmentPath(ledger, 1)), { recursive: true });
    linkSync(other, segmentPath(ledger, 1));
    const answer = append(ledger, { n: 1 });
    expect(answer).toMatchObject({ ok: false, code: "escapes-root" });
    expect(!answer.ok && answer.reason).toContain("hard link");
    expect(readFileSync(other, "utf8")).toBe(jsonLine({ n: 0 }));
  });

  test("a resume keeps its place behind a refused segment, and carries on once it clears", () => {
    const root = tempDir();
    const outside = tempDir();
    const ledger = runsLedger(root);
    append(ledger, { n: 1 });
    const { next } = resume({ runs: ledger }, undefined, CAPS);
    append(ledger, { n: 2 });
    const bytes = readFileSync(segmentPath(ledger, 1));
    plant(join(outside, "x"), "x\n");
    const path = segmentPath(ledger, 1);
    // The real file moves aside and a link takes its name.
    rmSync(path);
    symlinkSync(join(outside, "x"), path);
    const refused = resume({ runs: ledger }, next, CAPS);
    expect(refused.items[0]).toMatchObject({ kind: "gap", reason: "unreadable" });
    expect(refused.next).toEqual(next);
    rmSync(path);
    writeFileSync(path, bytes);
    const again = resume({ runs: ledger }, refused.next, CAPS);
    expect(again.items).toMatchObject([{ kind: "line", record: { n: 2 } }]);
  });
});
