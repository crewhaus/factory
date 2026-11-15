/**
 * The device sign-in schemas: a device's name reads as what it is (no control, format,
 * bidi or invisible character, no line or paragraph separator), and the request a member
 * is shown always carries where it came from and when it arrived.
 */
import { describe, expect, test } from "bun:test";
import { AT, SEAL } from "./__test__/schema-examples";
import { deviceRequestView, deviceStartRequest } from "./schemas/core";

const VIEW = {
  state: "pending",
  readOnly: false,
  expiresAt: AT,
  createdAt: AT,
  requestedFrom: { via: "direct", address: "203.0.113.5" },
  tokenDays: 90,
} as const;

describe("a device's name", () => {
  test("never holds a bidi, invisible, control or separator character", () => {
    for (const bad of ["\u202e", "\u2066", "\u200b", "\u2028", "\u2029", "\u0085", "\ufeff"]) {
      const clientName = `lap${bad}top`;
      expect(deviceStartRequest.safeParse({ seal: SEAL, clientName }).success).toBe(false);
    }
    expect(deviceStartRequest.safeParse({ seal: SEAL, clientName: "a\u0007b" }).success).toBe(
      false,
    );
  });

  test("is any short plain label, in any script", () => {
    for (const clientName of [
      "crewhaus CLI on my-mac.local",
      "Sam’s laptop",
      "サムのパソコン",
      "Ноутбук",
    ]) {
      expect(deviceStartRequest.safeParse({ seal: SEAL, clientName }).success).toBe(true);
    }
  });
});

describe("the request a member is shown", () => {
  test("names where it came from and when it arrived", () => {
    expect(deviceRequestView.safeParse(VIEW).success).toBe(true);
    expect(deviceRequestView.safeParse({ ...VIEW, requestedFrom: { via: "proxy" } }).success).toBe(
      true,
    );
    const { requestedFrom: _from, ...noFrom } = VIEW;
    expect(deviceRequestView.safeParse(noFrom).success).toBe(false);
    const { createdAt: _at, ...noAt } = VIEW;
    expect(deviceRequestView.safeParse(noAt).success).toBe(false);
  });

  test("names only a known way in, and nothing else about it", () => {
    expect(deviceRequestView.safeParse({ ...VIEW, requestedFrom: { via: "header" } }).success).toBe(
      false,
    );
    expect(
      deviceRequestView.safeParse({
        ...VIEW,
        requestedFrom: { via: "direct", address: "203.0.113.5", name: "x" },
      }).success,
    ).toBe(false);
    expect(
      deviceRequestView.safeParse({
        ...VIEW,
        requestedFrom: { via: "direct", address: "1".repeat(65) },
      }).success,
    ).toBe(false);
  });
});
