/**
 * Idempotency claims expire on Home's tick, by the one rule a key is honoured under: seven
 * days. A fresher claim, and a claim of another kind, stay.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { publishClaim } from "@crewhaus/control-records";
import { IDEMPOTENCY_TTL_MS, expireIdempotencyClaims } from "./idempotency";
import { commandsLedgerOf } from "./ledgers";
import { NOW, removeTempDirs, tempDir, treeBytes } from "./test-helpers";

afterAll(removeTempDirs);

let clock: { mockRestore(): void } | undefined;
afterEach(() => {
  clock?.mockRestore();
  clock = undefined;
});

function claimAt(harness: string, claim: string, at: number): void {
  clock = spyOn(Date, "now").mockReturnValue(at);
  const published = publishClaim(commandsLedgerOf(harness), claim, { id: claim });
  clock.mockRestore();
  clock = undefined;
  if (!published.ok) throw new Error(published.reason);
}

const claimFile = (harness: string, claim: string): string =>
  join(harness, ".crewhaus", "run", "control", "claims", `${claim}.json`);

describe("expireIdempotencyClaims", () => {
  test("a claim older than the TTL is removed; a fresher one and another kind's stay", async () => {
    const harness = tempDir();
    claimAt(harness, "idem/old", NOW - IDEMPOTENCY_TTL_MS - 1000);
    claimAt(harness, "idem/fresh", NOW - 1000);
    claimAt(harness, "recover/old", NOW - IDEMPOTENCY_TTL_MS - 1000);
    expect(await expireIdempotencyClaims(commandsLedgerOf(harness), NOW)).toEqual({
      checked: 2,
      truncated: false,
    });
    expect(existsSync(claimFile(harness, "idem/old"))).toBe(false);
    expect(existsSync(claimFile(harness, "idem/fresh"))).toBe(true);
    expect(existsSync(claimFile(harness, "recover/old"))).toBe(true);
  });

  test("with nothing due, nothing is written, and a ledger with no claims is left alone", async () => {
    const harness = tempDir();
    claimAt(harness, "idem/fresh", NOW - 1000);
    const before = treeBytes(harness);
    await expireIdempotencyClaims(commandsLedgerOf(harness), NOW);
    expect(treeBytes(harness)).toEqual(before);
    const empty = tempDir();
    expect(await expireIdempotencyClaims(commandsLedgerOf(empty), NOW)).toEqual({
      checked: 0,
      truncated: false,
    });
    expect(existsSync(join(empty, ".crewhaus"))).toBe(false);
  });
});
