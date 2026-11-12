import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deploymentsLedger,
  readDeployments,
  readHarnessIdentity,
  writeHarnessIdentity,
} from "./deployments";
import { casAppend } from "./ledger";
import { controlPaths } from "./paths";
import { jsonLine, plant, removeTempDirs, snapshotTree, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const DEP_A = "dep_01aaaaaaaaaaaaaaaaaaaaaaaa";
const DEP_B = "dep_01bbbbbbbbbbbbbbbbbbbbbbbb";
const HRN = "hrn_0123456789abcdef";

function prepared(id: string): Record<string, unknown> {
  return { id, state: "prepared", artifact: { digest: "sha256:x", specHash: "sha256:y" } };
}

describe("readDeployments", () => {
  test("absent when the ledger does not exist", () => {
    expect(readDeployments(tempDir())).toEqual({ state: "absent" });
  });

  test("unreadable when the ledger's place is a directory", () => {
    const root = tempDir();
    mkdirSync(join(root, controlPaths(root).deploymentsFile), { recursive: true });
    expect(readDeployments(root).state).toBe("unreadable");
  });

  test("present: the records whole, with the active one", async () => {
    const root = tempDir();
    const ledger = deploymentsLedger(root);
    await casAppend(ledger, DEP_A, null, prepared(DEP_A));
    await casAppend(ledger, DEP_A, "prepared", {
      ...prepared(DEP_A),
      state: "active",
      activatedAt: "2026-11-01T00:00:00.000Z",
    });
    const read = readDeployments(root);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.records).toHaveLength(1);
    expect(read.active?.["id"]).toBe(DEP_A);
    expect(read.active?.["artifact"]).toEqual({ digest: "sha256:x", specHash: "sha256:y" });
    expect(read.active?.["gen"]).toBeUndefined();
    expect(read.anomalies).toEqual([]);
  });

  test("two active rows: the later activatedAt is active and the other is reported", () => {
    const root = tempDir();
    const file = join(root, controlPaths(root).deploymentsFile);
    plant(
      file,
      jsonLine({ ...prepared(DEP_A) }) +
        jsonLine({ ...prepared(DEP_B) }) +
        jsonLine({ ...prepared(DEP_B), state: "active", activatedAt: "2026-11-02T00:00:00Z" }) +
        jsonLine({ ...prepared(DEP_A), state: "active", activatedAt: "2026-11-01T00:00:00Z" }),
    );
    const before = snapshotTree(root);
    const read = readDeployments(root);
    expect(read.state === "present" && read.active?.["id"]).toBe(DEP_B);
    expect(read.state === "present" && read.anomalies).toEqual([
      `${DEP_A} is also active; ${DEP_B} was activated later`,
    ]);
    // A read changes no byte and creates no file.
    expect(snapshotTree(root)).toEqual(before);
  });

  test("the ledger checks the deployment machine's moves", async () => {
    const root = tempDir();
    const ledger = deploymentsLedger(root);
    expect(ledger.machine).toBe("deployment");
    await casAppend(ledger, DEP_A, null, prepared(DEP_A));
    const illegal = await casAppend(ledger, DEP_A, "prepared", { state: "retired" });
    expect(illegal.ok && !illegal.applied && illegal.illegal).toBe(true);
  });
});

describe("harness.json", () => {
  test("absent, then written once with ifAbsent, at 0600", () => {
    const root = tempDir();
    expect(readHarnessIdentity(root)).toEqual({ state: "absent" });
    const first = writeHarnessIdentity(root, { id: HRN }, { ifAbsent: true, now: () => 0 });
    expect(first.ok).toBe(true);
    const again = writeHarnessIdentity(
      root,
      { id: "hrn_fedcba9876543210" },
      { ifAbsent: true, now: () => 0 },
    );
    expect(again.ok && again.identity.id).toBe(HRN);
    const read = readHarnessIdentity(root);
    expect(read).toEqual({
      state: "present",
      identity: { v: 1, id: HRN, createdAt: "1970-01-01T00:00:00.000Z" },
    });
    const mode = statSync(join(root, controlPaths(root).harnessIdentityFile)).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  test("a rewrite keeps the fields it does not name", () => {
    const root = tempDir();
    const file = join(root, controlPaths(root).harnessIdentityFile);
    plant(file, JSON.stringify({ v: 1, id: HRN, createdAt: "t", owner: "prn_x" }));
    const written = writeHarnessIdentity(root, { id: HRN, slug: "bot" });
    expect(written.ok).toBe(true);
    const read = readHarnessIdentity(root);
    expect(read.state === "present" && read.identity).toEqual({
      v: 1,
      id: HRN,
      slug: "bot",
      createdAt: "t",
      owner: "prn_x",
    });
  });

  test("an id that is not a harness id is unreadable, and is never written", () => {
    const root = tempDir();
    const file = join(root, controlPaths(root).harnessIdentityFile);
    plant(file, JSON.stringify({ v: 1, id: "nope", createdAt: "t" }));
    expect(readHarnessIdentity(root).state).toBe("unreadable");
    expect(writeHarnessIdentity(root, { id: "nope" }).ok).toBe(false);
    writeFileSync(file, "not json");
    expect(readHarnessIdentity(root).state).toBe("unreadable");
  });
});
