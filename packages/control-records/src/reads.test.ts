/** Every reader leaves what it read byte-identical and creates no path. */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createApproverReader } from "./approvers";
import { resume, snapshotAt } from "./cursor";
import { ensureDigestKey, readDigestKey } from "./digest";
import { intakeVerdict } from "./intake";
import { acquireMutatingLease, readMutatingLease } from "./lease";
import { append, appendClaim, foldStates, readClaim } from "./ledger";
import { createOperatorReader } from "./operator";
import { dropSegmentsBefore } from "./retention";
import { assertRunnable } from "./runnable";
import { _setRollBytesForTest } from "./segments";
import { readPage, readTail } from "./tail";
import {
  controlFile,
  deploymentsLedger,
  jsonLine,
  plant,
  removeTempDirs,
  runsLedger,
  snapshotTree,
  tempDir,
} from "./test-helpers";

afterEach(() => _setRollBytesForTest(undefined));
afterAll(removeTempDirs);

const CAPS = { maxLines: 10, maxBytes: 4096 };

async function everyReader(root: string): Promise<void> {
  const runs = runsLedger(root);
  const deployments = deploymentsLedger(root);
  readTail(root, ".crewhaus/run/control/runs/000002.jsonl", CAPS);
  readTail(root, ".crewhaus/run/control/deployments.jsonl", CAPS);
  readPage(runs, { limit: 2 });
  readPage(deployments, { limit: 2 });
  readClaim(runs, "idem/one");
  readClaim(runs, "idem/none");
  snapshotAt({ runs, deployments });
  const answer = resume({ runs, deployments }, undefined, CAPS);
  resume({ runs, deployments }, answer.next, CAPS);
  resume({ runs }, { runs: [{ seg: 1, off: 10, tail: "00000000" }] }, CAPS);
  createOperatorReader()(root);
  createApproverReader()(root);
  intakeVerdict(root, { read: createOperatorReader() });
  await readDigestKey(root);
  readMutatingLease(root);
  for (const mode of ["interactive", "run", "start"] as const) {
    assertRunnable(root, { mode, read: createOperatorReader() });
  }
  foldStates(runs);
  foldStates(deployments);
}

describe("reads never mutate", () => {
  test("a full harness: bytes identical, no new path", async () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const runs = runsLedger(root);
    for (const n of [1, 2, 3]) append(runs, { n });
    await appendClaim(runs, { claim: "idem/one", record: { n: 4 } });
    await dropSegmentsBefore(runs, 2);
    append(deploymentsLedger(root), { id: "d", state: "prepared" });
    // A torn line and garbage: a reader must not seal or repair either.
    plant(controlFile(root, "runs/000005.jsonl"), `garbage\n${jsonLine({ n: 5 })}{"n":6`);
    plant(
      controlFile(root, "operator.json"),
      jsonLine({ v: 1, rev: 1, desired: "running", intake: { paused: true } }),
    );
    plant(controlFile(root, "approvers.json"), "not a projection\n");
    await ensureDigestKey(root);
    await acquireMutatingLease(root, { head: "cli", kind: "eval" }, { waitMs: 0 });

    const before = snapshotTree(root);
    expect(before.size).toBeGreaterThan(10);
    await everyReader(root);
    expect(snapshotTree(root)).toEqual(before);
  });

  test("a claim with no line is not repaired by a read", async () => {
    const root = tempDir();
    const runs = runsLedger(root);
    plant(
      controlFile(root, "claims/idem/one.json"),
      jsonLine({ v: 1, claim: "idem/one", at: "t", seg: 1, record: { n: 1 } }),
    );
    const before = snapshotTree(root);
    expect(readClaim(runs, "idem/one").ok).toBe(true);
    expect(foldStates(runs)).toMatchObject({ ok: true, records: 0 });
    expect(snapshotTree(root)).toEqual(before);
  });

  test("a harness with no control directory: nothing appears", async () => {
    const root = tempDir();
    plant(`${root}/crewhaus.yaml`, "name: x\n");
    const before = snapshotTree(root);
    await everyReader(root);
    expect(snapshotTree(root)).toEqual(before);
  });

  test("a root that does not exist reads as absent, and is not created", async () => {
    const root = `${tempDir()}/missing`;
    expect(readTail(root, "log", CAPS)).toEqual({ state: "absent" });
    expect(readPage(runsLedger(root), { limit: 1 }).gaps).toEqual([]);
    expect(createOperatorReader()(root)).toEqual({ state: "absent" });
    expect(snapshotAt({ runs: runsLedger(root) })).toEqual({
      runs: [{ seg: 1, off: 0, tail: "" }],
    });
    expect(append(runsLedger(root), { n: 1 })).toMatchObject({ ok: false, code: "not-found" });
    expect(snapshotTree(`${root}/..`).size).toBe(0);
  });
});
