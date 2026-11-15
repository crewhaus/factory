import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CREDENTIAL_FORM_WORDS,
  type CredentialForm,
  carriesCredential,
  credentialFormIn,
  isCredentialKey,
  maskCredentialTokens,
} from "./redact";

describe("isCredentialKey (adversarial review F1)", () => {
  test("matches the credential-key set and close variants, case-insensitively", () => {
    for (const key of [
      "key",
      "apiKey",
      "api_key",
      "API_KEY",
      "token",
      "secret",
      "password",
      "authorization",
      "headers",
      "env",
      "keyRef",
      "privateKey",
      // spec-schema / compiler credential carriers (lowerCredential call sites)
      "botToken",
      "signingSecret",
      "appToken",
      "secretToken",
      "accessToken",
      "GITHUB_TOKEN",
      "slack-token",
    ]) {
      expect(isCredentialKey(key)).toBe(true);
    }
  });

  test("does NOT match ordinary spec keys (suffixes need a word boundary)", () => {
    for (const key of [
      "instructions",
      "model",
      "name",
      "target",
      "chunkSize",
      "max_tokens",
      "monkey",
      "tokens",
      "keynote",
    ]) {
      expect(isCredentialKey(key)).toBe(false);
    }
  });
});

describe("maskCredentialTokens (adversarial review F1)", () => {
  test("masks the well-known token shapes", () => {
    const cases: Array<[string, string]> = [
      ["use sk-live-DEADBEEFDEADBEEF here", "use *** here"],
      ["pat is ghp_abcdefghij0123456789", "pat is ***"],
      ["oauth gho_abcdefghij0123456789", "oauth ***"],
      ["slack xoxb-123456789012-abcdef", "slack ***"],
      ["aws AKIAIOSFODNN7EXAMPLE", "aws ***"],
      ["send Authorization: Bearer abc.def-ghi_jkl", "send Authorization: Bearer ***"],
    ];
    for (const [input, expected] of cases) {
      expect(maskCredentialTokens(input)).toBe(expected);
    }
  });

  test("masks a 32+-char opaque token ONLY behind a key-ish context word", () => {
    const opaque = "A".repeat(16) + "b1_c-d2".repeat(4);
    expect(maskCredentialTokens(`api key: ${opaque}`)).toBe("api key: ***");
    expect(maskCredentialTokens(`token=${opaque}`)).toBe("token=***");
    expect(maskCredentialTokens(`the secret "${opaque}"`)).toBe('the secret "***"');
    // Same token with NO context word: left alone (a hash, a request id, …).
    expect(maskCredentialTokens(`see commit ${opaque} upstream`)).toBe(
      `see commit ${opaque} upstream`,
    );
  });

  test("leaves normal prose untouched (no-hit cases)", () => {
    for (const text of [
      "Think step by step before answering.",
      "Use the password manager to store keys.",
      "The task-completion rate improved.",
      "sk-live", // too short for the sk- shape
      "Bearer hug", // too short for a bearer token
    ]) {
      expect(maskCredentialTokens(text)).toBe(text);
    }
  });
});

describe("maskCredentialTokens: CrewHaus issued secrets", () => {
  // Built from parts at runtime, so no secret-shaped literal sits in the repo.
  const body = (seed: string): string => `${seed}Ab9_-`.repeat(9).slice(0, 43);
  const secret = (kind: "a" | "p" | "s" | "i", seed = "Q"): string =>
    ["ch", kind, "_"].join("") + body(seed);
  const scoped = (): string => `${["ch", "x_"].join("")}eyJyZWZzIjpbXX0.${body("M")}`;

  test("each issued shape is masked in prose with no context word", () => {
    for (const value of [secret("a"), secret("p"), secret("s"), secret("i"), scoped()]) {
      expect(maskCredentialTokens(`see ${value} upstream`)).toBe("see *** upstream");
      expect(maskCredentialTokens(`(${value})`)).toBe("(***)");
      expect(maskCredentialTokens(`x-${value}`)).toBe("x-***");
    }
  });

  test("a secret longer than 43 characters is masked whole", () => {
    expect(maskCredentialTokens(`${secret("s")}EXTRA tail`)).toBe("*** tail");
  });

  test("ids, digests, hints and short look-alikes are left alone", () => {
    for (const text of [
      "prn_01jbcdefghjkmnpqrstvwxyz01",
      "grt_01jbcdefghjkmnpqrstvwxyz01",
      "ab".repeat(32),
      `${["ch", "s_"].join("")}Ab9_`,
      ["ch", "s_"].join(""),
      `${["ch", "x_"].join("")}a.b`,
      `${["ch", "x_"].join("")}payload-without-a-mac`,
      `${["ch", "s_"].join("")}${body("Q").slice(0, 42)}`,
      `${["ch", "z_"].join("")}${body("Q")}`,
      `rich${["ch", "s_"].join("")}${body("Q")}`,
    ]) {
      expect(maskCredentialTokens(text)).toBe(text);
    }
  });

  test("a run of scoped-token prefixes with no mac is left whole, and a real one after it is masked", () => {
    const prefix = ["ch", "x_"].join("");
    const run = `${prefix}-`.repeat(200);
    expect(maskCredentialTokens(run)).toBe(run);
    expect(maskCredentialTokens(`${run} then ${scoped()}`)).toBe(`${run} then ***`);
  });
});

describe("redact.ts keep-in-sync duplication", () => {
  test("packages/ir/src/redact.ts and packages/spec-patch/src/redact.ts are byte-identical", () => {
    // The module is duplicated because @crewhaus/ir keeps zero package
    // dependencies and spec-patch must not depend on the IR layer. This
    // test is the sync guard the header comments promise.
    const here = join(import.meta.dir, "redact.ts");
    const mirror = join(import.meta.dir, "..", "..", "ir", "src", "redact.ts");
    expect(readFileSync(here, "utf-8")).toBe(readFileSync(mirror, "utf-8"));
  });
});

describe("carriesCredential", () => {
  // Built from parts at run time: no credential-shaped literal sits in the source.
  const token = ["sk", "ant", "api03", "x".repeat(24)].join("-");
  const bearer = ["tok", "en", "0123456789abcdef0123456789abcdef"].join("");

  test("a value that carries a credential is screened", () => {
    for (const value of [
      `curl -H "x-api-key: ${token}" https://api.example.com`,
      'curl -H "Authorization: Basic abc" https://api.example.com',
      "API_TOKEN=abc123 ./deploy.sh",
      "https://api.example.com/items?access_token=abc123",
      `curl -H "Authorization: Bearer ${bearer}" https://x.test`,
      "https://user:hunter2@example.com/items",
    ]) {
      expect({ value, carries: carriesCredential(value) }).toEqual({ value, carries: true });
    }
  });

  test("a value with no credential passes", () => {
    for (const value of [
      "curl -H 'Accept: text/plain' https://example.com?page=2",
      'curl -H "Accept: text/plain" https://x.test',
      "https://example.com/items?monkey=1",
      "MAX_TOKENS=5 ./run.sh",
      "Write(notes/a.md)",
      "git status && git log",
    ]) {
      expect({ value, carries: carriesCredential(value) }).toEqual({ value, carries: false });
    }
  });

  test("a URL is found wherever its scheme starts, inside a run of other characters too", () => {
    // A boundary: each URL is the one a scan from every start position finds,
    // so these hold for any correct URL scan, and fail if a scheme is missed.
    for (const value of [
      "1ab://u:pw@x",
      "x12+a.b-c://u:pw@h?q=1",
      "a:// b://u:pw@c",
      "git+ssh://h/x https://u:pw@y",
      "-https://u:pw@x",
      "..a://u:pw@b",
      `echo ${"a".repeat(50_000)} https://u:pw@x`,
      `${"1".repeat(50_000)}https://u:pw@x`,
    ]) {
      expect({ value: value.slice(0, 40), carries: carriesCredential(value) }).toEqual({
        value: value.slice(0, 40),
        carries: true,
      });
    }
    expect(carriesCredential(`echo ${"a".repeat(50_000)}`)).toBe(false);
  });
});

describe("credentialFormIn names the form a credential takes", () => {
  // Built at run time from random parts: no credential-shaped literal sits in the source.
  const short = (): string => randomBytes(6).toString("hex");
  const long = (): string => randomBytes(20).toString("hex");
  const token = ["sk", "ant", "api03", "x".repeat(24)].join("-");
  const bearer = ["tok", "en", "0123456789abcdef0123456789abcdef"].join("");

  const positives: ReadonlyArray<readonly [CredentialForm, string]> = [
    ["flag", `deploy --token ${short()}`],
    ["flag", `deploy --token=${short()}`],
    ["flag", `psql --password=${short()}`],
    ["flag", `cli --api-key ${short()}`],
    ["flag", `cli --secret '${short()}'`],
    ["flag", `curl --cookie "sid=${short()}" https://x.test`],
    ["flag", `cli -token ${short()}`],
    ["user-password", `curl -u admin:${short()} https://x.test`],
    ["user-password", `curl --user=admin:${short()} https://x.test`],
    ["user-password", `curl -uadmin:${short()} https://x.test`],
    ["user-password", `sudo /usr/bin/curl -U proxy:${short()} https://x.test`],
    ["user-password", `git status && curl --proxy-user "p:${short()}" https://x.test`],
    ["attached-password", `mysql -uroot -p${short()} app`],
    ["attached-password", `DB=1 mysqldump -p${short()} app`],
    ["attached-password", `echo hi; mariadb -p'${short()}' app`],
    ["header", `curl -H "Cookie: sid=${short()}" https://x.test`],
    ["header", `curl -H "Set-Cookie: sid=${short()}" https://x.test`],
    ["header", `curl -H "Proxy-Authorization: Basic ${short()}" https://x.test`],
    ["header", `curl -H "X-Auth-User: admin" https://x.test`],
    ["url-fragment", `https://x.test/cb#access_token=${short()}`],
    ["url-fragment", `https://x.test/cb#state=1&sig=${short()}`],
    ["url-token-user", `https://${long()}@x.test/o/r`],
    ["signed-url", `https://bucket.x.test/o?X-Amz-Signature=${short()}`],
    ["signed-url", `https://store.x.test/c?sv=1&sig=${short()}`],
    ["signed-url", `https://x.test/o?X-Goog-Signature=${short()}`],
    ["webhook-url", `https://hooks.slack.com/services/T0/B0/${short()}`],
    ["webhook-url", `https://hooks.slack.com/workflows/${short()}`],
    ["webhook-url", `https://hooks.slack.com/triggers/${short()}`],
    ["webhook-url", `https://discord.com/api/webhooks/1/${short()}`],
    ["webhook-url", `https://canary.discord.com/api/webhooks/1/${short()}`],
    ["webhook-url", `https://api.telegram.org/bot1:${short()}/sendMessage`],
    ["webhook-url", `https://discord.com/api/v10/webhooks/1/${short()}`],
    ["webhook-url", `https://hooks.slack.com./services/T0/B0/${short()}`],
    ["url-fragment", `https://app.x.test/#/reset?token=${short()}`],
    ["user-password", `curl "https://api.x.test/v1?a=1&b=2" -u admin:${short()}`],
    ["user-password", `curl 'https://x.test/(a)' -u admin:${short()}`],
    ["attached-password", `mysql -e "select 1; select 2" -p${short()} app`],
    ["user-password", `curl -sSu admin:${short()} https://x.test`],
    ["user-password", `curl -su admin:${short()} https://x.test/a`],
    ["user-password", `curl -sSLu admin:${short()} https://x.test/a`],
    ["user-password", `FOO="a b" curl -u admin:${short()} https://x.test`],
    ["user-password", `sudo -E curl -u admin:${short()} https://x.test`],
    ["user-password", `sudo -u ops curl -u admin:${short()} https://x.test`],
    ["attached-password", `sudo -E mysql -p${short()} app`],
    ["attached-password", `sudo -u mysql mysql -p${short()}`],
    ["user-password", `env -i curl -u admin:${short()} https://x.test`],
    ["user-password", `time curl -u admin:${short()} https://x.test`],
    ["user-password", `timeout 30 curl -u admin:${short()} https://x.test`],
    ["user-password", `command curl -u admin:${short()} https://x.test`],
    ["user-password", `xargs curl -u admin:${short()}`],
    ["user-password", `bash -c "curl -u admin:${short()} https://x.test"`],
    ["user-password", `"curl" -u admin:${short()} https://x.test`],
    ["user-password", `CURL -u admin:${short()} https://x.test`],
    ["user-password", `curl.exe -u admin:${short()} https://x.test`],
    ["user-password", `C:\\Windows\\System32\\curl.exe -u admin:${short()} https://x.test`],
    ["attached-password", `docker exec -i db mysql -uroot -p${short()} -e "select 1"`],
    ["attached-password", `kubectl exec db -- mysql -p${short()}`],
    ["header", `wget --header=X-Auth-Token:${short()} https://x.test`],
    ["header", `wget --header=Cookie:sid=${short()} https://x.test`],
  ];

  const negatives: ReadonlyArray<string> = [
    "cli --verbose",
    "cli --token-file ./t",
    "llm --max-tokens 5",
    "docker login --password-stdin",
    "pg --no-password db",
    "gh --token $GH_TOKEN",
    'gh --token "${GH_TOKEN}"',
    "cli --token --verbose",
    "curl -u admin https://x.test",
    "docker run -u 1000:1000 img",
    "mysql -p db",
    "ssh -p2222 h",
    "ssh -p 22 h",
    "docker run -p 8080:80 img",
    "nc -p 8080",
    "curl -H 'Accept: text/plain' https://x.test",
    "curl -H 'X-Request-Id: 1' https://x.test",
    "https://x.test/#section-2",
    "ssh://git@github.com/o/r",
    "https://user@host.test/",
    "https://x.test/?page=2",
    "https://x.test/?signed=1",
    "https://hooks.slack.com/",
    "https://hooks.slack.com/services/",
    "https://discord.com/channels/1",
    "https://api.telegram.org/",
    "wrangler deploy --env production",
    "docker run --env NODE_ENV=production img",
    "curl --headers x",
    "curl --key client.pem https://x.test",
    "ansible-playbook --private-key ~/.ssh/deploy site.yml",
    "docker run -p 8080:80 mysql",
    "curl -o out:put https://x.test",
    "curl -H 'X-Request-Id: 1' -u admin https://x.test",
    "wget --header=Accept:text/plain https://x.test",
    "docker run --label=env:prod img",
  ];

  test("each form is found and named", () => {
    for (const [form, value] of positives) {
      expect({ value, form: credentialFormIn(value), carries: carriesCredential(value) }).toEqual({
        value,
        form,
        carries: true,
      });
    }
  });

  test("an ordinary flag, header or URL passes", () => {
    for (const value of negatives) {
      expect({ value, form: credentialFormIn(value), carries: carriesCredential(value) }).toEqual({
        value,
        form: undefined,
        carries: false,
      });
    }
  });

  const firstForms: ReadonlyArray<readonly [CredentialForm, string]> = [
    ["token", `curl -H "x-api-key: ${token}" https://api.example.com`],
    ["header", 'curl -H "Authorization: Basic abc" https://api.example.com'],
    ["assignment", "API_TOKEN=abc123 ./deploy.sh"],
    ["url-query", "https://api.example.com/items?access_token=abc123"],
    ["token", `curl -H "Authorization: Bearer ${bearer}" https://x.test`],
    ["url-password", "https://user:hunter2@example.com/items"],
  ];

  test("each value the first checks flag keeps its form", () => {
    for (const [form, value] of firstForms) {
      expect({ value, form: credentialFormIn(value) }).toEqual({ value, form });
    }
  });

  test("every form has words, and every form has a row here", () => {
    const named = new Set([...positives, ...firstForms].map(([form]) => form));
    expect([...named].sort()).toEqual(Object.keys(CREDENTIAL_FORM_WORDS).sort());
    for (const words of Object.values(CREDENTIAL_FORM_WORDS))
      expect(words.length).toBeGreaterThan(0);
  });

  test("a long run of each form's lead characters is read correctly", () => {
    // Correctness only: each answer is the one the grammar gives at any length.
    const rows: ReadonlyArray<readonly [string, CredentialForm | undefined]> = [
      ["--a".repeat(16_667), undefined],
      [`${"--a".repeat(16_667)} --token abc`, "flag"],
      [`${"--a ".repeat(12_500)}x`, undefined],
      ["-p".repeat(25_000), undefined],
      [`mysql ${"-p".repeat(25_000)}`, "attached-password"],
      [`curl ${"-u ".repeat(16_667)}`, undefined],
      ["|".repeat(50_000), undefined],
      [`${"|".repeat(50_000)}curl -u a:b x`, "user-password"],
      [`https://x.test/${"#".repeat(50_000)}`, undefined],
      [`https://${"a".repeat(50_000)}@x.test/`, "url-token-user"],
      [`${"x-auth ".repeat(7_143)}`, undefined],
      [`${"x-auth-".repeat(7_143)}x: v`, "header"],
      [`https://hooks.slack.com/services/${"/".repeat(50_000)}`, undefined],
      ['"'.repeat(50_000), undefined],
      [`${"'a b' ".repeat(8_334)}curl -u a:b x`, "user-password"],
      ["\\".repeat(50_000), undefined],
      [`curl ${"-sS".repeat(16_667)}`, undefined],
      [`${"--header=".repeat(5_556)}`, undefined],
      [`${"bash -c ".repeat(6_250)}"curl -u a:b x"`, "user-password"],
    ];
    for (const [value, form] of rows) {
      expect({ value: value.slice(0, 40), form: credentialFormIn(value) }).toEqual({
        value: value.slice(0, 40),
        form,
      });
    }
  });
});
