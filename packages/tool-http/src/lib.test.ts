/**
 * The pure half of the package: parsing, signing, path reading, backoff
 * arithmetic and the allow-list/SSRF predicates.
 *
 * Nothing here opens a socket or touches the filesystem, which is the point
 * — these are the functions the tools are thin wrappers over, so this is
 * where their behaviour is pinned down. The tools' own tests then only have
 * to prove the wiring and the world-facing parts.
 */
import { describe, expect, test } from "bun:test";
import { daysRemaining, formatDn, parseSubjectAltNames, summarizeCert } from "./lib/cert";
import { parseFeed } from "./lib/feed";
import { JsonPathError, matchesPredicate, parsePath, readPath } from "./lib/jsonpath";
import { parseLinkHeader, relTarget } from "./lib/link-header";
import { backoffDelayMs, nextDelayMs, parseRetryAfterMs } from "./lib/retry";
import { evaluateRobots, parseRobots, pathMatches, selectGroup } from "./lib/robots";
import { parseSitemap } from "./lib/sitemap";
import { SseDecoder, decodeFrame } from "./lib/sse";
import {
  formatHeader,
  hmacHex,
  parseSignatureHeader,
  signedPayload,
  timingSafeEqualHex,
  verifySignature,
} from "./lib/webhook";
import { XmlParseError, childrenNamed, decodeXmlText, parseXml, textOf } from "./lib/xml";
import {
  HttpPermissionError,
  applyAuth,
  authHeaderName,
  buildHttpConfig,
  byString,
  canonicalizeOrigin,
  expandIpv6,
  isPrivateIp,
  normalizeIpv4,
  redactHeaders,
  rejectInlineCredentials,
  safeUrlLabel,
} from "./net";

// ---------------------------------------------------------------------------

describe("canonicalizeOrigin", () => {
  test("lowercases the host and elides the default port", () => {
    expect(canonicalizeOrigin("HTTPS://API.Example.COM")).toBe("https://api.example.com");
    expect(canonicalizeOrigin("https://api.example.com:443")).toBe("https://api.example.com");
    expect(canonicalizeOrigin("http://example.com:80")).toBe("http://example.com");
  });

  test("keeps a non-default port and drops path and query", () => {
    expect(canonicalizeOrigin("https://example.com:8443/a?b=1")).toBe("https://example.com:8443");
  });

  test("refuses a non-http scheme, so file:// can never be allow-listed", () => {
    expect(() => canonicalizeOrigin("file:///etc/passwd")).toThrow(HttpPermissionError);
    expect(() => canonicalizeOrigin("ftp://example.com")).toThrow(HttpPermissionError);
  });

  test("refuses a malformed origin at config-build time, not at request time", () => {
    expect(() => canonicalizeOrigin("not a url")).toThrow(HttpPermissionError);
    expect(() => buildHttpConfig({ allowed_origins: ["nope"] })).toThrow(HttpPermissionError);
  });
});

describe("buildHttpConfig", () => {
  test("defaults to deny-all", () => {
    const cfg = buildHttpConfig({});
    expect(cfg.allowedOrigins.size).toBe(0);
    expect(cfg.allowedHosts.size).toBe(0);
  });

  test("accepts both key spellings and derives the host list", () => {
    expect(buildHttpConfig({ allowed_origins: ["https://a.example.com"] }).allowedHosts).toEqual(
      new Set(["a.example.com"]),
    );
    expect(
      buildHttpConfig({ allowedOrigins: ["https://b.example.com:8443"] }).allowedHosts,
    ).toEqual(new Set(["b.example.com"]));
  });
});

describe("isPrivateIp / normalizeIpv4", () => {
  test("classifies every range a harness must not be steered into", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // the cloud metadata address
      "100.64.0.1",
      "192.0.0.1",
      "198.18.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
    ]) {
      expect({ ip, private: isPrivateIp(ip) }).toEqual({ ip, private: true });
    }
  });

  test("leaves public addresses alone", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111"]) {
      expect({ ip, private: isPrivateIp(ip) }).toEqual({ ip, private: false });
    }
  });

  test("octal, hex and integer spellings of loopback are canonicalised, not waved through", () => {
    expect(normalizeIpv4("0177.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIpv4("0x7f000001")).toBe("127.0.0.1");
    expect(normalizeIpv4("2130706433")).toBe("127.0.0.1");
    expect(normalizeIpv4("127.1")).toBe("127.0.0.1");
    for (const spelling of ["0177.0.0.1", "0x7f000001", "2130706433", "127.1"]) {
      expect({ spelling, private: isPrivateIp(spelling) }).toEqual({ spelling, private: true });
    }
  });

  test("returns null for something that is not an IPv4 literal", () => {
    expect(normalizeIpv4("example.com")).toBeNull();
    expect(normalizeIpv4("1.2.3.4.5")).toBeNull();
    expect(normalizeIpv4("256.0.0.1")).toBeNull();
  });

  test("every spelling of IPv6 loopback classifies the same, not just ::1", () => {
    for (const ip of [
      "::1",
      "0:0:0:0:0:0:0:1",
      "0000:0000:0000:0000:0000:0000:0000:0001",
      "::0:1",
      "::0.0.0.1",
      "[::1]",
    ]) {
      expect({ ip, private: isPrivateIp(ip) }).toEqual({ ip, private: true });
    }
  });

  test("a translated range is classified by the IPv4 address it carries", () => {
    // NAT64 and 6to4 both wrap an IPv4 address in something that looks like
    // ordinary global unicast to a prefix check. 0xa9fe_a9fe is
    // 169.254.169.254 — the cloud metadata address.
    expect(isPrivateIp("64:ff9b::a9fe:a9fe")).toBe(true); // NAT64 of 169.254.169.254
    expect(isPrivateIp("64:ff9b::7f00:1")).toBe(true); // NAT64 of 127.0.0.1
    expect(isPrivateIp("2002:a9fe:a9fe::")).toBe(true); // 6to4 of 169.254.169.254
    expect(isPrivateIp("2002:7f00:1::")).toBe(true); // 6to4 of 127.0.0.1
    // The same wrappers around a public address stay public.
    expect(isPrivateIp("64:ff9b::8080:808")).toBe(false); // NAT64 of 8.8.8.8
    expect(isPrivateIp("2002:0808:0808::")).toBe(false); // 6to4 of 8.8.8.8
  });

  test("the other IPv6 ranges a harness must not be steered into", () => {
    for (const ip of [
      "febf::1", // the top of fe80::/10, which a "fe80:" prefix test misses
      "fec0::1", // deprecated site-local
      "ff02::1", // multicast
      "100::1", // discard-only
      "fe80::1%eth0", // a zone id must not disguise a link-local address
    ]) {
      expect({ ip, private: isPrivateIp(ip) }).toEqual({ ip, private: true });
    }
  });

  test("an IPv6-shaped string that cannot be expanded is refused, not assumed public", () => {
    expect(expandIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(expandIpv6("::ffff:zz")).toBeNull();
    for (const ip of ["1:2:3:4:5:6:7:8:9", "::ffff:zz", "fe80:::1"]) {
      expect({ ip, private: isPrivateIp(ip) }).toEqual({ ip, private: true });
    }
  });

  test("IPv4 multicast, reserved and broadcast are refused too", () => {
    for (const ip of ["224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255"]) {
      expect({ ip, private: isPrivateIp(ip) }).toEqual({ ip, private: true });
    }
  });

  test("expandIpv6 fills the elision and keeps a public address public", () => {
    expect(expandIpv6("2606:4700::1111")).toEqual([0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111]);
    expect(expandIpv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandIpv6("8.8.8.8")).toBeNull();
  });
});

describe("credentials", () => {
  test("an inline credential header is refused by name, whatever its casing", () => {
    expect(rejectInlineCredentials({ Authorization: "Bearer x" })).toContain("auth profile");
    expect(rejectInlineCredentials({ cookie: "a=b" })).toContain("auth profile");
    expect(rejectInlineCredentials({ "PROXY-AUTHORIZATION": "x" })).toContain("auth profile");
    expect(rejectInlineCredentials({ accept: "application/json" })).toBeNull();
  });

  test("bearer, basic and header profiles read the named variable", () => {
    const env = { TOKEN: "s3cret", PASS: "pw" };
    const bearer: Record<string, string> = {};
    expect(applyAuth(bearer, { type: "bearer", envVar: "TOKEN" }, env)).toBeNull();
    expect(bearer["Authorization"]).toBe("Bearer s3cret");

    const basic: Record<string, string> = {};
    expect(applyAuth(basic, { type: "basic", envVar: "PASS", username: "ada" }, env)).toBeNull();
    expect(basic["Authorization"]).toBe(`Basic ${Buffer.from("ada:pw").toString("base64")}`);

    const custom: Record<string, string> = {};
    expect(
      applyAuth(custom, { type: "header", envVar: "TOKEN", headerName: "X-Api-Key" }, env),
    ).toBeNull();
    expect(custom["X-Api-Key"]).toBe("s3cret");
  });

  test("an unset variable is a readable refusal that never names the value", () => {
    const message = applyAuth({}, { type: "bearer", envVar: "MISSING_TOKEN" }, {});
    expect(message).toContain("MISSING_TOKEN");
    expect(message).toContain("unset or empty");
  });

  test("a basic profile without a username is refused rather than half-applied", () => {
    const headers: Record<string, string> = {};
    expect(applyAuth(headers, { type: "basic", envVar: "PASS" }, { PASS: "pw" })).toContain(
      "username",
    );
    expect(Object.keys(headers)).toEqual([]);
  });

  test("redactHeaders never echoes a secret back, and sorts what it keeps", () => {
    const redacted = redactHeaders({ authorization: "Bearer s3cret", accept: "*/*" });
    expect(redacted).toEqual({ accept: "*/*", authorization: "<redacted>" });
    expect(JSON.stringify(redacted)).not.toContain("s3cret");
  });

  test("authHeaderName names the header each profile type actually sets", () => {
    expect(authHeaderName(undefined)).toBeUndefined();
    expect(authHeaderName({ type: "bearer", envVar: "T" })).toBe("authorization");
    expect(authHeaderName({ type: "basic", envVar: "P", username: "ada" })).toBe("authorization");
    expect(authHeaderName({ type: "header", envVar: "T", headerName: "X-Api-Key" })).toBe(
      "x-api-key",
    );
  });

  test("a header-profile secret is redacted too — it is a token whatever it is called", () => {
    const headers = { "X-Api-Key": "s3cret", accept: "*/*" };
    // Without the profile's header name, the secret goes straight back out.
    expect(redactHeaders(headers)["X-Api-Key"]).toBe("s3cret");
    const guarded = redactHeaders(headers, new Set(["x-api-key"]));
    expect(guarded).toEqual({ "X-Api-Key": "<redacted>", accept: "*/*" });
    expect(JSON.stringify(guarded)).not.toContain("s3cret");
  });

  test("safeUrlLabel keeps the path and drops the query a signature lives in", () => {
    expect(safeUrlLabel("https://api.example.com/v1/items?token=s3cret&sig=abc")).toBe(
      "https://api.example.com/v1/items?…",
    );
    expect(safeUrlLabel("https://api.example.com/v1/items")).toBe(
      "https://api.example.com/v1/items",
    );
    expect(safeUrlLabel("https://api.example.com:8443/a#frag")).toBe(
      "https://api.example.com:8443/a?…",
    );
    expect(safeUrlLabel("https://api.example.com/x?token=s3cret")).not.toContain("s3cret");
  });
});

describe("byString", () => {
  test("orders by code unit, with no locale in sight", () => {
    expect(["b", "A", "a"].sort(byString)).toEqual(["A", "a", "b"]);
  });
});

// ---------------------------------------------------------------------------

describe("parseLinkHeader", () => {
  test("reads the pagination shape every API uses", () => {
    const refs = parseLinkHeader(
      '<https://api.example.com/items?page=2>; rel="next", <https://api.example.com/items?page=9>; rel="last"',
    );
    expect(refs.length).toBe(2);
    expect(refs[0]?.uri).toBe("https://api.example.com/items?page=2");
    expect(refs[0]?.rels).toEqual(["next"]);
    expect(refs[1]?.rels).toEqual(["last"]);
  });

  test("a comma inside a quoted parameter does not split the header", () => {
    const refs = parseLinkHeader('<https://x.test/a>; rel="next"; title="one, two"');
    expect(refs.length).toBe(1);
    expect(refs[0]?.params["title"]).toBe("one, two");
  });

  test("handles several space-separated rel values and unquoted parameters", () => {
    const refs = parseLinkHeader('<https://x.test/a>; rel="next alternate"; type=text/html');
    expect(refs[0]?.rels).toEqual(["next", "alternate"]);
    expect(refs[0]?.params["type"]).toBe("text/html");
  });

  test("relTarget finds next, and answers undefined rather than throwing", () => {
    expect(relTarget('<https://x.test/2>; rel="next"', "next")).toBe("https://x.test/2");
    expect(relTarget('<https://x.test/2>; rel="prev"', "next")).toBeUndefined();
    expect(relTarget(null, "next")).toBeUndefined();
    expect(relTarget("garbage", "next")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("jsonpath", () => {
  test("reads dotted keys and bracketed indices", () => {
    const data = { meta: { next: "c2" }, rows: [{ id: 1 }, { id: 2 }] };
    expect(readPath(data, "meta.next")).toBe("c2");
    expect(readPath(data, "rows[1].id")).toBe(2);
    expect(readPath(data, "rows[-1].id")).toBe(2);
  });

  test("a missing segment reads as undefined instead of throwing", () => {
    expect(readPath({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(readPath(null, "a")).toBeUndefined();
  });

  test("a key containing a dot is reachable through brackets", () => {
    expect(readPath({ "a.b": 7 }, '["a.b"]')).toBe(7);
    expect(parsePath("a.b").length).toBe(2);
  });

  test("malformed syntax is an error the tool can report, not a crash", () => {
    expect(() => parsePath("a[")).toThrow(JsonPathError);
    expect(() => parsePath("a[x]")).toThrow(JsonPathError);
    expect(() => parsePath("")).toThrow(JsonPathError);
  });

  test("predicates cover the operators a wait loop actually needs", () => {
    const body = { state: "ready", count: 5, tags: ["a", "b"], nested: { ok: true } };
    expect(matchesPredicate(body, { path: "state", op: "equals", value: "ready" })).toBe(true);
    expect(matchesPredicate(body, { path: "state", op: "notEquals", value: "ready" })).toBe(false);
    expect(matchesPredicate(body, { path: "missing", op: "exists" })).toBe(false);
    expect(matchesPredicate(body, { path: "nested", op: "exists" })).toBe(true);
    expect(matchesPredicate(body, { path: "tags", op: "contains", value: "b" })).toBe(true);
    expect(matchesPredicate(body, { path: "count", op: "gte", value: 5 })).toBe(true);
    expect(matchesPredicate(body, { path: "count", op: "lte", value: 4 })).toBe(false);
  });

  test("equality is structural, so key order in the response does not matter", () => {
    expect(
      matchesPredicate({ a: { x: 1, y: 2 } }, { path: "a", op: "equals", value: { y: 2, x: 1 } }),
    ).toBe(true);
  });

  test("a type mismatch is false rather than an exception", () => {
    expect(matchesPredicate({ n: "5" }, { path: "n", op: "gte", value: 5 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("retry arithmetic", () => {
  test("backoff doubles and clamps, with no jitter to make a run unreproducible", () => {
    expect(backoffDelayMs(0, 100, 5_000)).toBe(100);
    expect(backoffDelayMs(1, 100, 5_000)).toBe(200);
    expect(backoffDelayMs(2, 100, 5_000)).toBe(400);
    expect(backoffDelayMs(20, 100, 5_000)).toBe(5_000);
    expect(backoffDelayMs(0, 100, 5_000)).toBe(backoffDelayMs(0, 100, 5_000));
  });

  test("Retry-After is read as seconds or as an HTTP-date", () => {
    expect(parseRetryAfterMs("5", 0)).toBe(5_000);
    const at = Date.UTC(2030, 0, 1, 0, 0, 30);
    expect(parseRetryAfterMs(new Date(at).toUTCString(), at - 10_000)).toBe(10_000);
    expect(parseRetryAfterMs(new Date(at).toUTCString(), at + 10_000)).toBe(0);
    expect(parseRetryAfterMs(null, 0)).toBeNull();
    expect(parseRetryAfterMs("soon", 0)).toBeNull();
  });

  test("the server's Retry-After wins over the curve", () => {
    const delay = nextDelayMs({
      attempt: 5,
      baseMs: 100,
      maxMs: 60_000,
      retryAfter: "2",
      nowMs: 0,
      remainingMs: 60_000,
    });
    expect(delay).toBe(2_000);
  });

  test("a wait that would eat the whole remaining budget stops the loop instead", () => {
    expect(
      nextDelayMs({
        attempt: 0,
        baseMs: 5_000,
        maxMs: 60_000,
        retryAfter: null,
        nowMs: 0,
        remainingMs: 1_000,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("SSE framing", () => {
  test("an event ends at a blank line and data lines are joined with a newline", () => {
    const event = decodeFrame("event: tick\ndata: one\ndata: two\nid: 7");
    expect(event).toEqual({ event: "tick", data: "one\ntwo", id: "7" });
  });

  test("only one leading space after the colon is stripped", () => {
    expect(decodeFrame("data:  padded")?.data).toBe(" padded");
    expect(decodeFrame("data:tight")?.data).toBe("tight");
  });

  test("a comment-only frame is a keep-alive, not an event", () => {
    expect(decodeFrame(": keep-alive")).toBeNull();
    expect(decodeFrame("")).toBeNull();
  });

  test("the default event name is message, and a field with no colon has an empty value", () => {
    expect(decodeFrame("data: x")?.event).toBe("message");
    expect(decodeFrame("data")?.data).toBe("");
  });

  test("the decoder holds a partial frame back until its blank line arrives", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("data: hel")).toEqual([]);
    expect(decoder.push("lo\n")).toEqual([]);
    const events = decoder.push("\ndata: world\n\n");
    expect(events.map((e) => e.data)).toEqual(["hello", "world"]);
  });

  test("CRLF and bare CR are both terminators", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("data: a\r\n\r\n").map((e) => e.data)).toEqual(["a"]);
  });

  test("a CRLF split across two chunks is one terminator, not a frame boundary", () => {
    const decoder = new SseDecoder();
    // The chunk ends between the CR and the LF. Normalising the lone CR to a
    // newline here and appending the LF next turns one line ending into a
    // blank line, splitting one event in half.
    expect(decoder.push("data: a\r")).toEqual([]);
    expect(decoder.push("\ndata: b\r\n\r\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });

  test("flush yields the last event when the server closed without a blank line", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("data: tail")).toEqual([]);
    expect(decoder.flush().map((e) => e.data)).toEqual(["tail"]);
    expect(decoder.flush()).toEqual([]);
  });

  test("retry is read only when it is a plain integer", () => {
    expect(decodeFrame("retry: 1500\ndata: x")?.retry).toBe(1500);
    expect(decodeFrame("retry: soon\ndata: x")?.retry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("webhook signatures", () => {
  const SECRET = "whsec_test";

  test("the timestamped scheme signs <timestamp>.<body>, not the body alone", () => {
    expect(signedPayload("timestamped", "{}", 1700000000)).toBe("1700000000.{}");
    expect(signedPayload("body", "{}")).toBe("{}");
  });

  test("a signature round-trips through its own header format", () => {
    const signature = hmacHex(SECRET, signedPayload("timestamped", '{"a":1}', 1700000000));
    const header = formatHeader("timestamped", signature, "sha256", 1700000000);
    expect(header).toBe(`t=1700000000,v1=${signature}`);
    expect(
      verifySignature({
        scheme: "timestamped",
        body: '{"a":1}',
        secret: SECRET,
        header,
        nowSeconds: 1700000010,
      }),
    ).toEqual({ valid: true, reason: "signature matches", ageSeconds: 10 });
  });

  test("a stale timestamp is refused even though the HMAC is correct", () => {
    const signature = hmacHex(SECRET, signedPayload("timestamped", "{}", 1700000000));
    const result = verifySignature({
      scheme: "timestamped",
      body: "{}",
      secret: SECRET,
      header: `t=1700000000,v1=${signature}`,
      nowSeconds: 1700000000 + 3600,
      toleranceSeconds: 300,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("replay");
  });

  test("a timestamp far in the future is refused too, not just an old one", () => {
    const signature = hmacHex(SECRET, signedPayload("timestamped", "{}", 1700009999));
    const result = verifySignature({
      scheme: "timestamped",
      body: "{}",
      secret: SECRET,
      header: `t=1700009999,v1=${signature}`,
      nowSeconds: 1700000000,
      toleranceSeconds: 300,
    });
    expect(result.valid).toBe(false);
  });

  test("a body-scheme signature round-trips and rejects a tampered payload", () => {
    const signature = hmacHex(SECRET, "payload");
    const header = formatHeader("body", signature, "sha256");
    expect(header).toBe(`sha256=${signature}`);
    expect(verifySignature({ scheme: "body", body: "payload", secret: SECRET, header }).valid).toBe(
      true,
    );
    expect(
      verifySignature({ scheme: "body", body: "payload!", secret: SECRET, header }).valid,
    ).toBe(false);
  });

  test("several rotated signatures in one header: any match is enough", () => {
    const good = hmacHex(SECRET, signedPayload("timestamped", "{}", 1700000000));
    const header = `t=1700000000,v1=${"0".repeat(64)},v1=${good}`;
    expect(parseSignatureHeader("timestamped", header).signatures.length).toBe(2);
    expect(
      verifySignature({
        scheme: "timestamped",
        body: "{}",
        secret: SECRET,
        header,
        nowSeconds: 1700000000,
      }).valid,
    ).toBe(true);
  });

  test("a header declaring a different algorithm is refused rather than coerced", () => {
    const signature = hmacHex(SECRET, "payload", "sha1");
    const result = verifySignature({
      scheme: "body",
      body: "payload",
      secret: SECRET,
      header: `sha1=${signature}`,
      algorithm: "sha256",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("sha1");
  });

  test("a header with no signature value at all is refused", () => {
    expect(
      verifySignature({
        scheme: "timestamped",
        body: "{}",
        secret: SECRET,
        header: "t=1",
        nowSeconds: 1,
      }).valid,
    ).toBe(false);
  });

  test("timingSafeEqualHex matches only identical hex and never throws on junk", () => {
    expect(timingSafeEqualHex("ab", "ab")).toBe(true);
    expect(timingSafeEqualHex("ab", "AB")).toBe(true);
    expect(timingSafeEqualHex("ab", "ac")).toBe(false);
    expect(timingSafeEqualHex("ab", "abcd")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(false);
    expect(timingSafeEqualHex("zz", "zz")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("xml", () => {
  test("reads elements, attributes, nesting and CDATA", () => {
    const root = parseXml(
      '<?xml version="1.0"?><root a="1"><child>hi</child><child><![CDATA[<raw>]]></child></root>',
    );
    expect(root.name).toBe("root");
    expect(root.attrs["a"]).toBe("1");
    expect(childrenNamed(root, "child").length).toBe(2);
    expect(textOf(root, "child")).toBe("hi");
    expect(childrenNamed(root, "child")[1]?.text).toBe("<raw>");
  });

  test("namespace prefixes are dropped from element and attribute names", () => {
    const root = parseXml('<atom:feed xmlns:atom="x"><atom:title>T</atom:title></atom:feed>');
    expect(root.name).toBe("feed");
    expect(textOf(root, "title")).toBe("T");
  });

  test("self-closing tags do not swallow their siblings", () => {
    const root = parseXml('<r><link href="a"/><title>T</title></r>');
    expect(childrenNamed(root, "link")[0]?.attrs["href"]).toBe("a");
    expect(textOf(root, "title")).toBe("T");
  });

  test("predefined and numeric entities decode; an unknown entity stays literal", () => {
    expect(decodeXmlText("a &amp; b &lt;c&gt; &#65; &#x42;")).toBe("a & b <c> A B");
    expect(decodeXmlText("&xxe;")).toBe("&xxe;");
  });

  test("an entity declaration is refused outright — this is the XXE gate", () => {
    expect(() =>
      parseXml('<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><r>&xxe;</r>'),
    ).toThrow(XmlParseError);
    expect(() => parseXml("<!DOCTYPE r [ <!ELEMENT r ANY> ]><r/>")).toThrow(XmlParseError);
  });

  test("a document with no root element is an error, not an empty node", () => {
    expect(() => parseXml("   ")).toThrow(XmlParseError);
  });

  test("comments and processing instructions are skipped", () => {
    const root = parseXml("<r><!-- note --><a>1</a></r>");
    expect(textOf(root, "a")).toBe("1");
  });
});

describe("parseSitemap", () => {
  const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.test/b</loc><lastmod>2026-01-02</lastmod><priority>0.8</priority><changefreq>daily</changefreq></url>
  <url><loc>https://x.test/a</loc></url>
  <url><lastmod>2026-01-03</lastmod></url>
</urlset>`;

  test("entries come back sorted by loc, so the same document always reads the same", () => {
    const result = parseSitemap(URLSET);
    expect(result.kind).toBe("urlset");
    expect(result.entries.map((e) => e.loc)).toEqual(["https://x.test/a", "https://x.test/b"]);
  });

  test("optional fields are carried through, and a member with no loc is dropped", () => {
    const entry = parseSitemap(URLSET).entries[1];
    expect(entry).toEqual({
      loc: "https://x.test/b",
      lastmod: "2026-01-02",
      changefreq: "daily",
      priority: 0.8,
    });
    expect(parseSitemap(URLSET).entries.length).toBe(2);
  });

  test("an out-of-range priority or unknown changefreq is dropped rather than echoed", () => {
    const entry = parseSitemap(
      "<urlset><url><loc>https://x.test/a</loc><priority>9</priority><changefreq>sometimes</changefreq></url></urlset>",
    ).entries[0];
    expect(entry).toEqual({ loc: "https://x.test/a" });
  });

  test("an index is reported as an index, not silently treated as a page list", () => {
    const result = parseSitemap(
      "<sitemapindex><sitemap><loc>https://x.test/s1.xml</loc></sitemap></sitemapindex>",
    );
    expect(result.kind).toBe("sitemapindex");
    expect(result.entries[0]?.loc).toBe("https://x.test/s1.xml");
  });

  test("a document that is not a sitemap is a readable error", () => {
    expect(() => parseSitemap("<html><body/></html>")).toThrow(/urlset/);
  });
});

describe("parseFeed", () => {
  test("RSS maps guid, pubDate and description onto the common shape", () => {
    const result = parseFeed(`<rss version="2.0"><channel>
      <title>Chan</title><link>https://x.test</link><description>d</description>
      <item><title>Second</title><link>https://x.test/2</link><guid>g2</guid><pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate><description>two</description><category>rel</category></item>
      <item><title>First</title><link>https://x.test/1</link></item>
    </channel></rss>`);
    expect(result.kind).toBe("rss");
    expect(result.title).toBe("Chan");
    expect(result.entries.map((e) => e.title)).toEqual(["Second", "First"]);
    expect(result.entries[0]).toEqual({
      id: "g2",
      title: "Second",
      link: "https://x.test/2",
      published: "Tue, 02 Jan 2026 00:00:00 GMT",
      summary: "two",
      categories: ["rel"],
    });
  });

  test("an RSS item with no guid falls back to its link as the id", () => {
    const result = parseFeed(
      "<rss><channel><item><link>https://x.test/1</link></item></channel></rss>",
    );
    expect(result.entries[0]?.id).toBe("https://x.test/1");
  });

  test("Atom reads the href attribute, preferring rel=alternate", () => {
    const result = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom">
      <title>F</title>
      <entry><id>urn:1</id><title>E</title>
        <link rel="edit" href="https://x.test/edit"/>
        <link rel="alternate" href="https://x.test/post"/>
        <updated>2026-01-02T00:00:00Z</updated><summary>s</summary>
        <author><name>Ada</name></author>
      </entry>
    </feed>`);
    expect(result.kind).toBe("atom");
    expect(result.entries[0]).toEqual({
      id: "urn:1",
      title: "E",
      link: "https://x.test/post",
      updated: "2026-01-02T00:00:00Z",
      summary: "s",
      authors: ["Ada"],
    });
  });

  test("document order is preserved — the feed's order is the signal", () => {
    const source = "<feed><entry><title>a</title></entry><entry><title>b</title></entry></feed>";
    expect(parseFeed(source).entries.map((e) => e.title)).toEqual(["a", "b"]);
    expect(parseFeed(source)).toEqual(parseFeed(source));
  });

  test("something that is neither RSS nor Atom is a readable error", () => {
    expect(() => parseFeed("<html><body/></html>")).toThrow(/not an RSS or Atom feed/);
  });
});

// ---------------------------------------------------------------------------

describe("robots.txt", () => {
  const ROBOTS = `# comment
User-agent: *
Disallow: /private/
Allow: /private/public/
Crawl-delay: 2

User-agent: CrewhausBot
Disallow: /
Allow: /docs/

Sitemap: https://x.test/sitemap.xml
Sitemap: https://x.test/a.xml`;

  test("groups, rules, crawl-delay and file-wide sitemaps all parse", () => {
    const file = parseRobots(ROBOTS);
    expect(file.groups.length).toBe(2);
    expect(file.groups[0]?.agents).toEqual(["*"]);
    expect(file.groups[0]?.crawlDelay).toBe(2);
    expect(file.sitemaps).toEqual(["https://x.test/sitemap.xml", "https://x.test/a.xml"]);
  });

  test("consecutive user-agent lines share the group that follows them", () => {
    const file = parseRobots("User-agent: a\nUser-agent: b\nDisallow: /x");
    expect(file.groups.length).toBe(1);
    expect(file.groups[0]?.agents).toEqual(["a", "b"]);
  });

  test("the most specific agent group wins over the wildcard", () => {
    const file = parseRobots(ROBOTS);
    expect(selectGroup(file, "CrewhausBot/1.0")?.agents).toEqual(["crewhausbot"]);
    expect(selectGroup(file, "SomeOtherBot")?.agents).toEqual(["*"]);
  });

  test("longest match decides, and a tie goes to Allow", () => {
    const file = parseRobots(ROBOTS);
    expect(evaluateRobots(file, "AnyBot", "/private/x").allowed).toBe(false);
    expect(evaluateRobots(file, "AnyBot", "/private/public/x").allowed).toBe(true);
    expect(evaluateRobots(file, "AnyBot", "/open").allowed).toBe(true);
    const tie = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a");
    expect(evaluateRobots(tie, "AnyBot", "/a").allowed).toBe(true);
  });

  test("the specific group's rules apply, not the wildcard's", () => {
    const file = parseRobots(ROBOTS);
    expect(evaluateRobots(file, "CrewhausBot", "/anything").allowed).toBe(false);
    expect(evaluateRobots(file, "CrewhausBot", "/docs/a").allowed).toBe(true);
    expect(evaluateRobots(file, "CrewhausBot", "/anything").crawlDelay).toBeUndefined();
  });

  test("an empty Disallow allows everything", () => {
    const file = parseRobots("User-agent: *\nDisallow:");
    expect(evaluateRobots(file, "AnyBot", "/whatever").allowed).toBe(true);
  });

  test("wildcards and the $ end-anchor behave as crawlers expect", () => {
    expect(pathMatches("/a/*/c", "/a/b/c")).toBe(true);
    expect(pathMatches("/*.pdf$", "/docs/f.pdf")).toBe(true);
    expect(pathMatches("/*.pdf$", "/docs/f.pdf?x=1")).toBe(false);
    expect(pathMatches("/a", "/ab")).toBe(true);
    expect(pathMatches("/a$", "/ab")).toBe(false);
  });

  test("an anchored pattern matches when the wildcard has to give ground", () => {
    // `*` is greedy-or-not as needed: the literal after it has to land on the
    // END of the path, which means the earliest occurrence is often the wrong
    // one. A left-to-right scan answers "no" here and reports a disallowed
    // path as crawlable.
    expect(pathMatches("/*.php$", "/a.php/b.php")).toBe(true);
    expect(pathMatches("/a*b$", "/axxbyb")).toBe(true);
    expect(pathMatches("/*.php$", "/a.php/b.html")).toBe(false);
    expect(pathMatches("/*$", "/anything")).toBe(true);
    expect(pathMatches("/x$", "/x")).toBe(true);
    // The anchored literal must still fit after everything before it matched.
    expect(pathMatches("/aa*aa$", "/aaa")).toBe(false);
  });

  test("a Disallow a crawler would trip over is not silently read as Allow", () => {
    const file = parseRobots("User-agent: *\nDisallow: /*.php$");
    expect(evaluateRobots(file, "AnyBot", "/index.php/extra.php").allowed).toBe(false);
    expect(evaluateRobots(file, "AnyBot", "/index.php/extra.html").allowed).toBe(true);
  });

  test("a file with no matching group allows everything", () => {
    expect(evaluateRobots(parseRobots(""), "AnyBot", "/x").allowed).toBe(true);
    expect(
      evaluateRobots(parseRobots("User-agent: OnlyOther\nDisallow: /"), "AnyBot", "/x").allowed,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("certificate shaping", () => {
  test("a distinguished name renders in conventional order, extras sorted after", () => {
    expect(formatDn({ C: "US", CN: "x.test", O: "Example", Zed: "z" })).toBe(
      "CN=x.test, O=Example, C=US, Zed=z",
    );
    expect(formatDn(undefined)).toBe("");
  });

  test("SANs are split and sorted so two reads of one certificate agree", () => {
    expect(parseSubjectAltNames("DNS:b.test, DNS:a.test, IP Address:1.2.3.4")).toEqual([
      "DNS:a.test",
      "DNS:b.test",
      "IP Address:1.2.3.4",
    ]);
    expect(parseSubjectAltNames(undefined)).toEqual([]);
  });

  test("daysRemaining floors, and goes negative once expired", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(daysRemaining("Jan 11 00:00:00 2026 GMT", now)).toBe(10);
    expect(daysRemaining("Dec 31 00:00:00 2025 GMT", now)).toBe(-1);
    expect(daysRemaining("not a date", now)).toBeUndefined();
    expect(daysRemaining(undefined, now)).toBeUndefined();
  });

  test("the summary carries an expired flag rather than making the caller subtract", () => {
    const summary = summarizeCert(
      {
        subject: { CN: "x.test" },
        issuer: { CN: "CA" },
        valid_from: "Jan 1 00:00:00 2025 GMT",
        valid_to: "Jan 1 00:00:00 2025 GMT",
        subjectaltname: "DNS:x.test",
        fingerprint256: "AA:BB",
      },
      Date.UTC(2026, 0, 1),
    );
    expect(summary["subject"]).toBe("CN=x.test");
    expect(summary["expired"]).toBe(true);
    expect(summary["subjectAltNames"]).toEqual(["DNS:x.test"]);
  });
});
