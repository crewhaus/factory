/**
 * The library layer, driven directly.
 *
 * Three things are checked here rather than through a tool call, because
 * through a tool call they would be checked once each and here they are
 * checked against a table: the private-address classifier (EXECUTED, never
 * read — asserting on its text is what let six drifted copies ship), the
 * quoting of authored text, and the five-way peer verdict.
 *
 * Nothing in this file opens a socket, sends a DNS query, or touches a file.
 */
import { describe, expect, test } from "bun:test";
import type { PeerRecord } from "@crewhaus/federation-discovery";
import type { TemplateMetadata } from "@crewhaus/template-registry";
import { filterTemplates, unaccountedFiles } from "./lib/marketplace";
import { type Attempt, isPrivateIp, normalizeIpv4, parseIpv6 } from "./lib/net";
import { classifyPeer, normalizeFingerprint, tally } from "./lib/peers";
import { Unknowns, compareStrings } from "./lib/result";
import { CAPS, quoteFields, quoteList, quoteUntrusted } from "./lib/untrusted";

// ---------------------------------------------------------------------------
// the private-address classifier
// ---------------------------------------------------------------------------

describe("the classifier is run, not read", () => {
  /**
   * Every one of these is a real bypass that has shipped somewhere: an
   * `inet_aton` short form, a hex or octal octet, an IPv4-mapped IPv6 address
   * in the spelling `new URL()` actually produces, and the two NAT64 prefixes
   * — `64:ff9b::/96` AND the `64:ff9b:1::/48` variant that one numerically
   * correct copy still got wrong.
   */
  const MUST_BE_PRIVATE = [
    "127.0.0.1",
    "127.1",
    "0177.0.0.1",
    "0x7f.0.0.1",
    "2130706433",
    "169.254.169.254",
    "0",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "::ffff:a9fe:a9fe",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::a9fe:a9fe",
    "2002:a9fe:a9fe::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
  ];

  const MUST_BE_PUBLIC = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700::1111", "172.32.0.1"];

  test("every private spelling is classified private", () => {
    const wrong = MUST_BE_PRIVATE.filter((a) => !isPrivateIp(a));
    expect(wrong).toEqual([]);
  });

  test("public addresses are not swept up with them", () => {
    const wrong = MUST_BE_PUBLIC.filter((a) => isPrivateIp(a));
    expect(wrong).toEqual([]);
  });

  test("the short forms pack into the LAST octet, not the first", () => {
    // 127.1 is 127.0.0.1. Getting this backwards is how a bypass survives a
    // test that only checks the verdict for the dotted-quad spelling.
    expect(normalizeIpv4("127.1")).toBe("127.0.0.1");
    expect(normalizeIpv4("2130706433")).toBe("127.0.0.1");
    expect(normalizeIpv4("not-an-ip")).toBeNull();
    expect(parseIpv6("::1")?.length).toBe(8);
    expect(parseIpv6("1.2.3.4")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// authored text
// ---------------------------------------------------------------------------

describe("authored text is quoted, and the quoting is reported", () => {
  test("control characters and the ANSI introducer are replaced", () => {
    const raw = "line\u001b[2Jcleared\u0000null";
    const q = quoteUntrusted(raw, CAPS.description);
    expect(q.text).not.toContain("\u001b");
    expect(q.text).not.toContain("\u0000");
    expect(q.notes).toContain("control-characters");
    // The words survive; only the characters that forge a rendering go.
    expect(q.text).toContain("cleared");
  });

  test("a tab survives, because it forges nothing", () => {
    const q = quoteUntrusted("a\tb", CAPS.description);
    expect(q.text).toBe("a\tb");
    expect(q.notes).toEqual([]);
  });

  test("bidi overrides and zero-width characters are replaced and named", () => {
    const q = quoteUntrusted("safe\u202eevil\u200bhidden", CAPS.description);
    expect(q.text).not.toContain("\u202e");
    expect(q.text).not.toContain("\u200b");
    expect(q.notes).toEqual(["bidi-or-invisible"]);
  });

  test("the caps bound the field and say they did", () => {
    const q = quoteUntrusted("x".repeat(CAPS.description + 50), CAPS.description);
    expect(q.text.length).toBe(CAPS.description + 1); // + the ellipsis
    expect(q.notes).toEqual(["truncated"]);
  });

  test("a field that is not a string is not silently an empty one", () => {
    expect(quoteUntrusted({ evil: true }, 10).notes).toEqual(["not-a-string"]);
    expect(quoteUntrusted(undefined, 10).notes).toEqual(["not-a-string"]);
    // An empty string is a different answer and carries no note.
    expect(quoteUntrusted("", 10).notes).toEqual([]);
  });

  test("two calls with the same input give the same answer", () => {
    // Regression: the matchers are /g regexes. A `.test()` probe would advance
    // `lastIndex` and make the SECOND call start mid-string, so a description
    // would be sanitized on one row and not on the next.
    const raw = "a\u0000b\u0000c";
    const first = quoteUntrusted(raw, 100);
    const second = quoteUntrusted(raw, 100);
    expect(second).toEqual(first);
    expect(first.notes).toEqual(["control-characters"]);
  });

  test("quoteFields names each altered field, sorted", () => {
    const { authored, sanitized } = quoteFields([
      ["name", "ok", CAPS.name],
      ["description", "bad\u0000", CAPS.description],
      ["author", "x".repeat(CAPS.author + 1), CAPS.author],
    ] as const);
    expect(authored.name).toBe("ok");
    expect(sanitized).toEqual(["author:truncated", "description:control-characters"]);
  });

  test("quoteList bounds both the item and the list", () => {
    const list = Array.from({ length: CAPS.listItems + 5 }, () => "shape");
    const q = quoteList(list, CAPS.shape);
    expect(q.items.length).toBe(CAPS.listItems);
    expect(q.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fingerprints
// ---------------------------------------------------------------------------

describe("a pinned fingerprint is normalised once, then compared", () => {
  const hex = "a".repeat(64);

  test("the spellings operators actually paste all reach one value", () => {
    const colons = hex.match(/.{2}/g)?.join(":") ?? "";
    expect(normalizeFingerprint(hex.toUpperCase())).toBe(hex);
    expect(normalizeFingerprint(colons)).toBe(hex);
    expect(normalizeFingerprint(`  ${hex}\n`)).toBe(hex);
  });

  test("anything that is not a SHA-256 fingerprint is null, not a pass", () => {
    expect(normalizeFingerprint("a".repeat(63))).toBeNull();
    expect(normalizeFingerprint("z".repeat(64))).toBeNull();
    expect(normalizeFingerprint("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the five-way verdict
// ---------------------------------------------------------------------------

describe("a peer's verdict comes from the attempt record", () => {
  const record: PeerRecord = {
    endpoint: "https://peer.example",
    version: "crewhaus.federation.v1",
    supportedShapes: ["assistant"],
    publicKeyFingerprint: "b".repeat(64),
  };
  const answered = (status: number, extra: Partial<Attempt> = {}): Attempt =>
    ({
      kind: "answered",
      url: "https://peer.example/.well-known/crewhaus.json",
      status,
      bytes: 10,
      truncated: false,
      ...extra,
    }) as Attempt;

  test("answered and well-formed is healthy", () => {
    const v = classifyPeer({ record, fromCache: false, attempt: answered(200), expect: {} });
    expect(v.outcome).toBe("healthy");
  });

  test("answered with a 503 is unhealthy, NOT unreachable", () => {
    const v = classifyPeer({
      fromCache: false,
      attempt: answered(503),
      error: "well-known fetch returned 503",
      expect: {},
    });
    expect({ outcome: v.outcome, code: v.code }).toEqual({
      outcome: "unhealthy",
      code: "unhealthy:http-503",
    });
  });

  test("answered with unparseable JSON is unhealthy, and the reason says why", () => {
    const v = classifyPeer({
      fromCache: false,
      attempt: answered(200),
      error: "well-known returned invalid JSON",
      expect: {},
    });
    expect(v.code).toBe("unhealthy:bad-record");
    expect(v.reason).toContain("invalid JSON");
  });

  test("nothing came back is unreachable, and names which nothing", () => {
    const v = classifyPeer({
      fromCache: false,
      attempt: {
        kind: "no-answer",
        url: "https://peer.example/.well-known/crewhaus.json",
        code: "transport",
        reason: "the connection failed (ECONNREFUSED)",
      },
      error: "peer discovery failed",
      expect: {},
    });
    expect({ outcome: v.outcome, code: v.code }).toEqual({
      outcome: "unreachable",
      code: "unreachable:transport",
    });
  });

  test("a guard refusal is refused — we never asked, so nothing is known", () => {
    const v = classifyPeer({
      fromCache: false,
      attempt: {
        kind: "refused",
        url: "https://127.0.0.1/.well-known/crewhaus.json",
        code: "private",
        reason: "refusing to dial",
      },
      error: "peer discovery failed",
      expect: {},
    });
    expect(v.outcome).toBe("refused");
    // Not "unreachable": counting a peer we declined to contact as down is how
    // a federation gets reported smaller than it is.
    expect(v.code).toBe("refused:private");
  });

  test("a cancelled run is undetermined, not a silent peer", () => {
    const v = classifyPeer({
      fromCache: false,
      attempt: {
        kind: "no-answer",
        url: "https://peer.example/.well-known/crewhaus.json",
        code: "cancelled",
        reason: "the run was cancelled",
      },
      expect: {},
    });
    expect(v.outcome).toBe("undetermined");
  });

  test("no attempt and a cache entry is a cached negative, not a refusal", () => {
    const cached = classifyPeer({ fromCache: true, error: "unreachable (cached)", expect: {} });
    expect({ outcome: cached.outcome, code: cached.code }).toEqual({
      outcome: "unreachable",
      code: "unreachable:cached",
    });
    const never = classifyPeer({ fromCache: false, error: "invalid deployment id", expect: {} });
    expect({ outcome: never.outcome, code: never.code }).toEqual({
      outcome: "refused",
      code: "refused:peer-id",
    });
  });

  test("a fingerprint mismatch is unhealthy and prints both values", () => {
    const v = classifyPeer({
      record,
      fromCache: false,
      attempt: answered(200),
      expect: { pin: "c".repeat(64) },
    });
    expect(v.code).toBe("unhealthy:fingerprint-mismatch");
    expect(v.reason).toContain("b".repeat(64));
    expect(v.reason).toContain("c".repeat(64));
  });

  test("a version mismatch is unhealthy, and equality is the whole rule", () => {
    const v = classifyPeer({
      record,
      fromCache: false,
      attempt: answered(200),
      expect: { version: "crewhaus.federation.v2" },
    });
    expect(v.code).toBe("unhealthy:version-mismatch");
  });

  test("an advertised endpoint that would not be dialled is unhealthy", () => {
    const v = classifyPeer({
      record,
      fromCache: false,
      attempt: answered(200),
      endpointVet: { ok: false, code: "private", reason: "refusing to dial 169.254.169.254" },
      expect: {},
    });
    expect(v.code).toBe("unhealthy:endpoint-private");
  });

  test("an advertised endpoint that merely did not resolve is NOT a health verdict", () => {
    // "could not determine" is not "no". The peer answered correctly; whether
    // its endpoint resolves from here is a separate, unknown fact.
    const v = classifyPeer({
      record,
      fromCache: false,
      attempt: answered(200),
      endpointVet: { ok: false, code: "unresolvable", reason: "the name did not resolve" },
      expect: {},
    });
    expect(v.outcome).toBe("healthy");
  });

  test("a redirect is reported, not followed", () => {
    const v = classifyPeer({
      fromCache: false,
      attempt: answered(302, { location: "http://169.254.169.254/" } as Partial<Attempt>),
      error: "well-known fetch returned 302",
      expect: {},
    });
    expect(v.code).toBe("unhealthy:redirect-302");
    expect(v.reason).toContain("does not follow");
  });

  test("every outcome has its own column in the tally", () => {
    const counts = tally([
      { outcome: "healthy", code: "healthy", reason: "" },
      { outcome: "healthy", code: "healthy", reason: "" },
      { outcome: "unreachable", code: "unreachable:transport", reason: "" },
      { outcome: "refused", code: "refused:private", reason: "" },
      { outcome: "undetermined", code: "undetermined:cancelled", reason: "" },
    ]);
    expect(counts).toEqual({
      healthy: 2,
      unhealthy: 0,
      unreachable: 1,
      refused: 1,
      undetermined: 1,
      total: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// the registry helpers
// ---------------------------------------------------------------------------

describe("the registry gap and the filters", () => {
  const meta = (over: Partial<TemplateMetadata>): TemplateMetadata =>
    ({
      name: "one",
      version: "1.0.0",
      description: "a template",
      author: "someone",
      target: "assistant",
      ...over,
    }) as TemplateMetadata;

  test("a file the listing never named is reported, sorted", () => {
    const gap = unaccountedFiles(["zeta.json", "one.json", "broken.json"], [meta({ name: "one" })]);
    expect(gap).toEqual(["broken.json", "zeta.json"]);
  });

  test("a manifest with no kind filters as a spec-template", () => {
    const listing = [meta({ name: "plain" }), meta({ name: "grader", kind: "grader-template" })];
    expect(filterTemplates(listing, { kind: "spec-template" }).map((m) => m.name)).toEqual([
      "plain",
    ]);
    expect(filterTemplates(listing, { kind: "grader-template" }).map((m) => m.name)).toEqual([
      "grader",
    ]);
  });

  test("the query matches the AUTHORED value, not the display copy", () => {
    // The description contains a zero-width character. The result will show it
    // sanitized; a search for the plain word must still find it, or the tool
    // filters on one spelling and reports another.
    const listing = [meta({ name: "zw", description: "hand\u200bwritten rubric" })];
    expect(filterTemplates(listing, { query: "hand" }).map((m) => m.name)).toEqual(["zw"]);
  });

  test("listings sort by plain string order, never by locale", () => {
    const listing = [meta({ name: "b" }), meta({ name: "A" }), meta({ name: "a" })];
    expect(filterTemplates(listing, {}).map((m) => m.name)).toEqual(["A", "a", "b"]);
    expect(compareStrings("A", "a")).toBeLessThan(0);
  });
});

describe("unknowns", () => {
  test("the first writer wins and the list is sorted by field", () => {
    const u = new Unknowns();
    u.add("b", "probe", "specific");
    u.add("b", "probe", "generic");
    u.add("a", "probe", "other");
    expect(u.list().map((f) => [f.field, f.reason])).toEqual([
      ["a", "other"],
      ["b", "specific"],
    ]);
    expect(u.size).toBe(2);
  });
});
