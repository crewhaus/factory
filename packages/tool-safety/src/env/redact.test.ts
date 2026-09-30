import { describe, expect, test } from "bun:test";
import {
  REDACTED,
  containsKnownSecret,
  createSecretRedactor,
  redactKnownSecrets,
  redactKnownSecretsDeep,
  redactUrlCredentials,
  redactUrlCredentialsInText,
  secretForms,
  trimSecretTail,
} from "./redact";

const SECRET = "sk-ant-CANARY-000111222333";

describe("a secret a cut left at a string's edge (C050, net review)", () => {
  test("the start of a secret at the end of a string is replaced, down to minLength characters", () => {
    let checked = 0;
    for (const keep of [SECRET.length - 1, SECRET.length - 10, 6]) {
      const text = `Authorization: Bearer ${SECRET.slice(0, keep)}`;
      expect({ keep, out: redactKnownSecrets(text, [SECRET]) }).toEqual({
        keep,
        out: `Authorization: Bearer ${REDACTED}`,
      });
      checked += 1;
    }
    expect(checked).toBe(3);
    // Below minLength it is not worth shredding text for.
    expect(redactKnownSecrets("end sk-an", [SECRET])).toBe("end sk-an");
  });

  test("the end of a secret at the start of a string, and an encoded form cut, are replaced too", () => {
    expect(redactKnownSecrets(`${SECRET.slice(8)} rest`, [SECRET])).toBe(`${REDACTED} rest`);
    const b64 = Buffer.from(SECRET).toString("base64");
    expect(redactKnownSecrets(`x ${b64.slice(0, -3)}`, [SECRET])).toBe(`x ${REDACTED}`);
    // A string that is nothing but part of a secret becomes one placeholder.
    expect(redactKnownSecrets(SECRET.slice(0, -1), [SECRET])).toBe(REDACTED);
    expect(redactKnownSecrets(SECRET.slice(1), [SECRET])).toBe(REDACTED);
    // Unrelated text is left alone.
    expect(redactKnownSecrets("nothing like it", [SECRET])).toBe("nothing like it");
  });

  test("a JSON result's cut value is redacted value by value", () => {
    const out = redactKnownSecretsDeep({ body: `echo ${SECRET.slice(0, -1)}`, n: 1 }, [SECRET]);
    expect(out).toEqual({ body: `echo ${REDACTED}`, n: 1 });
  });

  test("trimSecretTail removes any partial run from text the caller cut, and nothing else", () => {
    expect(trimSecretTail(`body ${SECRET.slice(0, 3)}`, [SECRET])).toBe("body ");
    expect(trimSecretTail(`body ${SECRET.slice(0, -1)}`, [SECRET])).toBe("body ");
    // A whole form is the redactor's job, and plain text is untouched.
    expect(trimSecretTail(`body ${SECRET}`, [SECRET])).toBe(`body ${SECRET}`);
    expect(trimSecretTail("body text", [SECRET])).toBe("body text");
    expect(trimSecretTail("body text", [])).toBe("body text");
  });
});

describe("a composite whose start is not secret (net regression review)", () => {
  // A Basic header sends `user:secret`. The username is the account's
  // public name: results show it as a login, an assignee, an email, a URL.
  const USER = "deploybot";
  const PASSWORD = "Xk9-quartz-lantern-77";
  const values = [PASSWORD, { publicPrefix: `${USER}:`, secret: PASSWORD }];

  test("text that is or ends with the username is left alone", () => {
    const doc = {
      login: USER,
      greeting: `Logged in as ${USER}`,
      link: `https://x.example/user?name=${USER}`,
      email: "ci-bot@company.com",
      issues: [{ key: "OPS-1", assignee: USER }],
    };
    expect(redactKnownSecretsDeep(doc, values)).toEqual(doc);
    const email = "ci-bot@company.com";
    const emailValues = [PASSWORD, { publicPrefix: `${email}:`, secret: PASSWORD }];
    expect(redactKnownSecrets(`reporter ${email}`, emailValues)).toBe(`reporter ${email}`);
    // Up to the colon is still the username's.
    expect(redactKnownSecrets(`as ${USER}:`, values)).toBe(`as ${USER}:`);
    expect(trimSecretTail(`cut at ${USER}:`, values)).toBe(`cut at ${USER}:`);
  });

  test("every spelling of the pair is still redacted whole, and a cut past the username is caught", () => {
    const pair = `${USER}:${PASSWORD}`;
    const b64 = Buffer.from(pair).toString("base64");
    let checked = 0;
    for (const leak of [
      pair,
      b64,
      encodeURIComponent(pair),
      Buffer.from(pair).toString("base64url"),
    ]) {
      expect(redactKnownSecrets(`echo ${leak} end`, values)).toBe(`echo ${REDACTED} end`);
      checked += 1;
    }
    expect(checked).toBe(4);
    // The backstop: six characters of the secret past `user:` at the end.
    expect(redactKnownSecrets(`echo ${pair.slice(0, USER.length + 1 + 6)}`, values)).toBe(
      `echo ${REDACTED}`,
    );
    expect(redactKnownSecrets(`Basic ${b64.slice(0, -2)}`, values)).toBe(`Basic ${REDACTED}`);
    // A caller that cut the text trims one character past the username.
    expect(trimSecretTail(`cut ${pair.slice(0, USER.length + 2)}`, values)).toBe("cut ");
    expect(trimSecretTail(`Basic ${b64.slice(0, 16)}`, values)).toBe("Basic ");
    // ...but not a base64 run that spells only the username's bytes.
    const userOnly = Buffer.from(`${USER}:`).toString("base64").slice(0, 13);
    expect(trimSecretTail(`Basic ${userOnly}`, values)).toBe(`Basic ${userOnly}`);
  });

  test("secretForms of a composite are the whole value's spellings", () => {
    const forms = secretForms({ publicPrefix: "ada:", secret: "pw-123456" });
    expect(forms).toContain("ada:pw-123456");
    expect(forms).toContain(Buffer.from("ada:pw-123456").toString("base64"));
    expect(forms).not.toContain("pw-123456");
  });
});

describe("the JSON spelling of '/' as '\\/' (net attacker review)", () => {
  // PHP's json_encode, among others, writes every solidus as `\/`.
  const KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const php = (v: unknown): string => JSON.stringify(v).replaceAll("/", "\\/");

  test("an echo in that spelling is redacted, whole and cut", () => {
    const echoed = php({ key: KEY });
    expect(echoed).toContain("wJalrXUtnFEMI\\/K7MDENG");
    expect(redactKnownSecrets(echoed, [KEY])).toBe(`{"key":"${REDACTED}"}`);
    const cut = echoed.slice(0, -4);
    expect(trimSecretTail(cut, [KEY])).toBe('{"key":"');
    expect(secretForms(KEY)).toContain(KEY.replaceAll("/", "\\/"));
  });
});

describe("a secret escaped character by character (C050 residual)", () => {
  // AWS-style: carries `/` and `+`, which encoders escape one at a time.
  const KEY = ["wJalrXUtnFEMI", "K7MDENG+bPxRfiCY", "EXAMPLEKEY"].join("/");
  const PIECES = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCY", "EXAMPLEKEY"];
  const shown = (text: string): string[] => PIECES.filter((p) => text.includes(p));
  const spellings: Record<string, string> = {
    // System.Text.Json's default escapes `+` (and only that, here).
    stj: KEY.replaceAll("+", "\\u002B"),
    stjLowerHex: KEY.replaceAll("+", "\\u002b").replaceAll("/", "\\u002f"),
    lowerPercent: encodeURIComponent(KEY).replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase()),
    mixedPercent: KEY.replaceAll("/", "%2f"),
    htmlHex: KEY.replaceAll("/", "&#x2F;"),
    htmlDecimal: KEY.replaceAll("/", "&#47;").replaceAll("+", "&#43;"),
    htmlNamed: KEY.replaceAll("/", "&sol;").replaceAll("+", "&plus;"),
    phpAndStj: KEY.replaceAll("/", "\\/").replaceAll("+", "\\u002B"),
  };

  for (const [name, spelled] of Object.entries(spellings)) {
    test(`the ${name} spelling is redacted, and the text around it kept`, () => {
      const text = `before ${spelled} after`;
      expect(shown(text).length).toBeGreaterThan(0);
      expect(redactKnownSecrets(text, [KEY])).toBe(`before ${REDACTED} after`);
      expect(containsKnownSecret(text, [KEY])).toBe(true);
    });
  }

  test("a cut through an escaped echo leaves none of it at either edge", () => {
    const spelled = spellings.stj as string;
    const tail = `got ${spelled.slice(0, -3)}`;
    expect(shown(redactKnownSecrets(tail, [KEY]))).toEqual([]);
    const head = `${spelled.slice(4)} rest`;
    expect(shown(redactKnownSecrets(head, [KEY]))).toEqual([]);
    expect(redactKnownSecrets(head, [KEY])).toBe(`${REDACTED} rest`);
  });

  test("escapes that spell no secret are left exactly as written", () => {
    const text = "a%2fb \\u002B &#x2F; &amp; 100% & done; \\n";
    expect(redactKnownSecrets(text, [KEY])).toBe(text);
    expect(containsKnownSecret(text, [KEY])).toBe(false);
  });

  test("a composite's public prefix under escapes is not a secret on its own", () => {
    const composite = { publicPrefix: "alice:", secret: "s3cr3t+Passw0rd/x" };
    const echoed = "user=alice%3as3cr3t%2bPassw0rd%2fx";
    expect(redactKnownSecrets(echoed, [composite])).toBe(`user=${REDACTED}`);
    expect(redactKnownSecrets("user=alice%3a", [composite])).toBe("user=alice%3a");
  });

  test("the decoded view is linear: many '&', '%' and '\\' with nothing to decode", () => {
    const hostile = `${"&".repeat(300_000)}${"%".repeat(300_000)}${"\\x".repeat(150_000)}`;
    const started = performance.now();
    expect(redactKnownSecrets(hostile, [KEY])).toBe(hostile);
    expect(containsKnownSecret(hostile, [KEY])).toBe(false);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("escapes inside escapes, script escapes and UTF-16 (C050 residual, bounds review)", () => {
  const KEY = ["wJalrXUtnFEMI", "K7MDENG+bPxRfiCY", "EXAMPLEKEY"].join("/");
  const PIECES = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCY", "EXAMPLEKEY"];
  const shown = (text: string): string[] =>
    PIECES.filter((p) => text.replaceAll("\u0000", "").includes(p));
  const stj = JSON.stringify({ key: "X" }).replace("X", KEY.replaceAll("+", "\\u002B"));
  const utf16 = (s: string, order: "le" | "be"): string =>
    [...s].map((c) => (order === "le" ? `${c}\u0000` : `\u0000${c}`)).join("");
  const spellings: Record<string, string> = {
    // System.Text.Json's echo as a JSON string inside a JSON body: its
    // `\u002B` arrives as `\\u002B`, which one decode turns into `\u002B`.
    stjInJson: JSON.stringify({ raw: stj }),
    stjInJsonInJson: JSON.stringify({ outer: JSON.stringify({ raw: stj }) }),
    jsHex: `var k = '${KEY.replaceAll("/", "\\x2F").replaceAll("+", "\\x2B")}';`,
    jsCodePoint: `k = "${KEY.replaceAll("/", "\\u{2F}").replaceAll("+", "\\u{2b}")}"`,
    // A browser reads a numeric reference without its `;` (`&#x2B` would
    // swallow the hex digit `b` after it, in a browser too, so decimal here).
    htmlNoSemicolon: `<p>${KEY.replaceAll("/", "&#47").replaceAll("+", "&#43")}</p>`,
    percentOfPercent: `q=${KEY.replaceAll("/", "%252F").replaceAll("+", "%252B")}`,
    // A UTF-16 body read as UTF-8: a NUL beside every ASCII character.
    utf16le: utf16(`key=${KEY}`, "le"),
    utf16be: utf16(`key=${KEY}`, "be"),
    utf16Escaped: utf16(`{"key":"${KEY.replaceAll("+", "\\u002B")}"}`, "le"),
  };

  for (const [name, spelled] of Object.entries(spellings)) {
    test(`the ${name} spelling is found and redacted`, () => {
      expect(shown(spelled)).toEqual(PIECES);
      expect(containsKnownSecret(spelled, [KEY])).toBe(true);
      const out = redactKnownSecrets(spelled, [KEY]);
      expect(shown(out)).toEqual([]);
      expect(out).toContain(REDACTED);
    });
  }

  test("only the secret's own span goes: the JSON around a nested echo is kept", () => {
    expect(redactKnownSecrets(spellings.stjInJson as string, [KEY])).toBe(
      `{"raw":"{\\"key\\":\\"${REDACTED}\\"}"}`,
    );
    expect(redactKnownSecrets(spellings.jsHex as string, [KEY])).toBe(`var k = '${REDACTED}';`);
    expect(redactKnownSecrets(`x\u0000${utf16(KEY, "le")}y`, [KEY])).toBe(
      `x\u0000${REDACTED}\u0000y`,
    );
  });

  test("the passes stop: a secret under more layers than the view decodes is not claimed", () => {
    // Five layers of `%25`: past the pass bound. Documented, not a promise
    // to find everything — the bound is what keeps the view linear.
    let deep = "%2F";
    for (let k = 0; k < 5; k++) deep = deep.replace("%", "%25");
    const text = `${KEY.split("/")[0]}${deep}${KEY.slice(KEY.indexOf("/") + 1)}`;
    expect(containsKnownSecret(text, [KEY])).toBe(false);
  });

  test("any mixture of spellings maps back to exactly the secret's span", () => {
    // Deterministic pseudo-random mixtures: each character of the secret in
    // one of eight spellings, between random text that decodes to nothing
    // secret. The text around the echo must survive byte for byte.
    let seed = 7;
    const rand = (n: number): number => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const spell = (c: string): string => {
      const code = c.charCodeAt(0);
      const hex = code.toString(16).padStart(2, "0");
      const forms = [
        c,
        `\\u${hex.padStart(4, "0")}`,
        `\\x${hex}`,
        `%${hex}`,
        `&#${code};`,
        `&#x${hex.toUpperCase()};`,
        `${c}\u0000`,
        `\\\\u${hex.padStart(4, "0")}`.replace("\\\\", "\\u005C"),
      ];
      return forms[rand(forms.length)] as string;
    };
    const noise = ["a", "%zz", "&", "\\q", " ", "&amp;", "%41", "\\n", "é", "😀"];
    for (let round = 0; round < 300; round++) {
      let before = "";
      let after = "";
      for (let k = rand(6); k > 0; k--) before += noise[rand(noise.length)];
      for (let k = rand(6); k > 0; k--) after += noise[rand(noise.length)];
      // A separator that cannot join an escape on either side.
      const echoed = [...KEY].map(spell).join("");
      const text = `${before}|${echoed}|${after}`;
      expect(containsKnownSecret(text, [KEY])).toBe(true);
      // A NUL after the secret's last character is outside its span: it stays.
      expect(redactKnownSecrets(text, [KEY]).replaceAll("\u0000", "")).toBe(
        `${before}|${REDACTED}|${after}`,
      );
    }
  });

  test("a 25 MiB body of escapes costs about its size, not an object per escape (bounds review)", () => {
    // 0.7.1's first cut built one segment object and one string per escape:
    // about 1.1 GiB of RSS for this body, on every authenticated HttpRequest
    // or DownloadFile that returned it.
    const text = "%41".repeat(Math.floor((25 * 1024 * 1024) / 3));
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    expect(containsKnownSecret(text, [KEY])).toBe(false);
    expect(redactKnownSecrets(text, [KEY]).length).toBe(text.length);
    expect(redactKnownSecretsDeep({ body: text }, [KEY]).body.length).toBe(text.length);
    const grew = process.memoryUsage().rss - before;
    expect(grew).toBeLessThan(256 * 1024 * 1024);
  }, 60_000);
});

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

  test("a scheme with a digit in it is still a scheme", () => {
    // The backward scan used to stop at the `5`, and the URL went unmasked.
    expect(redactUrlCredentialsInText("proxy socks5://u:pw@socks.corp:1080 down")).toBe(
      "proxy socks5://REDACTED@socks.corp:1080 down",
    );
    expect(redactUrlCredentialsInText("socks5h://u:pw@h")).toBe("socks5h://REDACTED@h");
    // A scheme starts with a letter: leading digits are not part of it.
    expect(redactUrlCredentialsInText("x=9svn+ssh://u:pw@h/r")).toBe("x=9svn+ssh://REDACTED@h/r");
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
