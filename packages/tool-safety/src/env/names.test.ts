import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  credentialShapeOf,
  isCredentialShapedName,
  isEnvName,
  looksLikePastedSecret,
  nameWords,
} from "./names";

describe("isCredentialShapedName", () => {
  test("names that hold credentials, in the spellings the audit's proofs used", () => {
    const credentials = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SESSION_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_SIGNING_SECRET",
      "APP_JWT_SECRET",
      "EXCHANGE_API_SECRET",
      "UNRELATED_CLOUD_SECRET",
      "PLANTED_API_KEY",
      "DB_PASSWORD",
      "PGPASSWORD",
      "MYSQL_PWD",
      "SMTP_PASS",
      "GITHUB_PAT",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "DOCKER_AUTH_CONFIG",
      "SENTRY_DSN",
      "DATABASE_URL",
      "REDIS_URL",
      "MONGODB_URI",
      "SLACK_WEBHOOK_URL",
      "AZURE_STORAGE_CONNECTION_STRING",
      "ENCRYPTION_KEY",
      "PASSPHRASE",
      "COOKIE_SECRET",
      "KEY",
      "KEY2",
      "apiKey",
      "APIKey",
      "clientSecret",
      "x-api-key",
      "Authorization",
      "pwd",
    ];
    const missed = credentials.filter((n) => !isCredentialShapedName(n));
    expect(missed).toEqual([]);
  });

  test("ordinary variables are not flagged, including those that contain a credential word", () => {
    const ordinary = [
      "PATH",
      "PATHEXT",
      "HOME",
      "PWD",
      "OLDPWD",
      "NODE_ENV",
      "PORT",
      "HOST",
      "LANG",
      "TZ",
      "TERM",
      "SHELL",
      "USER",
      "TMPDIR",
      "CI",
      "LOG_LEVEL",
      "KEYBOARD_LAYOUT",
      "MONKEY",
      "BYPASS_CACHE",
      "COMPASS_URL",
      "NEXT_PUBLIC_SITE_URL",
      "OAUTH_CLIENT_ID",
      "CREWHAUS_SESSION_DIR",
    ];
    const flagged = ordinary.filter((n) => isCredentialShapedName(n));
    expect(flagged).toEqual([]);
  });

  test("the reason names the word that matched", () => {
    expect(credentialShapeOf("ANTHROPIC_API_KEY")).toBe("APIKEY");
    expect(credentialShapeOf("GITHUB_PAT")).toBe("PAT");
    expect(credentialShapeOf("DATABASE_URL")).toBe("DATABASE URL");
    expect(credentialShapeOf("PATH")).toBeUndefined();
  });

  test("words split on separators and camelCase, with trailing digits dropped", () => {
    expect(nameWords("ANTHROPIC_API_KEY")).toEqual(["ANTHROPIC", "API", "KEY"]);
    expect(nameWords("apiKey")).toEqual(["API", "KEY"]);
    expect(nameWords("APIKey2")).toEqual(["API", "KEY"]);
    expect(nameWords("x-api.key")).toEqual(["X", "API", "KEY"]);
    expect(nameWords("__")).toEqual([]);
  });

  test("a caller-sized name costs linear time", () => {
    // 1.5M characters: about 60 ms when linear on a laptop. The first
    // version read the last character of a string built with `+=`, which
    // flattens it each time, and took about 13 s here.
    const name = `${"9".repeat(750_000)}a${"A".repeat(750_000)}`;
    const started = performance.now();
    isCredentialShapedName(name);
    looksLikePastedSecret(name);
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 20_000);
});

describe("looksLikePastedSecret", () => {
  test("tokens pasted where a NAME belongs", () => {
    const pasted = [
      `ghp_${"A1b2C3d4".repeat(5)}`,
      `github_pat_${"x".repeat(30)}`,
      `sk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`,
      `sk-ant-api03-${"x".repeat(30)}`,
      `xoxb-${"1".repeat(20)}`,
      `npm_${"a".repeat(36)}`,
      `hf_${"b".repeat(34)}`,
      "AKIAIOSFODNN7EXAMPLE",
      `AC${"0123456789abcdef".repeat(2)}`,
      "0123456789abcdef0123456789abcdef01234567",
      "aB3dE5fG7hJ9kL1mN3pQ5rS7",
      `dop_v1_${"c".repeat(64)}`,
      `shpat_${"d".repeat(32)}`,
      `AIza${"e".repeat(35)}`,
      `xapp-1-${"f".repeat(20)}`,
      "Bearer abcdefgh12345678",
    ];
    expect(pasted.filter((v) => !looksLikePastedSecret(v))).toEqual([]);
  });

  test("real variable names are never taken for secrets", () => {
    const names = [
      "NPM_TOKEN",
      "HF_HOME",
      "HF_TOKEN",
      "pk_version",
      "GITHUB_TOKEN",
      "SKIP_PREFLIGHT_CHECK",
      "sk_config",
      "ANTHROPIC_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "CREWHAUS_CONTROL_PORT",
      "MyServiceConfiguration",
    ];
    expect(names.filter((v) => looksLikePastedSecret(v))).toEqual([]);
  });

  test("isEnvName accepts POSIX names only", () => {
    expect(isEnvName("GITHUB_TOKEN")).toBe(true);
    expect(isEnvName("_x1")).toBe(true);
    expect(isEnvName("1X")).toBe(false);
    expect(isEnvName("sk-ant-x")).toBe(false);
    expect(isEnvName("A B")).toBe(false);
    expect(isEnvName("A".repeat(129))).toBe(false);
    expect(isEnvName(undefined)).toBe(false);
  });
});

/**
 * The repo's other copies of "this key names a credential". Each was written
 * for its own package; this one must flag everything any of them flags, so
 * a package can switch to it without losing a name. The sweep finds the
 * copies by SHAPE, not from a list, and pins how many it finds: a new copy
 * fails this test until it is either checked here or replaced by an import.
 */
describe("isCredentialShapedName covers every other copy in the repo", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) sourceFiles(p, out);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
    }
    return out;
  }

  /**
   * `const X = /…KEY…TOKEN…/i;`-shaped literals, and exported
   * `isCredentialKey` functions. A literal anchored at the end (`…$/`)
   * classifies a NAME; an unanchored one scans text for context words
   * (`password=` in a log line) and answers a different question, so it is
   * listed but not compared.
   */
  function findCopies(): {
    regexes: Array<{ file: string; re: RegExp }>;
    scanners: string[];
    functions: string[];
  } {
    const regexes: Array<{ file: string; re: RegExp }> = [];
    const scanners: string[] = [];
    const functions: string[] = [];
    for (const top of ["packages", "apps"]) {
      for (const pkg of readdirSync(join(repoRoot, top))) {
        if (pkg === "tool-safety") continue;
        const src = join(repoRoot, top, pkg, "src");
        let files: string[];
        try {
          files = sourceFiles(src);
        } catch {
          continue;
        }
        for (const file of files) {
          const text = readFileSync(file, "utf8");
          for (const m of text.matchAll(
            /(?:const|let)\s+\w+\s*=\s*\/((?:[^/\\\n]|\\.)+)\/([a-z]*)\s*;/g,
          )) {
            const source = m[1] as string;
            if (/KEY/i.test(source) && /TOKEN|SECRET|PASSWORD/i.test(source)) {
              if (source.endsWith("$")) {
                regexes.push({ file: relative(repoRoot, file), re: new RegExp(source, m[2]) });
              } else {
                scanners.push(relative(repoRoot, file));
              }
            }
          }
          if (/export function isCredentialKey\(/.test(text)) functions.push(file);
        }
      }
    }
    return { regexes, scanners, functions };
  }

  const copies = findCopies();

  test("the sweep finds the copies it is meant to check", () => {
    // compiler + preflight CREDENTIAL_SHAPED_KEY_RE, tool-secrets
    // SECRETISH_KEY_RE, tool-crewhaus's CLI-flag CREDENTIAL_FLAG_RE.
    expect(copies.regexes.map((c) => c.file).sort()).toEqual([
      "packages/compiler/src/index.ts",
      "packages/preflight/src/secret-grammar.ts",
      "packages/tool-crewhaus/src/lib/spec-view.ts",
      "packages/tool-secrets/src/index.ts",
    ]);
    // run-context's SECRET_ASSIGNMENT and tool-secure's CREDENTIAL_CONTEXT
    // find `password=` or `token:` inside text.
    expect(copies.scanners.sort()).toEqual([
      "packages/run-context/src/index.ts",
      "packages/tool-secure/src/lib/secrets.ts",
    ]);
    // ir and spec-patch carry byte-identical isCredentialKey functions.
    expect(copies.functions).toHaveLength(2);
  });

  /** Names built from every capitalised word the copies mention, in every spelling they accept. */
  function corpus(): string[] {
    const words = new Set<string>();
    for (const { re } of copies.regexes) {
      for (const w of re.source.match(/[A-Za-z]{2,}/g) ?? []) words.add(w.toUpperCase());
    }
    for (const w of ["key", "token", "secret", "password", "passwd", "pwd", "auth"]) words.add(w);
    const out = new Set<string>();
    for (const w of words) {
      const lower = w.toLowerCase();
      const cap = lower[0]?.toUpperCase() + lower.slice(1);
      for (const name of [
        w,
        lower,
        `MY_${w}`,
        `my_${lower}`,
        `my-${lower}`,
        `my${cap}`,
        `API_${w}`,
        `A1_${w}`,
        `${w}_ID`,
        `x_${w}S`,
      ]) {
        out.add(name);
      }
    }
    for (const exact of [
      "apikey",
      "api_key",
      "api-key",
      "authorization",
      "credential",
      "credentials",
      "keyref",
      "key_ref",
      "key-ref",
      "privatekey",
      "private_key",
      "private-key",
      "botToken",
      "signingSecret",
      "monkey",
      "max_tokens",
      "PATH",
      "PWD",
    ]) {
      out.add(exact);
    }
    return [...out];
  }

  test("every name any copy flags, this flags too", async () => {
    const names = corpus();
    const isCredentialKeys: Array<(k: string) => boolean> = [];
    for (const file of copies.functions) {
      const mod = (await import(file)) as { isCredentialKey: (k: string) => boolean };
      isCredentialKeys.push(mod.isCredentialKey);
    }
    // Two deliberate differences. `headers` and `env` are map keys in a spec
    // (the maps that HOLD credentials), not the name of one. `PWD` and
    // `OLDPWD`, spelled exactly so, are the shell's working directories.
    const containers = new Set(["headers", "env"]);
    const shellDirs = new Set(["PWD", "OLDPWD"]);
    const missed: string[] = [];
    let flaggedByCopies = 0;
    for (const name of names) {
      if (shellDirs.has(name)) continue;
      const byCopy =
        copies.regexes.some(({ re }) => re.test(name)) ||
        (!containers.has(name.toLowerCase()) && isCredentialKeys.some((f) => f(name)));
      if (!byCopy) continue;
      flaggedByCopies += 1;
      if (!isCredentialShapedName(name)) missed.push(name);
    }
    expect(missed).toEqual([]);
    // The corpus exercises the copies, not just this function.
    expect(flaggedByCopies).toBeGreaterThan(100);
  });
});
