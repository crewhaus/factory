/**
 * `RunOptions.isolatedEnv`: the child gets only the configuration its caller pins.
 * Every inherited `GIT_CONFIG_*` pair (a non-credential one too),
 * `GIT_CONFIG_PARAMETERS`, askpass and each named variable stay out; a caller that
 * does not ask for it runs with the environment it always had. The child's
 * environment is read back through a shell alias, the way git hands it on.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git-run";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "tool-git-isolated-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Built from parts: a value shaped like nothing a scanner knows. */
const SECRET = ["planted", "fake", "host", "value"].join("-");
const PLANTED: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.editor",
  GIT_CONFIG_VALUE_0: "planted-editor",
  GIT_CONFIG_PARAMETERS: "'user.name'='planted-name'",
  GIT_ASKPASS: "/bin/planted-askpass",
  SSH_ASKPASS: "/bin/planted-ssh-askpass",
  DELIVERY_FAKE_HOST: SECRET,
};
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const [name, value] of Object.entries(PLANTED)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

/** The environment git hands a shell alias it runs. */
async function childEnv(opts: Partial<Parameters<typeof runGit>[1]> = {}): Promise<string> {
  const run = await runGit(["envdump"], {
    cwd: dir,
    timeoutMs: 15_000,
    configArgs: ["-c", "alias.envdump=!env"],
    ...opts,
  });
  expect(run.code).toBe(0);
  return run.stdout;
}

describe("an isolated run", () => {
  test("keeps no inherited git configuration, askpass or dropped name, and passes the caller's own", async () => {
    const env = await childEnv({
      isolatedEnv: { dropNames: ["DELIVERY_FAKE_HOST"] },
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://example.test/.extraheader",
        GIT_CONFIG_VALUE_0: "X-Test: pinned",
      },
    });
    expect(env).not.toContain("planted-editor");
    expect(env).not.toContain("core.editor");
    // git sets GIT_CONFIG_PARAMETERS itself from the run's own `-c` pairs: the inherited value is gone.
    expect(env).not.toContain("planted-name");
    expect(env).not.toContain("planted-askpass");
    expect(env).not.toContain("DELIVERY_FAKE_HOST");
    expect(env).not.toContain(SECRET);
    expect(env).toContain("GIT_CONFIG_COUNT=1\n");
    expect(env).toContain("GIT_CONFIG_KEY_0=http.https://example.test/.extraheader\n");
    expect(env).toContain("GIT_CONFIG_VALUE_0=X-Test: pinned\n");
  });

  test("the credential filter alone keeps the inherited pair and the oddly named variable", async () => {
    // What the isolated run adds over a read's filter: a read keeps both.
    const read = await childEnv({ readOnly: true });
    expect(read).toContain("planted-editor");
    expect(read).toContain(SECRET);
  });

  test("a caller that does not ask runs with the environment it always had", async () => {
    const write = await childEnv();
    expect(write).toContain("planted-editor");
    expect(write).toContain(`DELIVERY_FAKE_HOST=${SECRET}`);
    expect(write).toContain("GIT_ASKPASS=/bin/planted-askpass");
  });
});
