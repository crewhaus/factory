import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  COMMAND_KINDS,
  ERROR_CODES,
  EXIT_FOR_ERROR,
  EXIT_FOR_REJECTED_RECEIPT,
  LEGACY_COMMAND_KIND_RE,
  isCommandKind,
} from "./index.js";
import { SCHEMAS } from "./schemas/index.js";

const RECEIPT = {
  id: "cmd_01m76e6f05hp514w9j4v3qymkt",
  v: 1,
  kind: "controls.stop",
  target: "home/harness/hrn_0123456789abcdef",
  actor: `local:#${"a".repeat(64)}`,
  via: "cli",
  fingerprint: "f".repeat(64),
  state: "accepted",
  acceptedAt: "2026-11-11T00:00:00.000Z",
  effects: [],
  retry: { retryable: true, safety: "idempotent" },
};

const parse = (value: unknown): boolean =>
  (SCHEMAS["commandReceipt"] as z.ZodTypeAny).safeParse(value).success;

describe("command kinds", () => {
  test("every composed kind is a command kind", () => {
    const kinds = Object.keys(COMMAND_KINDS);
    expect(kinds.length).toBeGreaterThanOrEqual(27);
    for (const kind of kinds) expect(isCommandKind(kind)).toBe(true);
  });

  test("a legacy route's kind is `legacy.<route key>`, and nothing looser", () => {
    for (const kind of [
      "legacy.setPin",
      "legacy.specEdit",
      "legacy.a",
      `legacy.a${"b".repeat(63)}`,
    ]) {
      expect(isCommandKind(kind)).toBe(true);
    }
    for (const kind of [
      "legacy.",
      "legacy.SetPin",
      "legacy.set-pin",
      "legacy.set.pin",
      `legacy.a${"b".repeat(64)}`,
      "Legacy.setPin",
      "controls.nope",
      "",
      " legacy.setPin",
    ]) {
      expect(isCommandKind(kind)).toBe(false);
    }
    expect(isCommandKind(undefined)).toBe(false);
    expect(isCommandKind(7)).toBe(false);
    expect(LEGACY_COMMAND_KIND_RE.test("legacy.setPin")).toBe(true);
  });

  test("the receipt schema takes a legacy kind and refuses an unknown one", () => {
    expect(parse(RECEIPT)).toBe(true);
    expect(parse({ ...RECEIPT, kind: "legacy.setPin" })).toBe(true);
    expect(parse({ ...RECEIPT, kind: "legacy.set-pin" })).toBe(false);
    expect(parse({ ...RECEIPT, kind: "nope" })).toBe(false);
  });
});

describe("exits", () => {
  test("every error code has an exit, and nothing else does", () => {
    expect(Object.keys(EXIT_FOR_ERROR).sort()).toEqual(Object.keys(ERROR_CODES).sort());
    expect(Object.isFrozen(EXIT_FOR_ERROR)).toBe(true);
  });

  test("the band, by code", () => {
    expect(EXIT_FOR_ERROR.unauthenticated).toBe(50);
    expect(EXIT_FOR_ERROR.forbidden).toBe(51);
    expect(EXIT_FOR_ERROR.unavailable).toBe(52);
    expect(EXIT_FOR_ERROR.idempotency_key_reused).toBe(53);
    expect(EXIT_FOR_ERROR.unsupported).toBe(54);
    expect(EXIT_FOR_ERROR.invalid).toBe(55);
    expect(EXIT_FOR_ERROR.not_found).toBe(56);
    expect(EXIT_FOR_ERROR.internal).toBe(1);
    expect(EXIT_FOR_REJECTED_RECEIPT).toBe(55);
  });
});
