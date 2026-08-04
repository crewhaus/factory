/**
 * HM-201 — the remote-bind opt-in.
 *
 * The property under test is fail-closed: everything that is not provably
 * this machine needs the explicit opt-in, including the two wildcard
 * addresses that look the most harmless (`0.0.0.0`, `::`).
 */
import { describe, expect, test } from "bun:test";
import {
  REMOTE_BIND_ENV,
  isLoopbackHost,
  isRemoteBindOptedIn,
  remoteBindRefusal,
} from "./remote-bind";

const OPTED_IN = { [REMOTE_BIND_ENV]: "1" } as const;

describe("isLoopbackHost", () => {
  test("the whole 127.0.0.0/8, localhost, and ::1 in every spelling are loopback", () => {
    for (const host of [
      "127.0.0.1",
      "127.0.0.2",
      "127.255.255.254",
      "localhost",
      "LocalHost",
      "  127.0.0.1  ",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("the wildcards bind every interface and are NOT loopback", () => {
    // The whole point of HM-201: `--host 0.0.0.0` is the muscle-memory value
    // and the most exposing one.
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("[::]")).toBe(false);
  });

  test("LAN addresses, names, and malformed input all fail closed", () => {
    for (const host of [
      "192.168.1.10",
      "10.0.0.5",
      "0.0.0.1",
      "128.0.0.1",
      "1270.0.0.1",
      "127.0.0.256",
      "127.0.0.1.5",
      "hangar.local",
      "fe80::1%eth0",
      "2001:db8::1",
      ":::1",
      "127.0.0.1:4200",
      "",
      "   ",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("isRemoteBindOptedIn", () => {
  test("only an explicit 1/true opts in — a typo is not consent", () => {
    expect(isRemoteBindOptedIn({ [REMOTE_BIND_ENV]: "1" })).toBe(true);
    expect(isRemoteBindOptedIn({ [REMOTE_BIND_ENV]: "true" })).toBe(true);
    for (const raw of ["0", "false", "", "yes", "TRUE", " 1"]) {
      expect(isRemoteBindOptedIn({ [REMOTE_BIND_ENV]: raw })).toBe(false);
    }
    expect(isRemoteBindOptedIn({})).toBe(false);
  });
});

describe("remoteBindRefusal", () => {
  test("the default (no --host) and a loopback --host need no opt-in", () => {
    expect(remoteBindRefusal(undefined, {})).toBeUndefined();
    expect(remoteBindRefusal("127.0.0.1", {})).toBeUndefined();
    expect(remoteBindRefusal("::1", {})).toBeUndefined();
  });

  test("a non-loopback --host without the opt-in is refused", () => {
    const refusal = remoteBindRefusal("0.0.0.0", {});
    expect(refusal).toBeDefined();
    expect(refusal).toContain("0.0.0.0");
  });

  test("the refusal names the variable AND the supported answer", () => {
    // An error that withholds the escape hatch gets worked around with
    // something worse (a port-forward), so both halves are asserted.
    const refusal = remoteBindRefusal("192.168.1.10", {}) as string;
    expect(refusal).toContain(`${REMOTE_BIND_ENV}=1`);
    expect(refusal).toContain("private network");
    expect(refusal).toContain("do not port-forward");
    expect(refusal.split("\n")).toHaveLength(1);
  });

  test("the opt-in permits the bind — and is read from the INJECTED env", () => {
    expect(remoteBindRefusal("0.0.0.0", OPTED_IN)).toBeUndefined();
    expect(remoteBindRefusal("192.168.1.10", { [REMOTE_BIND_ENV]: "true" })).toBeUndefined();
    // Ambient process.env must not leak in: an empty injected env refuses
    // even when the developer running the suite has the variable exported.
    expect(remoteBindRefusal("192.168.1.10", {})).toBeDefined();
  });
});
