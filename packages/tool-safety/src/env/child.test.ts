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

  test("the pinned values are applied last and win", () => {
    const { env } = withoutCredentials({ LC_ALL: "de_DE.UTF-8", CI: "" }, { LC_ALL: "C", CI: "1" });
    expect(env).toEqual({ LC_ALL: "C", CI: "1" });
  });
});
