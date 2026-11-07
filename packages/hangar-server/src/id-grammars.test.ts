/**
 * This package takes its id grammars from `@crewhaus/control-contract`. They are
 * the contract's own objects, never copies, and the file-name grammars built from
 * them read exactly as the literals they replaced.
 */
import { expect, test } from "bun:test";
import * as contract from "@crewhaus/control-contract";
import { generateApprovalId } from "@crewhaus/session-store";
import { APPROVAL_ID_RE } from "./approvals";
import { SESSION_ID_RE, SESSION_JSONL_RE, SESSION_JSON_RE } from "./constants";
import * as entry from "./index";

test("the exports are the contract's objects, through the entry too", () => {
  expect(SESSION_ID_RE).toBe(contract.SESSION_ID_RE);
  expect(APPROVAL_ID_RE).toBe(contract.APPROVAL_ID_RE);
  expect(entry.SESSION_ID_RE).toBe(contract.SESSION_ID_RE);
});

test("the file-name grammars read as the old literals", () => {
  expect(SESSION_JSON_RE.source).toBe(/^sess_[0-9a-f]{16}\.json$/.source);
  expect(SESSION_JSONL_RE.source).toBe(/^sess_[0-9a-f]{16}\.jsonl$/.source);
  expect(SESSION_JSON_RE.flags).toBe("");
  expect(SESSION_JSONL_RE.flags).toBe("");
});

test("what they accept is unchanged", () => {
  const id = "sess_0123456789abcdef";
  expect(SESSION_ID_RE.test(id)).toBe(true);
  expect(SESSION_JSON_RE.test(`${id}.json`)).toBe(true);
  expect(SESSION_JSONL_RE.test(`${id}.jsonl`)).toBe(true);
  expect(SESSION_JSON_RE.test(`${id}xjson`)).toBe(false);
  expect(SESSION_JSONL_RE.test(`${id}.json`)).toBe(false);
  expect(generateApprovalId()).toMatch(APPROVAL_ID_RE);
});
