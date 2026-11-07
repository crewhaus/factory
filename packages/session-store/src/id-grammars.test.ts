/**
 * This package takes its id grammars from `@crewhaus/control-contract`. They are
 * the contract's own objects, never copies, and what the real minters here produce
 * still satisfies them.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as contract from "@crewhaus/control-contract";
import { APPROVAL_ID_RE, SESSION_ID_RE, createSessionStore, generateApprovalId } from "./index";

test("the exports are the contract's objects", () => {
  expect(SESSION_ID_RE).toBe(contract.SESSION_ID_RE);
  expect(APPROVAL_ID_RE).toBe(contract.APPROVAL_ID_RE);
});

test("the real minters satisfy them", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "session-store-grammars-"));
  try {
    const store = createSessionStore({ rootDir });
    for (let i = 0; i < 20; i++) {
      expect(generateApprovalId()).toMatch(APPROVAL_ID_RE);
      const session = await store.create({ target: "cli", model: "m" });
      expect(session.id).toMatch(SESSION_ID_RE);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("what they accept is unchanged", () => {
  expect(SESSION_ID_RE.source).toBe("^sess_[0-9a-f]{16}$");
  expect(APPROVAL_ID_RE.source).toBe("^appr_[0-9a-f]{16}$");
  expect(SESSION_ID_RE.flags).toBe("");
  expect(APPROVAL_ID_RE.flags).toBe("");
});
