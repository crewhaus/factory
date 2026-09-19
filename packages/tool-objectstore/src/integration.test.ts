/**
 * The tool driven the way the runtime drives it — registered in a catalog and
 * dispatched through `executeTool`, which validates the input against the
 * declared schema before `execute` ever runs.
 *
 * And then the thing that matters most, which no unit test can show: a URL
 * minted here is VERIFIED here, by code that has only the finished URL and
 * the secret, the way the store verifies it. Reproducing a published vector
 * proves the arithmetic agrees with AWS on one request. Round-tripping an
 * arbitrary one through a verifier proves the whole construction holds for
 * keys nobody published a vector for — which is every key a caller will
 * actually use.
 */
import { describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import {
  OBJECTSTORE_TOOLS,
  UNSIGNED_PAYLOAD,
  canonicalRequest,
  credentialScope,
  sign,
  stringToSign,
} from "./index";

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const KEY_ID = "AKIAIOSFODNN7EXAMPLE";

const catalog = new ToolCatalog();
for (const tool of OBJECTSTORE_TOOLS) catalog.register(tool);

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

async function mint(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await executeTool(lookup("ObjectPresign"), input, { toolUseId: "presign" });
  if (result.isError === true) throw new Error(String(result.content));
  return JSON.parse(String(result.content)) as Record<string, unknown>;
}

/**
 * Percent-encoding, RFC 3986, written out HERE from the rule rather than
 * imported from the package under test.
 *
 * This is the whole point of the rewrite this file went through. The earlier
 * verifier took `canonicalUri` straight off the minted URL's `pathname` and
 * signed that, which means it signed whatever the tool had encoded — so it
 * agreed with the tool by construction. Mutating `encode.ts` to
 * `encodeURIComponent`'s unreserved set (leaving `!'()*` bare) left all ten
 * mint-then-verify cases GREEN, including the two keys chosen to carry those
 * exact characters. The file's own comment claimed this was "where a
 * double-encoded or under-encoded key would show up". It was not.
 *
 * So: the rule, spelled out again, in a different shape from the package's
 * lookup table — unreserved is `A-Z a-z 0-9 - _ . ~`, everything else is
 * `%XX` uppercase over the UTF-8 bytes.
 */
function pct(value: string): string {
  return Array.from(new TextEncoder().encode(value))
    .map((byte) => {
      const ch = String.fromCharCode(byte);
      return /[A-Za-z0-9\-_.~]/.test(ch)
        ? ch
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/** The canonical URI the object's key and bucket SHOULD produce. */
function canonicalUriFor(key: string, bucket?: string): string {
  const encodedKey = key.split("/").map(pct).join("/");
  return bucket === undefined ? `/${encodedKey}` : `/${pct(bucket)}/${encodedKey}`;
}

/**
 * The canonical URI the STORE computes from what arrived on the wire: split
 * the path on `/`, decode each segment to the object key, re-encode it by the
 * store's own rule. A sender that under-encoded a `!` signed `/notes!.txt`;
 * the store signs `/notes%21.txt`, and the answer is 403.
 */
function storeCanonicalUri(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => pct(decodeURIComponent(segment)))
    .join("/");
}

/**
 * Why a URL did not verify, kept distinct all the way out to the caller.
 *
 * A bare `false` collapses three different failures into one, and then a test
 * that asserts `false` is satisfied by whichever of them happens to occur —
 * including one the test was not written to catch.
 */
type Verdict =
  | { ok: true }
  | { ok: false; reason: "no-signature" | "undecodable-path" | "signature-mismatch" };

/**
 * What the store does when the request arrives: take the URL and the signed
 * headers off the wire, rebuild the canonical request from them, and see
 * whether the signature the caller presented is the one the secret produces.
 *
 * Deliberately built from the URL STRING and this file's own encoder, sharing
 * nothing with the tool but the bytes a store would actually receive.
 */
function verify(
  url: string,
  method: "GET" | "PUT",
  headers: Record<string, string>,
  secret: string,
): Verdict {
  const parsed = new URL(url);
  const presented = parsed.searchParams.get("X-Amz-Signature");
  if (presented === null) return { ok: false, reason: "no-signature" };

  const query: Array<readonly [string, string]> = [];
  for (const [name, value] of parsed.searchParams) {
    if (name !== "X-Amz-Signature") query.push([name, value] as const);
  }
  const signedNames = (parsed.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
  const supplied: Record<string, string> = { host: parsed.host, ...headers };
  const signedHeaders = signedNames.map((name) => [name, supplied[name] ?? ""] as const);

  const amzDate = parsed.searchParams.get("X-Amz-Date") ?? "";
  const credential = parsed.searchParams.get("X-Amz-Credential") ?? "";
  const [, dateStamp = "", region = "", service = ""] = credential.split("/");

  let canonicalUri: string;
  try {
    canonicalUri = storeCanonicalUri(parsed.pathname);
  } catch {
    return { ok: false, reason: "undecodable-path" };
  }

  const creq = canonicalRequest({
    method,
    canonicalUri,
    query,
    headers: signedHeaders,
    payloadHash: UNSIGNED_PAYLOAD,
  });
  const expected = sign({
    secretAccessKey: secret,
    dateStamp,
    region,
    service,
    stringToSign: stringToSign({
      amzDate,
      scope: credentialScope(dateStamp, region, service),
      canonicalRequest: creq.text,
    }),
  });
  return expected === presented ? { ok: true } : { ok: false, reason: "signature-mismatch" };
}

const BASE = {
  operation: "get",
  endpoint: "https://s3.us-east-1.amazonaws.com",
  addressingStyle: "virtual-hosted",
  region: "us-east-1",
  bucket: "examplebucket",
  key: "test.txt",
  accessKeyId: KEY_ID,
  secretAccessKey: SECRET,
  signedAt: "2026-02-03T04:05:06Z",
};

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(OBJECTSTORE_TOOLS.length);
  });

  test("the catalog refuses a second registration of the same name", () => {
    expect(() => catalog.register(OBJECTSTORE_TOOLS[0] as RegisteredTool)).toThrow();
  });
});

describe("dispatch through executeTool", () => {
  test("a minimal valid input comes back as a URL", async () => {
    const result = await mint(BASE);
    expect(
      String(result["url"]).startsWith("https://examplebucket.s3.us-east-1.amazonaws.com/"),
    ).toBe(true);
  });

  test("an input the schema rejects never reaches the tool", async () => {
    const result = await executeTool(
      lookup("ObjectPresign"),
      { ...BASE, addressingStyle: "dns" },
      { toolUseId: "bad-style" },
    );
    expect(result.isError).toBe(true);
  });

  test("a refusal comes back as an error result carrying the reason", async () => {
    const result = await executeTool(
      lookup("ObjectPresign"),
      { ...BASE, key: "a/../b.txt" },
      { toolUseId: "dot-segment" },
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("resolve those before sending");
  });
});

describe("a minted URL verifies the way the store verifies it", () => {
  // The keys that break a hand-rolled encoder, one per row, each carried
  // through minting and verification with nothing shared between the two but
  // the URL string.
  const keys = [
    "plain.txt",
    "with space.txt",
    "with+plus.txt",
    "q&a (2026)/notes!.txt",
    "résumé/日本語.pdf",
    "emoji/😀.png",
    "tilde~dash-under_dot.txt",
    "100%25.txt",
    "deep/a/b/c/d/e/f.json",
    "'quoted'*star.txt",
  ];

  for (const key of keys) {
    test(`GET ${JSON.stringify(key)}`, async () => {
      const result = await mint({ ...BASE, key });
      const url = String(result["url"]);
      // Two independent claims, because one of them used to be missing.
      // (1) the path the tool minted IS the canonical encoding of the key —
      // this is what catches a DOUBLE-encoded key, whose decoded form is not
      // the object anybody asked for;
      expect(new URL(url).pathname).toBe(canonicalUriFor(key));
      // (2) the signature verifies against a canonical request the store
      // rebuilds itself — this is what catches an UNDER-encoded key.
      expect(verify(url, "GET", {}, SECRET)).toEqual({ ok: true });
    });
  }

  test("a PUT with pinned headers verifies only when those headers are sent", async () => {
    const result = await mint({
      ...BASE,
      operation: "put",
      key: "uploads/report final.pdf",
      contentType: "application/pdf",
      metadata: { Owner: "ops" },
    });
    const url = String(result["url"]);
    const headers = result["headers"] as Record<string, string>;

    expect(new URL(url).pathname).toBe(canonicalUriFor("uploads/report final.pdf"));
    expect(verify(url, "PUT", headers, SECRET)).toEqual({ ok: true });
    // The whole reason the headers come back: drop one, or let a client
    // "improve" it, and the store rejects a URL that looked fine. The REASON
    // is asserted, not just the refusal — a verifier that fell over on the
    // path would also return "not verified", and would look like a pass here.
    expect(verify(url, "PUT", {}, SECRET)).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
    expect(
      verify(url, "PUT", { ...headers, "content-type": "application/pdf; charset=utf-8" }, SECRET),
    ).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  test("the verifier can actually see a mis-encoded path — it could not, once", () => {
    // A guard on the guard. The point of `verify` is that it does NOT reuse
    // the tool's encoding of the path; these two hand-built cases are the
    // regressions that used to slip through it, asserted against a URL the
    // tool would never mint.
    const under =
      "https://examplebucket.s3.us-east-1.amazonaws.com/notes!.txt" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260203%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20260203T040506Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host";
    const forged = sign({
      secretAccessKey: SECRET,
      dateStamp: "20260203",
      region: "us-east-1",
      service: "s3",
      stringToSign: stringToSign({
        amzDate: "20260203T040506Z",
        scope: credentialScope("20260203", "us-east-1", "s3"),
        // signed over the UNDER-encoded path, the way a broken encoder would
        canonicalRequest: canonicalRequest({
          method: "GET",
          canonicalUri: "/notes!.txt",
          query: [...new URL(under).searchParams].map(([n, v]) => [n, v] as const),
          headers: [["host", "examplebucket.s3.us-east-1.amazonaws.com"]],
          payloadHash: UNSIGNED_PAYLOAD,
        }).text,
      }),
    });
    expect(verify(`${under}&X-Amz-Signature=${forged}`, "GET", {}, SECRET)).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
    // And the minted-path assertion is what catches the other direction.
    expect(canonicalUriFor("a b.txt")).toBe("/a%20b.txt");
    expect(canonicalUriFor("a b.txt")).not.toBe("/a%2520b.txt");
    expect(canonicalUriFor("q&a (2026)/notes!.txt")).toBe("/q%26a%20%282026%29/notes%21.txt");
  });

  test("a tampered path does not verify", async () => {
    const result = await mint({ ...BASE, key: "invoices/2026-01.pdf" });
    const tampered = String(result["url"]).replace("2026-01", "2026-02");
    expect(verify(tampered, "GET", {}, SECRET)).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  test("the wrong secret does not verify", async () => {
    const result = await mint(BASE);
    expect(verify(String(result["url"]), "GET", {}, `${SECRET}x`)).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  test("path style verifies too, with the bucket inside the signed path", async () => {
    const result = await mint({
      ...BASE,
      endpoint: "http://127.0.0.1:9000",
      addressingStyle: "path",
      key: "nested/a b.txt",
    });
    expect(new URL(String(result["url"])).pathname).toBe("/examplebucket/nested/a%20b.txt");
    expect(new URL(String(result["url"])).pathname).toBe(
      canonicalUriFor("nested/a b.txt", "examplebucket"),
    );
    expect(verify(String(result["url"]), "GET", {}, SECRET)).toEqual({ ok: true });
  });

  test("response overrides are inside the signature, not decoration on the end", async () => {
    const result = await mint({
      ...BASE,
      responseContentDisposition: 'attachment; filename="Q1 report.pdf"',
    });
    const url = String(result["url"]);
    expect(verify(url, "GET", {}, SECRET)).toEqual({ ok: true });
    // The method is inside the signature too: a GET URL replayed as a PUT is
    // not an upload token, it is a 403.
    expect(verify(url, "PUT", {}, SECRET)).toEqual({ ok: false, reason: "signature-mismatch" });
    // Adding the same parameter to a finished URL invalidates it — which is
    // exactly why it has to be signed in at minting time.
    expect(verify(`${url}&response-cache-control=no-store`, "GET", {}, SECRET)).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });
});
