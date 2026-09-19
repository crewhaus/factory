/**
 * The tool, through its own schema and `execute`.
 *
 * Two claims in this file are load-bearing and are asserted rather than
 * stated: the secret never appears in anything the tool returns or throws,
 * and nothing in this package can transmit at all — the second is checked
 * against the package's own source, so it survives whatever gets added later.
 *
 * The golden URL is AWS's published presigned GET Object example, carried all
 * the way through the tool with `signedAt` pinned. If the encoder, the
 * canonicalization, the query assembly or the addressing changes, it moves.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OBJECTSTORE_TOOLS, _setClock, objectPresign } from "./index";

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and this tool does not read it.
const ctx = {} as any;

const DOC_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const DOC_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
/** Distinctive enough that a substring search for it means something. */
const CANARY_SECRET = "canary-SECRET-8f3a9d2b-do-not-leak";

const BASE = {
  operation: "get",
  endpoint: "https://s3.us-east-1.amazonaws.com",
  addressingStyle: "virtual-hosted",
  region: "us-east-1",
  bucket: "examplebucket",
  key: "test.txt",
  accessKeyId: DOC_KEY_ID,
  secretAccessKey: DOC_SECRET,
  signedAt: "2013-05-24T00:00:00Z",
} as const;

async function raw(input: unknown): Promise<string> {
  const parsed = objectPresign.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return objectPresign.execute(parsed.data, ctx);
}

type Presigned = {
  url: string;
  method: string;
  headers: Record<string, string>;
  signedHeaders: string[];
  sendHeadersVerbatim: string;
  host: string;
  expiresAt: string;
  signedAt: string;
  expiresInSeconds: number;
  curl: string;
  warnings?: string[];
  canonicalRequest?: string;
  stringToSign?: string;
};

async function call(input: unknown): Promise<Presigned> {
  return JSON.parse(await raw(input)) as Presigned;
}

/** The query parameters of a minted URL, as the store would read them. */
function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("package-wide contract", () => {
  test("the package registers exactly the tools it exports", () => {
    expect(OBJECTSTORE_TOOLS.length).toBe(1);
    expect(OBJECTSTORE_TOOLS[0]).toBe(objectPresign);
  });

  test("names are unique and PascalCase", () => {
    const names = OBJECTSTORE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of OBJECTSTORE_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only, non-destructive, internal and declares no I/O", () => {
    for (const t of OBJECTSTORE_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly, destructive: t.destructive }).toEqual({
        name: t.name,
        readOnly: true,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope, io: t.ioCapability }).toEqual({
        name: t.name,
        scope: "internal",
        io: undefined,
      });
    }
  });

  test("every description says what it is for", () => {
    for (const t of OBJECTSTORE_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toContain("Use it");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of OBJECTSTORE_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });

  test("no schema accepts a bank credential or a payment-provider key", () => {
    // This package mints a URL for an object store. It has no business near
    // money, and there is no field through which a payment credential could
    // arrive — so nothing here can be persuaded into paying anybody.
    const shapes = OBJECTSTORE_TOOLS.map((t) =>
      JSON.stringify(Object.keys((t.inputSchema as never as { shape?: object }).shape ?? {})),
    )
      .join(" ")
      .toLowerCase();
    for (const forbidden of [
      "iban",
      "cardnumber",
      "card_number",
      "routingnumber",
      "accountnumber",
      "sortcode",
      "cvv",
      "stripe",
      "plaid",
      "paymenttoken",
      "bankaccount",
      "privatekey",
      "mnemonic",
    ]) {
      expect({ forbidden, present: shapes.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });

  test("nothing in this package can transmit anything", () => {
    // The stronger form of "declares no ioCapability": the source itself has
    // no way to reach a network, a socket, a child process or the disk. A
    // future edit that adds one fails here rather than in review.
    const root = join(import.meta.dir);
    const files = [
      ...readdirSync(root)
        .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
        .map((n) => join(root, n)),
      ...readdirSync(join(root, "lib"))
        .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
        .map((n) => join(root, "lib", n)),
    ];
    expect(files.length).toBeGreaterThan(4);
    const forbidden = [
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "node:dgram",
      "node:dns",
      "node:child_process",
      "node:worker_threads",
      "node:fs",
      "XMLHttpRequest",
      "WebSocket",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const needle of forbidden) {
        expect({ file, needle, found: source.includes(needle) }).toEqual({
          file,
          needle,
          found: false,
        });
      }
      expect({ file, callsFetch: /\bfetch\s*\(/.test(source) }).toEqual({
        file,
        callsFetch: false,
      });
    }
  });
});

describe("the golden URL", () => {
  test("reproduces AWS's published presigned GET Object example, end to end", async () => {
    // AWS, "Signing and authenticating REST requests" — Example: Query
    // parameter authentication for a GET on examplebucket/test.txt.
    const result = await call({
      ...BASE,
      endpoint: "https://s3.amazonaws.com",
      expiresInSeconds: 86400,
    });
    expect(result.url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(result.method).toBe("GET");
    expect(result.host).toBe("examplebucket.s3.amazonaws.com");
    expect(result.signedHeaders).toEqual(["host"]);
    expect(result.headers).toEqual({});
    // The example a caller actually copies: the object lands under its own
    // name rather than curl's guess at one from a 400-character URL.
    expect(result.curl).toStartWith("curl -fSL -o 'test.txt' ");
  });

  test("the same inputs mint the same URL twice", async () => {
    const first = await call(BASE);
    const second = await call(BASE);
    expect(first.url).toBe(second.url);
  });
});

describe("encoding, through the tool", () => {
  test("a key with a space, a plus and non-ASCII signs the way S3 reads it", async () => {
    const key = "q1 2026/résumé+final (v2)!.pdf";
    const result = await call({ ...BASE, key });
    expect(new URL(result.url).pathname).toBe(
      "/q1%202026/r%C3%A9sum%C3%A9%2Bfinal%20%28v2%29%21.pdf",
    );
    // What encodeURIComponent would have produced, for the record: it leaves
    // the parentheses and the bang alone, and that URL 403s.
    expect(new URL(result.url).pathname).not.toContain("(v2)!");
  });

  test("the separators stay separators and are not encoded", async () => {
    const result = await call({ ...BASE, key: "a/b/c.txt" });
    expect(new URL(result.url).pathname).toBe("/a/b/c.txt");
  });

  test("path style puts the bucket in the path and leaves the host alone", async () => {
    const result = await call({ ...BASE, addressingStyle: "path" });
    expect(result.host).toBe("s3.us-east-1.amazonaws.com");
    expect(new URL(result.url).pathname).toBe("/examplebucket/test.txt");
    // The signature differs because the request differs: same object, two
    // incompatible URLs, which is why the style is an argument.
    const virtual = await call(BASE);
    expect(params(result.url).get("X-Amz-Signature")).not.toBe(
      params(virtual.url).get("X-Amz-Signature"),
    );
  });

  test("a MinIO endpoint keeps its port in the host and in the URL", async () => {
    const result = await call({
      ...BASE,
      endpoint: "http://127.0.0.1:9000",
      addressingStyle: "path",
    });
    expect(result.host).toBe("127.0.0.1:9000");
    expect(result.url.startsWith("http://127.0.0.1:9000/examplebucket/test.txt?")).toBe(true);
  });
});

describe("a PUT that pins headers", () => {
  const put = {
    ...BASE,
    operation: "put",
    contentType: "application/pdf",
    metadata: { Owner: "ops", "run-id": "42" },
  };

  test("returns the exact headers the upload must send, and says so", async () => {
    const result = await call(put);
    expect(result.method).toBe("PUT");
    expect(result.headers).toEqual({
      "content-type": "application/pdf",
      "x-amz-meta-owner": "ops",
      "x-amz-meta-run-id": "42",
    });
    expect(result.sendHeadersVerbatim).toContain("exactly as written");
  });

  test("the pinned headers are inside SignedHeaders, in the result and in the URL", async () => {
    const result = await call(put);
    expect(result.signedHeaders).toEqual([
      "content-type",
      "host",
      "x-amz-meta-owner",
      "x-amz-meta-run-id",
    ]);
    expect(params(result.url).get("X-Amz-SignedHeaders")).toBe(
      "content-type;host;x-amz-meta-owner;x-amz-meta-run-id",
    );
  });

  test("changing the content type changes the signature — which is the trap", async () => {
    // An HTTP client that "helpfully" sends application/pdf; charset=utf-8
    // is sending a different signed header, and the store answers 403 hours
    // after this call returned success.
    const pdf = await call({ ...put, metadata: undefined });
    const charset = await call({
      ...put,
      metadata: undefined,
      contentType: "application/pdf; charset=utf-8",
    });
    expect(params(pdf.url).get("X-Amz-Signature")).not.toBe(
      params(charset.url).get("X-Amz-Signature"),
    );
  });

  test("a PUT with nothing pinned needs no headers at all, and says that instead", async () => {
    const result = await call({ ...BASE, operation: "put" });
    expect(result.headers).toEqual({});
    expect(result.signedHeaders).toEqual(["host"]);
    expect(result.sendHeadersVerbatim).toContain("no extra headers");
  });

  test("the curl example carries the headers it told you to send", async () => {
    const result = await call(put);
    expect(result.curl).toContain("-X PUT");
    expect(result.curl).toContain("-H 'content-type: application/pdf'");
    expect(result.curl).toContain(result.url);
  });
});

describe("a GET that pins response overrides", () => {
  test("the download filename is signed into the URL, where the caller cannot forget it", async () => {
    const result = await call({
      ...BASE,
      responseContentDisposition: 'attachment; filename="invoice.pdf"',
      responseContentType: "application/pdf",
    });
    expect(params(result.url).get("response-content-disposition")).toBe(
      'attachment; filename="invoice.pdf"',
    );
    expect(result.headers).toEqual({});
    expect(result.signedHeaders).toEqual(["host"]);
  });

  test("a versionId reads one version", async () => {
    const result = await call({ ...BASE, versionId: "3HL4kqtJlcpXroDTDmjVBH40Nrjfkd" });
    expect(params(result.url).get("versionId")).toBe("3HL4kqtJlcpXroDTDmjVBH40Nrjfkd");
  });
});

describe("expiry", () => {
  test("defaults to fifteen minutes and reports the instant it lapses", async () => {
    const result = await call(BASE);
    expect(result.expiresInSeconds).toBe(900);
    expect(params(result.url).get("X-Amz-Expires")).toBe("900");
    expect(result.signedAt).toBe("2013-05-24T00:00:00.000Z");
    expect(result.expiresAt).toBe("2013-05-24T00:15:00.000Z");
  });

  test("a long-lived URL comes back with the warning it deserves", async () => {
    const result = await call({ ...BASE, expiresInSeconds: 7 * 24 * 60 * 60 });
    expect(result.warnings?.join(" ")).toContain("bearer credential");
  });

  test("past seven days it is refused with the reason, not clamped", async () => {
    await expect(raw({ ...BASE, expiresInSeconds: 7 * 24 * 60 * 60 + 1 })).rejects.toThrow(
      /7-day .* ceiling/,
    );
  });

  test("temporary credentials carry their own expiry, and the result says so", async () => {
    const result = await call({ ...BASE, sessionToken: "FQoGZXIvYXdzE..." });
    expect(params(result.url).get("X-Amz-Security-Token")).toBe("FQoGZXIvYXdzE...");
    expect(result.warnings?.join(" ")).toContain("session token expires");
  });

  test("the account of what is in the URL names the session token, not just the key id", async () => {
    // "the secret appears nowhere in this result" is true and reads as a
    // complete inventory. It was not one: SigV4 has nowhere but the query to
    // carry a session token, and a session token is a live credential with a
    // blast radius well past this one object.
    const plain = (await call(BASE)) as unknown as { credentials: string };
    expect(plain.credentials).toContain("access key id");
    expect(plain.credentials.toLowerCase()).not.toContain("session token");

    const temporary = (await call({
      ...BASE,
      sessionToken: "FQoGZXIvYXdzE...",
    })) as unknown as { credentials: string };
    expect(temporary.credentials).toContain("X-Amz-Security-Token");
    expect(temporary.credentials).toContain("live credential");
  });
});

describe("the clock", () => {
  test("without signedAt the injected clock decides, and expiry follows it", async () => {
    // No wall-clock assertion anywhere: the clock is a value, so the URL is
    // a function of it.
    _setClock({ now: () => Date.parse("2026-03-04T05:06:07.890Z") });
    try {
      const result = await call({ ...BASE, signedAt: undefined, expiresInSeconds: 60 });
      expect(params(result.url).get("X-Amz-Date")).toBe("20260304T050607Z");
      // The reported window starts where the SIGNED timestamp starts: the
      // sub-second part is dropped from both, not from one of them.
      expect(result.signedAt).toBe("2026-03-04T05:06:07.000Z");
      expect(result.expiresAt).toBe("2026-03-04T05:07:07.000Z");
    } finally {
      _setClock(undefined);
    }
  });

  test("an offset-less signedAt is refused rather than read as local time", async () => {
    await expect(raw({ ...BASE, signedAt: "2026-03-04T05:06:07" })).rejects.toThrow(
      /has no UTC offset/,
    );
  });
});

describe("the secret never leaves", () => {
  test("it is in no part of a successful result", async () => {
    const result = await raw({ ...BASE, secretAccessKey: CANARY_SECRET, includeCanonical: true });
    expect(result.includes(CANARY_SECRET)).toBe(false);
    // Not even a fragment of it: the derived signing key is not the secret,
    // but a prefix check catches a naive "echo the input back" regression.
    expect(result.includes(CANARY_SECRET.slice(0, 12))).toBe(false);
    // The access key ID is a different matter — SigV4 puts it in the URL by
    // construction, and the store needs it to know which key to verify.
    expect(result).toContain(DOC_KEY_ID);
  });

  test("it is in no part of a refusal either", async () => {
    // The failure path is where a secret usually escapes: an error message
    // that helpfully echoes its inputs.
    const attempt = raw({
      ...BASE,
      secretAccessKey: CANARY_SECRET,
      key: "a/../escape.txt",
    });
    await expect(attempt).rejects.toThrow(/resolve those before sending/);
    const message = await attempt.then(
      () => "",
      (err: Error) => `${err.message}\n${err.stack ?? ""}`,
    );
    expect(message.includes(CANARY_SECRET)).toBe(false);
  });

  test("nor when the secret was pasted into the endpoint, which callers do", async () => {
    // The tool's own schema has a field for the secret, but an agent that
    // knows S3 URLs writes `https://KEY:SECRET@host` — the code refuses that
    // shape for exactly that reason. Two of the endpoint checks run before
    // the refusal and quoted the whole string back.
    for (const endpoint of [
      `ftp://AKIAIOSFODNN7EXAMPLE:${CANARY_SECRET}@files.example.com`,
      `https://AKIAIOSFODNN7EXAMPLE:${CANARY_SECRET}@s3.example.com:99999`,
      `https://AKIAIOSFODNN7EXAMPLE:${CANARY_SECRET}@s3.example.com`,
    ]) {
      const message = await raw({ ...BASE, endpoint }).then(
        () => "",
        (err: Error) => `${err.message}\n${err.stack ?? ""}`,
      );
      expect({ endpoint: endpoint.replace(CANARY_SECRET, "…"), refused: message !== "" }).toEqual({
        endpoint: endpoint.replace(CANARY_SECRET, "…"),
        refused: true,
      });
      expect({
        endpoint: endpoint.replace(CANARY_SECRET, "…"),
        leaked: message.includes(CANARY_SECRET),
      }).toEqual({ endpoint: endpoint.replace(CANARY_SECRET, "…"), leaked: false });
    }
  });

  test("the canonical request it hands back for debugging holds no secret", async () => {
    const result = await call({ ...BASE, secretAccessKey: CANARY_SECRET, includeCanonical: true });
    expect(result.canonicalRequest).toContain("UNSIGNED-PAYLOAD");
    expect(result.stringToSign).toContain("AWS4-HMAC-SHA256");
    expect(`${result.canonicalRequest}${result.stringToSign}`.includes(CANARY_SECRET)).toBe(false);
  });
});

describe("refusals", () => {
  const refuses = async (patch: Record<string, unknown>, reason: RegExp) => {
    await expect(raw({ ...BASE, ...patch })).rejects.toThrow(reason);
  };

  test("an endpoint with a path, a query or credentials", async () => {
    await refuses({ endpoint: "https://gw.example.com/s3" }, /has a path/);
    await refuses({ endpoint: "https://s3.example.com?x=1" }, /query string or fragment/);
    await refuses({ endpoint: "https://k:s@s3.example.com" }, /username or password/);
  });

  test("plain http to a remote host, because the URL is the credential", async () => {
    await refuses({ endpoint: "http://minio.example.com" }, /bearer credential/);
    // …including a host that only LOOKS like loopback. The guard used to be a
    // prefix match on the hostname text, and `127.0.0.1.evil.example` is a
    // domain somebody else registers.
    await refuses({ endpoint: "http://127.0.0.1.evil.example" }, /bearer credential/);
    await refuses({ endpoint: "http://127.example.com" }, /bearer credential/);
  });

  test("a bucket that would put a dot segment in the signed path", async () => {
    // The same trap `key` is checked for, arriving through `bucket`: path
    // style would sign "/./test.txt", which every client rewrites to
    // "/test.txt" before it leaves.
    await refuses({ bucket: ".", addressingStyle: "path" }, /usable path segment/);
  });

  test("a signing instant whose year cannot fit in X-Amz-Date", async () => {
    await refuses(
      { signedAt: Date.parse("+010000-01-01T00:00:00Z") },
      /outside the years 0000-9999/,
    );
  });

  test("virtual-hosted addressing against an IP endpoint", async () => {
    await refuses(
      { endpoint: "http://127.0.0.1:9000", addressingStyle: "virtual-hosted" },
      /addressingStyle "path"/,
    );
  });

  test("an endpoint that already names the bucket", async () => {
    await refuses(
      { endpoint: "https://examplebucket.s3.amazonaws.com" },
      /already begins with the bucket name/,
    );
  });

  test("a bucket that cannot be a hostname, in the style that needs one", async () => {
    await refuses({ bucket: "My_Bucket" }, /cannot be a DNS label/);
  });

  test("a key that would be rewritten before it is sent", async () => {
    await refuses({ key: "a/../b.txt" }, /resolve those before sending/);
    await refuses({ key: "/leading.txt" }, /starts with/);
    await refuses({ key: "a//b.txt" }, /empty path segment/);
    await refuses({ key: "a\rb.txt" }, /control character/);
    await refuses({ key: "日".repeat(400) }, /1200 bytes/);
  });

  test("a region that is not a region name", async () => {
    await refuses({ region: "US-East-1" }, /case-sensitive/);
  });

  test("a credential with whitespace, which is a pasted newline every time", async () => {
    await refuses({ secretAccessKey: `${DOC_SECRET}\n` }, /leading or trailing whitespace/);
    await refuses({ accessKeyId: "AKIA EXAMPLE" }, /whitespace/);
  });

  test("upload fields on a download and download fields on an upload", async () => {
    await refuses({ contentType: "text/plain" }, /applies to an upload/);
    await refuses({ metadata: { owner: "ops" } }, /applies to an upload/);
    await refuses(
      { operation: "put", responseContentDisposition: "attachment" },
      /applies to a download/,
    );
    await refuses({ operation: "put", versionId: "v1" }, /the store assigns its id/);
  });

  test("metadata S3 could not store as written", async () => {
    await refuses({ operation: "put", metadata: { owner: "Björn" } }, /printable US-ASCII/);
    await refuses(
      { operation: "put", metadata: { "x-amz-meta-owner": "ops" } },
      /pass the bare name/,
    );
  });

  test("a content type that is not its own canonical form", async () => {
    await refuses(
      { operation: "put", contentType: "text/plain;  charset=utf-8" },
      /would not be the value signed/,
    );
  });

  test("a field the schema does not know, rather than signing a request that ignores it", async () => {
    // .strict(): a misspelled `contentTypes` must not silently become an
    // unsigned upload with no content type at all.
    const parsed = objectPresign.inputSchema.safeParse({ ...BASE, contentTypes: "text/plain" });
    expect(parsed.success).toBe(false);
  });

  test("a missing addressingStyle, because there is no safe default", async () => {
    const { addressingStyle, ...withoutStyle } = BASE;
    expect(addressingStyle).toBe("virtual-hosted");
    const parsed = objectPresign.inputSchema.safeParse(withoutStyle);
    expect(parsed.success).toBe(false);
  });
});
