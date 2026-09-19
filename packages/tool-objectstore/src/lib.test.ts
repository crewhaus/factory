/**
 * The arithmetic, on its own.
 *
 * The signature tests are pinned to AWS's own published values — the
 * `aws-sig-v4-test-suite` cases and the worked examples in the "Signing AWS
 * API requests" documentation — and they are pinned as literals rather than
 * recomputed, so a change to this package's encoder or canonicalization moves
 * a byte and the test says so. That is the point of a golden vector: if these
 * ever have to be "updated", the fix is in the code.
 *
 * The encoder tests do not come from a file. They are derived from the rule
 * itself (RFC 3986 §2.3: unreserved is `A-Z a-z 0-9 - _ . ~`, everything else
 * is `%XX` over the UTF-8 bytes), which is checkable by hand — including the
 * five characters `encodeURIComponent` gets wrong.
 */
import { describe, expect, test } from "bun:test";
import { canonicalQuery, encodePath, encodeRfc3986, utf8Length } from "./lib/encode";
import {
  MAX_METADATA_BYTES,
  checkHeaderValue,
  checkOperationFields,
  metadataHeaders,
  responseOverrides,
} from "./lib/request";
import {
  amzTimestamps,
  canonicalHeaderValue,
  canonicalRequest,
  credentialScope,
  presign,
  sign,
  signedHeaderList,
  signingKey,
  stringToSign,
} from "./lib/sigv4";
import { checkBucket, checkKey, parseEndpoint, resolveTarget } from "./lib/store";

/** The credentials AWS publishes in its own examples. Not a real key. */
const DOC_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const DOC_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
/** The test-suite pair differs from the doc pair by one character: + not /. */
const SUITE_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("encodeRfc3986", () => {
  test("the unreserved set passes through untouched", () => {
    const unreserved = "ABCXYZabcxyz0189-_.~";
    expect(encodeRfc3986(unreserved)).toBe(unreserved);
  });

  test("encodes the five characters encodeURIComponent leaves alone", () => {
    // This is the trap the whole package is built around: encodeURIComponent
    // is the obvious choice, and it produces a URL that 403s with no clue.
    const risky = "!'()*";
    expect(encodeRfc3986(risky)).toBe("%21%27%28%29%2A");
    expect(encodeURIComponent(risky)).toBe(risky);
    expect(encodeRfc3986(risky)).not.toBe(encodeURIComponent(risky));
  });

  test("a space is %20 and a plus is %2B", () => {
    // The `+` matters twice over: form encoding would make it a space, and a
    // key that really contains `+` must arrive as `+`, not as a space.
    expect(encodeRfc3986("a b+c")).toBe("a%20b%2Bc");
  });

  test("hex digits are uppercase", () => {
    expect(encodeRfc3986("?&=/:")).toBe("%3F%26%3D%2F%3A");
    expect(encodeRfc3986("£")).toBe("%C2%A3");
  });

  test("non-ASCII is encoded per UTF-8 byte, surrogate pairs included", () => {
    expect(encodeRfc3986("日")).toBe("%E6%97%A5"); // U+65E5, three bytes
    expect(encodeRfc3986("é")).toBe("%C3%A9"); // U+00E9, two bytes
    expect(encodeRfc3986("😀")).toBe("%F0%9F%98%80"); // U+1F600, four bytes
  });

  test("the empty string encodes to the empty string", () => {
    expect(encodeRfc3986("")).toBe("");
  });

  test("a percent sign is itself encoded, so encoding is not idempotent", () => {
    // Encoding twice is how a non-S3 service's canonical URI is built, and
    // doing it to S3 signs a path nobody will request.
    expect(encodeRfc3986("100%")).toBe("100%25");
    expect(encodeRfc3986(encodeRfc3986("a b"))).toBe("a%2520b");
  });
});

describe("encodePath", () => {
  test("encodes each segment and keeps the separators", () => {
    expect(encodePath("reports/q1 2026/summary+final.pdf")).toBe(
      "reports/q1%202026/summary%2Bfinal.pdf",
    );
  });

  test("double encoding is available for the services that need it", () => {
    expect(encodePath("a b/c", { doubleEncode: true })).toBe("a%2520b/c");
  });

  test("a key with every awkward character survives one round", () => {
    expect(encodePath("föö/q&a (2026)/notes!.txt")).toBe(
      "f%C3%B6%C3%B6/q%26a%20%282026%29/notes%21.txt",
    );
  });
});

describe("canonicalQuery", () => {
  test("encodes the value, slashes included", () => {
    expect(canonicalQuery([["X-Amz-Credential", "AKID/20130524/us-east-1/s3/aws4_request"]])).toBe(
      "X-Amz-Credential=AKID%2F20130524%2Fus-east-1%2Fs3%2Faws4_request",
    );
  });

  test("sorts AFTER encoding, which is not the same as sorting before", () => {
    // `-` (0x2D) sorts before `?` (0x3F) raw. Encoded, `?` becomes `%3F` and
    // `%` is 0x25, so the order inverts. Sorting first and encoding second
    // would emit these the other way round and every signature would be wrong
    // for exactly the keys that contain punctuation.
    const raw = ["a-b", "a?b"].sort();
    expect(raw).toEqual(["a-b", "a?b"]);
    expect(
      canonicalQuery([
        ["a-b", "1"],
        ["a?b", "2"],
      ]),
    ).toBe("a%3Fb=2&a-b=1");
  });

  test("duplicate names are ordered by their encoded value", () => {
    expect(
      canonicalQuery([
        ["k", "b"],
        ["k", "a"],
      ]),
    ).toBe("k=a&k=b");
  });

  test("no parameters is the empty string, which is a line the canonical request still has", () => {
    expect(canonicalQuery([])).toBe("");
  });
});

describe("utf8Length", () => {
  test("counts bytes, not characters — which is what S3's 1024 limit means", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
    expect("😀".length).toBe(2);
  });
});

describe("signing key derivation", () => {
  test("matches AWS's published derivation example", () => {
    // AWS, "Signing AWS API requests" — worked example for
    // iam / us-east-1 / 20120215. Any change to the HMAC chain moves this.
    expect(signingKey(SUITE_SECRET, "20120215", "us-east-1", "iam").toString("hex")).toBe(
      "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
    );
  });

  test("the scope string is the one the credential carries", () => {
    expect(credentialScope("20130524", "us-east-1", "s3")).toBe(
      "20130524/us-east-1/s3/aws4_request",
    );
  });
});

describe("amzTimestamps", () => {
  test("formats the basic-ISO instant and its date stamp", () => {
    expect(amzTimestamps(Date.parse("2013-05-24T00:00:00Z"))).toEqual({
      amzDate: "20130524T000000Z",
      dateStamp: "20130524",
    });
  });

  test("truncates sub-second precision rather than rounding it up", () => {
    // Rounding up would place the timestamp in the future, which a store
    // enforcing clock skew can refuse outright.
    expect(amzTimestamps(Date.parse("2013-05-24T00:00:00Z") + 999).amzDate).toBe(
      "20130524T000000Z",
    );
  });

  test("refuses an instant that is not a number", () => {
    expect(() => amzTimestamps(Number.NaN)).toThrow(/finite/);
  });

  test("refuses an instant whose year does not fit X-Amz-Date, rather than signing it", () => {
    // `toISOString` only throws outside ±8.64e15. In between there are years
    // that do not fit four digits, and for those it switches to the EXPANDED
    // form `+010000-01-01T00:00:00.000Z` — which slices into an X-Amz-Date of
    // `+0100000101T0000Z` and a credential scope of `+0100000/...`. That is a
    // correctly-signed URL over nonsense: no store will ever take it, and the
    // 403 will not say why.
    const year10000 = Date.parse("+010000-01-01T00:00:00Z");
    expect(Number.isFinite(year10000)).toBe(true);
    expect(() => amzTimestamps(year10000)).toThrow(/outside the years 0000-9999/);
    expect(() => amzTimestamps(8.64e15)).toThrow(/outside the years 0000-9999/);
    // The four-digit years on either side of the ordinary range still sign.
    expect(amzTimestamps(Date.parse("9999-12-31T23:59:59Z")).amzDate).toBe("99991231T235959Z");
    expect(amzTimestamps(Date.parse("0001-01-01T00:00:00Z")).amzDate).toBe("00010101T000000Z");
  });
});

describe("canonical headers", () => {
  test("trims the ends and collapses internal whitespace, as the spec says", () => {
    expect(canonicalHeaderValue("  value1  value2     value3 ")).toBe("value1 value2 value3");
  });

  test("matches the aws-sig-v4-test-suite get-header-value-trim canonical request", () => {
    const creq = canonicalRequest({
      method: "POST",
      canonicalUri: "/",
      query: [],
      headers: [
        ["Host", "example.amazonaws.com"],
        ["My-Header1", " value1  value2     value3"],
        ["X-Amz-Date", "20150830T123600Z"],
      ],
      payloadHash: EMPTY_SHA256,
    });
    expect(creq.text).toBe(
      [
        "POST",
        "/",
        "",
        "host:example.amazonaws.com",
        "my-header1:value1 value2 value3",
        "x-amz-date:20150830T123600Z",
        "",
        "host;my-header1;x-amz-date",
        EMPTY_SHA256,
      ].join("\n"),
    );
  });

  test("the signed-header list is lowercased, sorted and semicolon-joined", () => {
    expect(
      signedHeaderList([
        ["X-Amz-Meta-Owner", "ops"],
        ["Host", "h"],
        ["Content-Type", "text/plain"],
      ]),
    ).toBe("content-type;host;x-amz-meta-owner");
  });
});

describe("aws-sig-v4-test-suite: get-vanilla", () => {
  // The suite's simplest case, carried end to end. It uses the header-based
  // form, so it exercises the canonical request, the string to sign and the
  // signature — everything the presigner uses except the query assembly.
  const creq = canonicalRequest({
    method: "GET",
    canonicalUri: "/",
    query: [],
    headers: [
      ["Host", "example.amazonaws.com"],
      ["X-Amz-Date", "20150830T123600Z"],
    ],
    payloadHash: EMPTY_SHA256,
  });
  const sts = stringToSign({
    amzDate: "20150830T123600Z",
    scope: credentialScope("20150830", "us-east-1", "service"),
    canonicalRequest: creq.text,
  });

  test("the canonical request is byte-for-byte the suite's .creq", () => {
    expect(creq.text).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        EMPTY_SHA256,
      ].join("\n"),
    );
  });

  test("the string to sign is the suite's .sts", () => {
    expect(sts).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/service/aws4_request",
        "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
      ].join("\n"),
    );
  });

  test("the signature is the suite's .authz signature", () => {
    expect(
      sign({
        secretAccessKey: SUITE_SECRET,
        dateStamp: "20150830",
        region: "us-east-1",
        service: "service",
        stringToSign: sts,
      }),
    ).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });
});

describe("presign", () => {
  const docExample = () =>
    presign({
      method: "GET",
      origin: "https://examplebucket.s3.amazonaws.com",
      host: "examplebucket.s3.amazonaws.com",
      canonicalUri: "/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: DOC_KEY_ID,
      secretAccessKey: DOC_SECRET,
      epochMs: Date.parse("2013-05-24T00:00:00Z"),
      expiresInSeconds: 86400,
    });

  test("reproduces AWS's published presigned GET Object example exactly", () => {
    // AWS, "Signing and authenticating REST requests" — Example: Query
    // parameter authentication, GET Object. URL, canonical request, string to
    // sign and signature all come from that page.
    const result = docExample();
    expect(result.canonicalRequest).toBe(
      [
        "GET",
        "/test.txt",
        "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host",
        "host:examplebucket.s3.amazonaws.com",
        "",
        "host",
        "UNSIGNED-PAYLOAD",
      ].join("\n"),
    );
    expect(result.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20130524T000000Z",
        "20130524/us-east-1/s3/aws4_request",
        "3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04",
      ].join("\n"),
    );
    expect(result.signature).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(result.url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  test("a one-second difference in the signing instant changes the signature", () => {
    const later = presign({
      method: "GET",
      origin: "https://examplebucket.s3.amazonaws.com",
      host: "examplebucket.s3.amazonaws.com",
      canonicalUri: "/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: DOC_KEY_ID,
      secretAccessKey: DOC_SECRET,
      epochMs: Date.parse("2013-05-24T00:00:01Z"),
      expiresInSeconds: 86400,
    });
    expect(later.signature).not.toBe(docExample().signature);
  });

  test("the session token is signed into the query, not sent as a header", () => {
    // Query-string authentication differs from the header form here, and
    // getting it wrong by analogy produces a URL that 403s with
    // "InvalidToken" or nothing useful at all.
    const result = presign({
      method: "PUT",
      origin: "https://b.s3.amazonaws.com",
      host: "b.s3.amazonaws.com",
      canonicalUri: "/k",
      region: "us-east-1",
      service: "s3",
      accessKeyId: DOC_KEY_ID,
      secretAccessKey: DOC_SECRET,
      sessionToken: "tok/en+value",
      epochMs: Date.parse("2013-05-24T00:00:00Z"),
      expiresInSeconds: 60,
    });
    expect(result.url).toContain("X-Amz-Security-Token=tok%2Fen%2Bvalue");
    expect(result.signedHeaders).toBe("host");
    expect(result.canonicalRequest).toContain("X-Amz-Security-Token=tok%2Fen%2Bvalue");
  });

  test("an extra signed header lands in SignedHeaders in both places it appears", () => {
    const result = presign({
      method: "PUT",
      origin: "https://b.s3.amazonaws.com",
      host: "b.s3.amazonaws.com",
      canonicalUri: "/k",
      region: "us-east-1",
      service: "s3",
      accessKeyId: DOC_KEY_ID,
      secretAccessKey: DOC_SECRET,
      epochMs: Date.parse("2013-05-24T00:00:00Z"),
      expiresInSeconds: 60,
      headers: [["Content-Type", "application/pdf"]],
    });
    expect(result.signedHeaders).toBe("content-type;host");
    expect(result.url).toContain("X-Amz-SignedHeaders=content-type%3Bhost");
    expect(result.canonicalRequest).toContain("content-type:application/pdf");
  });

  test("the secret is in no part of the result", () => {
    const result = docExample();
    const everything = JSON.stringify(result);
    expect(everything.includes(DOC_SECRET)).toBe(false);
    // The access key ID is a different matter: SigV4 requires it in the URL.
    expect(result.url).toContain(DOC_KEY_ID);
  });

  test("X-Amz-Signature is excluded from the canonical query it signs", () => {
    const result = docExample();
    expect(result.canonicalRequest).not.toContain("X-Amz-Signature");
    expect(result.url).toContain("X-Amz-Signature=");
  });
});

describe("parseEndpoint", () => {
  test("drops a default port and keeps a non-default one", () => {
    // A Host header of "…:443" signs fine and then fails, because clients
    // omit the default port and the store canonicalizes what it received.
    expect(parseEndpoint("https://s3.amazonaws.com:443").host).toBe("s3.amazonaws.com");
    expect(parseEndpoint("http://127.0.0.1:9000").host).toBe("127.0.0.1:9000");
  });

  test("lowercases the host and punycodes an international one", () => {
    expect(parseEndpoint("https://S3.Example.COM").host).toBe("s3.example.com");
    expect(parseEndpoint("https://例え.jp").hostname).toBe("xn--r8jz45g.jp");
  });

  test("refuses a scheme that is not http or https", () => {
    expect(() => parseEndpoint("ftp://files.example.com")).toThrow(/http or https/);
  });

  test("refuses plain http to anywhere but loopback, and says why", () => {
    expect(() => parseEndpoint("http://minio.example.com")).toThrow(/bearer credential/);
    expect(parseEndpoint("http://localhost:9000").isLoopback).toBe(true);
  });

  test("a hostname that merely BEGINS with 127. is not loopback", () => {
    // `127.0.0.1.evil.example` is a registered domain somebody else owns. A
    // prefix match on the hostname text called it loopback, which is the only
    // exemption from the plain-http refusal — so a bearer credential for the
    // object, and the object, went out in clear to an attacker-chosen host.
    expect(() => parseEndpoint("http://127.0.0.1.evil.example")).toThrow(/bearer credential/);
    expect(() => parseEndpoint("http://127.example.com")).toThrow(/bearer credential/);
    expect(parseEndpoint("https://127.0.0.1.evil.example").isLoopback).toBe(false);
  });

  test("the real loopback forms still pass, in every spelling the parser normalizes", () => {
    for (const raw of [
      "http://127.0.0.1:9000",
      "http://127.5.5.5:9000",
      "http://0x7f000001:9000",
      "http://127.1:9000",
      "http://localhost:9000",
      "http://minio.localhost:9000",
      "http://[::1]:9000",
    ]) {
      expect({ raw, loopback: parseEndpoint(raw).isLoopback }).toEqual({ raw, loopback: true });
    }
  });

  test("a refusal never echoes credentials that were in the endpoint", () => {
    // Both of these checks run BEFORE the one that refuses embedded
    // credentials — a bad port never reaches the parser, and a wrong scheme
    // is caught first — so both used to quote the secret straight back into
    // an error message, which is the one string guaranteed to be copied on.
    const leaked = "wJalrXUtnFEMI-CANARY-SECRET";
    for (const raw of [
      `ftp://AKIAIOSFODNN7EXAMPLE:${leaked}@files.example.com`,
      `https://AKIAIOSFODNN7EXAMPLE:${leaked}@s3.example.com:99999`,
      `https://AKIAIOSFODNN7EXAMPLE:${leaked}@s3.example.com/prefix`,
      `https://AKIAIOSFODNN7EXAMPLE:${leaked}@s3.example.com?x=1`,
      `http://AKIAIOSFODNN7EXAMPLE:${leaked}@minio.example.com`,
    ]) {
      const message = ((): string => {
        try {
          parseEndpoint(raw);
          return "";
        } catch (err) {
          return `${(err as Error).message}\n${(err as Error).stack ?? ""}`;
        }
      })();
      expect({ raw: raw.replace(leaked, "…"), refused: message !== "" }).toEqual({
        raw: raw.replace(leaked, "…"),
        refused: true,
      });
      expect({ raw: raw.replace(leaked, "…"), leaked: message.includes(leaked) }).toEqual({
        raw: raw.replace(leaked, "…"),
        leaked: false,
      });
    }
    // The other shape: a whole presigned URL pasted into the endpoint field,
    // whose query carries a signature and, on temporary credentials, a live
    // session token.
    const pasted =
      "https://b.s3.amazonaws.com/k?X-Amz-Security-Token=LIVE-TOKEN-CANARY&X-Amz-Signature=deadbeef";
    const queryMessage = ((): string => {
      try {
        parseEndpoint(pasted);
        return "";
      } catch (err) {
        return `${(err as Error).message}\n${(err as Error).stack ?? ""}`;
      }
    })();
    expect(queryMessage).not.toContain("LIVE-TOKEN-CANARY");
    expect(queryMessage).not.toContain("deadbeef");
    expect(queryMessage).toContain("b.s3.amazonaws.com");

    // The two branches that quote the endpoint back still say WHICH endpoint
    // they refused — the redaction takes out the userinfo, not the message.
    expect(() => parseEndpoint(`ftp://key:${leaked}@files.example.com`)).toThrow(
      /<redacted>@files\.example\.com" uses ftp:/,
    );
    expect(() => parseEndpoint(`https://key:${leaked}@s3.example.com:99999`)).toThrow(
      /<redacted>@s3\.example\.com:99999" is not a URL/,
    );
  });

  test("refuses a path on the endpoint rather than guessing where it goes", () => {
    expect(() => parseEndpoint("https://gw.example.com/s3")).toThrow(/has a path/);
  });

  test("refuses a query, a fragment or embedded credentials", () => {
    expect(() => parseEndpoint("https://s3.example.com?x=1")).toThrow(/query string or fragment/);
    expect(() => parseEndpoint("https://user:pw@s3.example.com")).toThrow(/username or password/);
  });

  test("refuses something that is not a URL at all", () => {
    expect(() => parseEndpoint("s3.example.com")).toThrow(/is not a URL/);
  });
});

describe("checkBucket", () => {
  test("accepts a conforming name in either style", () => {
    expect(checkBucket("my-bucket", "virtual-hosted")).toEqual([]);
    expect(checkBucket("my-bucket", "path")).toEqual([]);
  });

  test("refuses a name that cannot be a DNS label in virtual-hosted style", () => {
    expect(() => checkBucket("My_Bucket", "virtual-hosted")).toThrow(/cannot be a DNS label/);
    expect(() => checkBucket("ab", "virtual-hosted")).toThrow(/cannot be a DNS label/);
  });

  test("allows the same legacy name path-style, with a warning that says why", () => {
    const warnings = checkBucket("My_Bucket", "path");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("path-style");
  });

  test("warns about a dotted bucket in virtual-hosted style over TLS", () => {
    const warnings = checkBucket("logs.example.com", "virtual-hosted");
    expect(warnings[0]).toContain("certificate");
  });

  test("refuses a bucket that is really a path", () => {
    expect(() => checkBucket("bucket/prefix", "path")).toThrow(/contains "\/"/);
  });

  test("refuses a one-character bucket that is a dot segment", () => {
    // A `bucket.length > 1` guard used to skip the path-segment check
    // entirely, so "." sailed through and path style signed "/./key" — the
    // dot segment `checkKey` exists to refuse, arriving through the other
    // field. Clients resolve it away before sending, so the signature covers
    // a path that never arrives.
    expect(() => checkBucket(".", "path")).toThrow(/usable path segment/);
    expect(() => checkBucket("-", "path")).toThrow(/usable path segment/);
    expect(() => checkBucket("_", "path")).toThrow(/usable path segment/);
    // A single alphanumeric is still only a naming-rule warning, not a path
    // hazard, so it stays allowed.
    expect(checkBucket("a", "path").length).toBe(1);
  });
});

describe("checkKey", () => {
  test("accepts an ordinary key", () => {
    expect(() => checkKey("reports/2026/q1.pdf")).not.toThrow();
  });

  test("refuses a dot segment, because clients resolve it before sending", () => {
    expect(() => checkKey("a/../b.txt")).toThrow(/resolve those before sending/);
    expect(() => checkKey("./b.txt")).toThrow(/resolve those before sending/);
  });

  test("refuses a leading slash and an empty segment", () => {
    expect(() => checkKey("/a.txt")).toThrow(/starts with/);
    expect(() => checkKey("a//b.txt")).toThrow(/empty path segment/);
  });

  test("refuses a control character in the key", () => {
    expect(() => checkKey("a\r\nb")).toThrow(/control character U\+000D/);
  });

  test("measures the 1024 limit in bytes, so a non-ASCII key reaches it sooner", () => {
    const ascii = "a".repeat(1024);
    expect(() => checkKey(ascii)).not.toThrow();
    expect(() => checkKey(`${ascii}a`)).toThrow(/1024 bytes/);
    // 400 three-byte characters is 1200 bytes but only 400 characters.
    expect(() => checkKey("日".repeat(400))).toThrow(/1200 bytes/);
  });

  test("refuses an empty key", () => {
    expect(() => checkKey("")).toThrow(/empty/);
  });
});

describe("resolveTarget", () => {
  const endpoint = parseEndpoint("https://s3.us-east-1.amazonaws.com");

  test("the two styles sign different requests from the same inputs", () => {
    const virtual = resolveTarget({
      endpoint,
      style: "virtual-hosted",
      bucket: "docs",
      key: "k.txt",
    });
    const path = resolveTarget({ endpoint, style: "path", bucket: "docs", key: "k.txt" });
    expect(virtual).toMatchObject({
      host: "docs.s3.us-east-1.amazonaws.com",
      canonicalUri: "/k.txt",
    });
    expect(path).toMatchObject({
      host: "s3.us-east-1.amazonaws.com",
      canonicalUri: "/docs/k.txt",
    });
    // Both the Host header and the path move, which is why the style cannot
    // be inferred and cannot be corrected by the server.
    expect(virtual.host).not.toBe(path.host);
    expect(virtual.canonicalUri).not.toBe(path.canonicalUri);
  });

  test("percent-encodes the key once and leaves the separators alone", () => {
    const target = resolveTarget({
      endpoint,
      style: "path",
      bucket: "b",
      key: "q1 2026/résumé (final)!.pdf",
    });
    expect(target.canonicalUri).toBe("/b/q1%202026/r%C3%A9sum%C3%A9%20%28final%29%21.pdf");
  });

  test("refuses virtual-hosted addressing against an IP endpoint", () => {
    const local = parseEndpoint("http://127.0.0.1:9000");
    expect(() =>
      resolveTarget({ endpoint: local, style: "virtual-hosted", bucket: "docs", key: "k" }),
    ).toThrow(/cannot carry "docs\." as a subdomain/);
    expect(resolveTarget({ endpoint: local, style: "path", bucket: "docs", key: "k" }).host).toBe(
      "127.0.0.1:9000",
    );
  });

  test("refuses an endpoint that already names the bucket", () => {
    const already = parseEndpoint("https://photos.s3.amazonaws.com");
    expect(() =>
      resolveTarget({ endpoint: already, style: "virtual-hosted", bucket: "photos", key: "k" }),
    ).toThrow(/already begins with the bucket name/);
  });
});

describe("request fields", () => {
  test("a header value with a control character is refused", () => {
    expect(() => checkHeaderValue("contentType", "text/plain\r\nX-Evil: 1")).toThrow(
      /control character/,
    );
  });

  test("a header value that is not its own canonical form is refused, with the fix", () => {
    expect(() => checkHeaderValue("contentType", "text/plain;  charset=utf-8")).toThrow(
      /pass "text\/plain; charset=utf-8"/,
    );
  });

  test("metadata is prefixed and lowercased the way S3 stores it", () => {
    expect(metadataHeaders({ Owner: "ops", "run-id": "42" })).toEqual([
      ["x-amz-meta-owner", "ops"],
      ["x-amz-meta-run-id", "42"],
    ]);
  });

  test("metadata that already carries the prefix is refused rather than doubled", () => {
    expect(() => metadataHeaders({ "x-amz-meta-owner": "ops" })).toThrow(/pass the bare name/);
  });

  test("two metadata names that differ only in case are refused", () => {
    expect(() => metadataHeaders({ Owner: "a", owner: "b" })).toThrow(/differ only in case/);
  });

  test("non-ASCII metadata is refused, because an HTTP header cannot carry it", () => {
    expect(() => metadataHeaders({ owner: "Björn" })).toThrow(/printable US-ASCII/);
  });

  test("metadata over the 2 KB ceiling is refused before the upload", () => {
    expect(() => metadataHeaders({ blob: "x".repeat(MAX_METADATA_BYTES) })).toThrow(
      new RegExp(String(MAX_METADATA_BYTES)),
    );
  });

  test("an invalid metadata name is refused", () => {
    expect(() => metadataHeaders({ "owner name": "ops" })).toThrow(/header token/);
  });

  test("response overrides become the query parameters S3 names", () => {
    expect(
      responseOverrides({
        responseContentDisposition: 'attachment; filename="invoice.pdf"',
        versionId: "v1",
      }),
    ).toEqual([
      ["response-content-disposition", 'attachment; filename="invoice.pdf"'],
      ["versionId", "v1"],
    ]);
  });

  test("a control character in an override is refused", () => {
    expect(() => responseOverrides({ responseContentType: "text/plain\n" })).toThrow(
      /control character/,
    );
  });

  test("upload fields on a download, and the reverse, are refused with the alternative", () => {
    expect(() => checkOperationFields("get", { contentType: "text/plain", overrides: {} })).toThrow(
      /use responseContentType or responseContentDisposition/,
    );
    expect(() =>
      checkOperationFields("put", { overrides: { responseContentDisposition: "attachment" } }),
    ).toThrow(/pass contentType and metadata/);
    expect(() => checkOperationFields("put", { overrides: { versionId: "v1" } })).toThrow(
      /the store assigns its id/,
    );
  });

  test("the matching fields pass", () => {
    expect(() =>
      checkOperationFields("put", { contentType: "text/plain", overrides: {} }),
    ).not.toThrow();
    expect(() =>
      checkOperationFields("get", { overrides: { responseContentType: "text/plain" } }),
    ).not.toThrow();
  });
});
