/**
 * Tests for LAN address selection.
 *
 * The interface maps below are real `os.networkInterfaces()` output shapes,
 * trimmed to the fields the picker reads — including the one that motivated
 * this module: a macOS laptop where the genuine Wi-Fi address sits behind
 * four VPN tunnels and two Apple peer-to-peer radios, all of them
 * non-internal and all of them useless to a phone.
 */
import { describe, expect, test } from "bun:test";
import {
  type InterfaceMap,
  NO_LAN_ADDRESS_REFUSAL,
  lanAddresses,
  pickLanAddress,
} from "./lan-address";

const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal });
const v6 = (address: string, internal = false) => ({ address, family: "IPv6", internal });

/** The machine this was written on: en1 is the answer, everything else noise. */
const MACBOOK: InterfaceMap = {
  lo0: [v4("127.0.0.1", true), v6("::1", true), v6("fe80::1", true)],
  en1: [v4("192.168.132.129")],
  utun0: [v6("fe80::da12:389f:2939:f760")],
  awdl0: [v6("fe80::1c68:2dff:fe16:122")],
  utun1: [v6("fe80::42f7:dadc:e0f9:1527")],
  llw0: [v6("fe80::1c68:2dff:fe16:122")],
};

describe("pickLanAddress", () => {
  test("finds the one real address among loopback, tunnels and AWDL", () => {
    expect(pickLanAddress(MACBOOK)).toEqual({ interfaceName: "en1", address: "192.168.132.129" });
  });

  test("returns undefined when the machine has nothing routable", () => {
    expect(pickLanAddress({ lo0: [v4("127.0.0.1", true)] })).toBeUndefined();
    expect(pickLanAddress({})).toBeUndefined();
    expect(pickLanAddress({ en0: undefined })).toBeUndefined();
    // Self-assigned addresses mean DHCP failed; nothing can reach them.
    expect(pickLanAddress({ en0: [v4("169.254.10.3")] })).toBeUndefined();
  });

  test("ignores IPv6 entirely — a zone index cannot go in a URL", () => {
    expect(
      pickLanAddress({ en0: [v6("fe80::1c68:2dff:fe16:122"), v6("2001:db8::1")] }),
    ).toBeUndefined();
    expect(pickLanAddress({ en0: [v6("2001:db8::1"), v4("10.0.0.5")] })?.address).toBe("10.0.0.5");
  });

  test("accepts the numeric family shape older Node reported", () => {
    expect(pickLanAddress({ en0: [{ address: "10.1.2.3", family: 4, internal: false }] })).toEqual({
      interfaceName: "en0",
      address: "10.1.2.3",
    });
  });
});

describe("ranking", () => {
  test("prefers a private address on a physical interface over a virtual one", () => {
    const ranked = lanAddresses({
      docker0: [v4("172.17.0.1")],
      en0: [v4("192.168.1.42")],
      vmnet1: [v4("192.168.64.1")],
    });
    expect(ranked[0]).toEqual({ interfaceName: "en0", address: "192.168.1.42" });
    // The virtual ones are still offered, just last — a machine that has
    // only a bridge should still get a QR rather than a refusal.
    expect(ranked.length).toBe(3);
    expect(ranked.map((a) => a.interfaceName)).toEqual(["en0", "docker0", "vmnet1"]);
  });

  test("prefers a real LAN address over a Tailscale/CGNAT one", () => {
    const ranked = lanAddresses({ en0: [v4("192.168.1.42")], tailscale0: [v4("100.101.102.103")] });
    expect(ranked[0]?.address).toBe("192.168.1.42");
  });

  test("still offers a CGNAT address when it is all there is", () => {
    // Tailscale-only: reachable, just not "the same network", so it ranks
    // last rather than being filtered out.
    expect(pickLanAddress({ tailscale0: [v4("100.101.102.103")] })?.address).toBe(
      "100.101.102.103",
    );
  });

  test("orders physical interfaces predictably rather than by kernel order", () => {
    const listedBackwards: InterfaceMap = {
      en3: [v4("192.168.1.13")],
      en0: [v4("192.168.1.10")],
      en1: [v4("192.168.1.11")],
    };
    expect(lanAddresses(listedBackwards).map((a) => a.interfaceName)).toEqual([
      "en0",
      "en1",
      "en3",
    ]);
    // Same input, different insertion order, same answer.
    const listedForwards: InterfaceMap = {
      en0: [v4("192.168.1.10")],
      en1: [v4("192.168.1.11")],
      en3: [v4("192.168.1.13")],
    };
    expect(lanAddresses(listedForwards)).toEqual(lanAddresses(listedBackwards));
  });

  test("prefers ethernet and wifi names over an unrecognised one", () => {
    const ranked = lanAddresses({ mystery0: [v4("192.168.1.9")], eth0: [v4("192.168.1.8")] });
    expect(ranked[0]?.interfaceName).toBe("eth0");
  });

  test("recognises all three RFC 1918 ranges and rejects their near misses", () => {
    expect(pickLanAddress({ en0: [v4("10.0.0.1")] })?.address).toBe("10.0.0.1");
    expect(pickLanAddress({ en0: [v4("172.16.0.1")] })?.address).toBe("172.16.0.1");
    expect(pickLanAddress({ en0: [v4("172.31.255.254")] })?.address).toBe("172.31.255.254");
    expect(pickLanAddress({ en0: [v4("192.168.0.1")] })?.address).toBe("192.168.0.1");
    // 172.15 and 172.32 are outside the block, and 192.169 is not 192.168 —
    // still offered (they are routable) but ranked below a private address.
    const ranked = lanAddresses({ en0: [v4("172.32.0.1")], en1: [v4("172.16.0.1")] });
    expect(ranked[0]?.address).toBe("172.16.0.1");
  });

  test("skips malformed addresses without ranking them as private", () => {
    const ranked = lanAddresses({ en0: [v4("10.0.0.300")], en1: [v4("10.0.0.5")] });
    expect(ranked[0]?.address).toBe("10.0.0.5");
  });
});

test("the refusal names both the cause and the way out", () => {
  expect(NO_LAN_ADDRESS_REFUSAL).toContain("--lan");
  expect(NO_LAN_ADDRESS_REFUSAL).toContain("--host");
  expect(NO_LAN_ADDRESS_REFUSAL).toContain("169.254");
});
