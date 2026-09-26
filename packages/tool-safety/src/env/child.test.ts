import { describe, expect, test } from "bun:test";
import { withoutCredentials } from "./child";

// Secret-shaped values are built from parts, so no literal here trips a
// push-protection scanner.
const ANTHROPIC = ["sk-ant-api03-", "A".repeat(24), "b".repeat(8)].join("");
const GITHUB = ["gh", "p_", "F".repeat(36)].join("");

const PARENT = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/dev",
  CARGO_HOME: "/home/dev/.cargo",
  RUSTUP_HOME: "/home/dev/.rustup",
  GOPATH: "/home/dev/go",
  VIRTUAL_ENV: "/work/.venv",
  HTTPS_PROXY: "http://proxy.internal:3128",
  SSL_CERT_FILE: "/etc/ssl/corp.pem",
  NODE_OPTIONS: "--max-old-space-size=4096",
  ANTHROPIC_API_KEY: ANTHROPIC,
  GITHUB_TOKEN: GITHUB,
  PGPASSWORD: "hunter2",
  DATABASE_URL: "postgres://u:p@db/app",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  // A secret under a name that says nothing: caught by its value.
  DEPLOY_THING: GITHUB,
  UNSET: undefined,
} as const;

describe("withoutCredentials", () => {
  test("keeps what a toolchain needs and drops every credential, by name and by value", () => {
    const { env, removed } = withoutCredentials(PARENT);
    expect(removed).toEqual([
      "ANTHROPIC_API_KEY",
      "DATABASE_URL",
      "DEPLOY_THING",
      "GITHUB_TOKEN",
      "PGPASSWORD",
      "SSH_AUTH_SOCK",
    ]);
    expect(Object.keys(env).sort()).toEqual([
      "CARGO_HOME",
      "GOPATH",
      "HOME",
      "HTTPS_PROXY",
      "NODE_OPTIONS",
      "PATH",
      "RUSTUP_HOME",
      "SSL_CERT_FILE",
      "VIRTUAL_ENV",
    ]);
    const text = JSON.stringify(env);
    for (const secret of [ANTHROPIC, GITHUB, "hunter2", "postgres://u:p@db/app"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("a path list is never taken for a pasted token", () => {
    // 24+ characters, mixed case, digits and no underscore: the shape
    // looksLikePastedSecret calls random. The separators are what keep it.
    const path = "/Users/Dev9/Library/Bin2:/opt/Tools3/bin";
    expect(withoutCredentials({ PATH: path, EXTRA_PATH: path }).env).toEqual({
      PATH: path,
      EXTRA_PATH: path,
    });
  });

  test("a URL carrying a credential is dropped under any name; a plain URL is kept (C006)", () => {
    const pypi = ["pypi-", "AgEIcHlwaS5vcmcCJGFiY2RlZg"].join("");
    const parent = {
      PIP_INDEX_URL: `https://ci-bot:${pypi}@pypi.example.com/simple`,
      PIP_EXTRA_INDEX_URL: `https://__token__:${pypi}@extra.example.com/simple`,
      UV_INDEX_URL: `https://${GITHUB}@uv.example.com/simple`,
      HTTPS_PROXY: "http://proxyuser:hunter2@proxy.corp:3128",
      http_proxy: "http://proxyuser:hunter2@proxy.corp:3128",
      ALL_PROXY: "socks5://u:pw@socks.corp:1080",
      GOPROXY: "https://gouser:gopass123@goproxy.corp,direct",
      NPM_CONFIG_REGISTRY: `https://registry.example.com/?auth=${GITHUB}`,
      EXTRA_HEADER: `Bearer ${"t".repeat(12)}`,
      GIT_HEADER: `Authorization: token ${"t".repeat(12)}`,
      // No credential in these: kept.
      NO_PROXY: "localhost,127.0.0.1,.corp",
      PLAIN_PROXY: "http://proxy.corp:3128",
      GOPROXY_PLAIN: "https://proxy.golang.org,direct",
      MESSAGE: "basic setup done",
    };
    const { env, removed } = withoutCredentials(parent);
    expect(removed).toEqual([
      "ALL_PROXY",
      "EXTRA_HEADER",
      "GIT_HEADER",
      "GOPROXY",
      "HTTPS_PROXY",
      "NPM_CONFIG_REGISTRY",
      "PIP_EXTRA_INDEX_URL",
      "PIP_INDEX_URL",
      "UV_INDEX_URL",
      "http_proxy",
    ]);
    expect(Object.keys(env).sort()).toEqual([
      "GOPROXY_PLAIN",
      "MESSAGE",
      "NO_PROXY",
      "PLAIN_PROXY",
    ]);
    const text = JSON.stringify(env);
    for (const secret of [pypi, GITHUB, "hunter2", "gopass123", "pw@"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("git's environment config stays one unit: a credential pair goes, the rest renumber", () => {
    // `KEY` marks a credential-shaped name, so a name-by-name filter dropped
    // GIT_CONFIG_KEY_0 and kept GIT_CONFIG_COUNT, and git refused to start.
    const header = `AUTHORIZATION: basic ${"Q".repeat(16)}`;
    const { env, removed } = withoutCredentials({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
      GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_1: header,
      GIT_CONFIG_KEY_2: "core.autocrlf",
      GIT_CONFIG_VALUE_2: "false",
      // Past the count: git never reads it.
      GIT_CONFIG_KEY_7: "user.name",
      GIT_CONFIG_VALUE_7: "x",
    });
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
      GIT_CONFIG_KEY_1: "core.autocrlf",
      GIT_CONFIG_VALUE_1: "false",
    });
    expect(removed).toEqual([
      "GIT_CONFIG_KEY_1",
      "GIT_CONFIG_KEY_7",
      "GIT_CONFIG_VALUE_1",
      "GIT_CONFIG_VALUE_7",
    ]);
    // Every pair a credential: no count at all, rather than a count of 0.
    const none = withoutCredentials({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "store",
    });
    expect(none.env).toEqual({});
    // A count git would reject is not config git reads.
    expect(withoutCredentials({ GIT_CONFIG_COUNT: "x", GIT_CONFIG_KEY_0: "a.b" }).env).toEqual({});
  });

  test("the pinned values are applied last and win", () => {
    const { env } = withoutCredentials({ LC_ALL: "de_DE.UTF-8", CI: "" }, { LC_ALL: "C", CI: "1" });
    expect(env).toEqual({ LC_ALL: "C", CI: "1" });
  });
});
