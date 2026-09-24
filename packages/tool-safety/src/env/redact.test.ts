import { describe, expect, test } from "bun:test";
import {
  REDACTED,
  createSecretRedactor,
  redactKnownSecrets,
  redactKnownSecretsDeep,
  redactUrlCredentials,
  redactUrlCredentialsInText,
  secretForms,
} from "./redact";

const SECRET = "sk-ant-CANARY-000111222333";

describe("redactKnownSecrets", () => {
  test("a secret echoed in a response body is replaced (config-delivery#4, security-8#4)", () => {
    const body = `{"headers":{"x-anything":"${SECRET}"},"ok":true}`;
    const out = redactKnownSecrets(body, [SECRET]);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`{"headers":{"x-anything":"${REDACTED}"},"ok":true}`);
  });

  test("the encoded spellings are replaced too", () => {
    const b64 = Buffer.from(SECRET).toString("base64");
    const text = [
      `plain ${SECRET}`,
      `url ${encodeURIComponent("a/b+c secret&=")}`,
      `b64 ${b64}`,
      `b64url ${Buffer.from(SECRET).toString("base64url")}`,
      `json ${JSON.stringify('q"uo\\te')}`,
    ].join("\n");
    const out = redactKnownSecrets(text, [SECRET, "a/b+c secret&=", 'q"uo\\te']);
    for (const leak of [SECRET, b64, encodeURIComponent("a/b+c secret&="), 'q\\"uo\\\\te']) {
      expect(out).not.toContain(leak);
    }
  });

  test("a value read with a trailing newline is matched without it", () => {
    expect(redactKnownSecrets(`got ${SECRET}.`, [`${SECRET}\n`])).toBe(`got ${REDACTED}.`);
  });

  test("the longer of two overlapping secrets is replaced whole", () => {
    const long = `${SECRET}-EXTENDED`;
    expect(redactKnownSecrets(`a ${long} b`, [SECRET, long])).toBe(`a ${REDACTED} b`);
  });

  test("short values and undefined are ignored; regex metacharacters are literal", () => {
    expect(redactKnownSecrets("abc abc", ["abc", undefined])).toBe("abc abc");
    expect(redactKnownSecrets("x (a+)+$ y", ["(a+)+$"])).toBe(`x ${REDACTED} y`);
    expect(redactKnownSecrets("keep 1234", ["1234"], { minLength: 4, placeholder: "***" })).toBe(
      "keep ***",
    );
  });

  test("a redactor is built once and reused", () => {
    const redact = createSecretRedactor([SECRET]);
    expect(redact(SECRET)).toBe(REDACTED);
    expect(redact("nothing here")).toBe("nothing here");
    expect(createSecretRedactor([])("unchanged")).toBe("unchanged");
  });

  test("secretForms lists each spelling once", () => {
    const forms = secretForms("abcdefgh");
    expect(new Set(forms).size).toBe(forms.length);
    expect(forms).toContain("abcdefgh");
    expect(forms).toContain(Buffer.from("abcdefgh").toString("base64"));
  });
});

describe("redactKnownSecretsDeep", () => {
  test("every string in a result, keys included, and the result still round-trips", () => {
    const result = {
      status: 401,
      body: `Bad credentials: got Bearer ${SECRET}`,
      headers: [["x-echo", SECRET]],
      [SECRET]: 1,
      nested: { deeper: [{ s: `${SECRET}!` }], n: 3, nil: null, yes: true },
      when: new Date(0),
    };
    const out = redactKnownSecretsDeep(result, [SECRET]);
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRET);
    expect(out.status).toBe(401);
    expect(out.body).toBe(`Bad credentials: got Bearer ${REDACTED}`);
    expect(out.nested.n).toBe(3);
    expect(JSON.parse(json)).toMatchObject({ when: "1970-01-01T00:00:00.000Z" });
  });

  test("a `__proto__` key stays a key, and a cycle is refused", () => {
    const parsed = JSON.parse(`{"__proto__": {"leak": "${SECRET}"}}`) as Record<string, unknown>;
    const out = redactKnownSecretsDeep(parsed, [SECRET]);
    expect(Object.keys(out)).toEqual(["__proto__"]);
    expect(JSON.stringify(out)).toBe(`{"__proto__":{"leak":"${REDACTED}"}}`);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => redactKnownSecretsDeep(cyclic, [SECRET])).toThrow("contains a cycle");
    // A shared (not cyclic) object is fine.
    const shared = { s: SECRET };
    expect(
      JSON.stringify(redactKnownSecretsDeep({ a: shared, b: shared }, [SECRET])),
    ).not.toContain(SECRET);
  });
});

describe("redactUrlCredentials", () => {
  test("userinfo goes, whole, and the rest of the URL is untouched", () => {
    expect(redactUrlCredentials("https://user:hunter22@example.com:8443/a/b?x=1#top")).toBe(
      "https://REDACTED@example.com:8443/a/b?x=1#top",
    );
    expect(redactUrlCredentials("https://ghp_TOKENVALUE@github.com/o/r.git")).toBe(
      "https://REDACTED@github.com/o/r.git",
    );
    expect(redactUrlCredentials(new URL("postgres://app:pw@db.internal:5432/prod"))).toBe(
      "postgres://REDACTED@db.internal:5432/prod",
    );
  });

  test("an @ in the path is not userinfo", () => {
    const npm = "https://registry.npmjs.org/@crewhaus/tool-safety";
    expect(redactUrlCredentials(npm)).toBe(npm);
  });

  test("credential-named query and fragment parameters lose their values", () => {
    expect(
      redactUrlCredentials(
        "https://api.example.com/v1/items?page=2&api_key=abc123&X-Amz-Signature=deadbeef&q=cats;token=t0k",
      ),
    ).toBe(
      "https://api.example.com/v1/items?page=2&api_key=REDACTED&X-Amz-Signature=REDACTED&q=cats;token=REDACTED",
    );
    expect(redactUrlCredentials("https://app.example.com/cb#access_token=AT&state=xyz")).toBe(
      "https://app.example.com/cb#access_token=REDACTED&state=xyz",
    );
    expect(redactUrlCredentials("https://example.com/#section-2")).toBe(
      "https://example.com/#section-2",
    );
  });

  test("an encoded parameter name is judged decoded, and a token-shaped value is caught by shape", () => {
    expect(redactUrlCredentials("https://x.test/?api%5Fkey=v&client+secret=v2")).toBe(
      "https://x.test/?api%5Fkey=REDACTED&client+secret=REDACTED",
    );
    const pasted = `ghp_${"A1b2C3d4".repeat(5)}`;
    expect(redactUrlCredentials(`https://x.test/?q=${pasted}&${pasted}`)).toBe(
      "https://x.test/?q=REDACTED&REDACTED",
    );
  });

  test("a relative URL or a bare string is handled without a scheme", () => {
    expect(redactUrlCredentials("/v1/items?password=p&x=1")).toBe(
      "/v1/items?password=REDACTED&x=1",
    );
    expect(redactUrlCredentials("not a url")).toBe("not a url");
  });
});

describe("redactUrlCredentialsInText", () => {
  test("every URL in an error message, and nothing else", () => {
    const text =
      'fetch failed for "https://bob:s3cret@internal.example/v1?token=abc" after 3 tries; see https://docs.example/errors?id=7';
    expect(redactUrlCredentialsInText(text)).toBe(
      'fetch failed for "https://REDACTED@internal.example/v1?token=REDACTED" after 3 tries; see https://docs.example/errors?id=7',
    );
    expect(redactUrlCredentialsInText("no urls here: a://")).toBe("no urls here: a://");
  });

  test("a scan of caller-sized text is linear", () => {
    // A pattern like /[a-z][a-z0-9+.-]*:\/\//g backtracks through every
    // long run of letters; the scan here never does.
    const text = `${"a".repeat(1_000_000)} ${"://x ".repeat(100_000)}`;
    const started = performance.now();
    redactUrlCredentialsInText(text);
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 20_000);
});
