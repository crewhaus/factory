/**
 * A stdio server started with Bun reads no env file of the directory it runs in: its
 * environment is what the daemon gives it, so a loader setting in the harness's `.env`
 * never reaches the server or what it starts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { stdioLaunch } from "./client.js";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("stdioLaunch", () => {
  test("bun, bunx and bun x start with --no-env-file", () => {
    expect(stdioLaunch("bun", ["tools/server.ts"])).toEqual({
      command: "bun",
      args: ["--no-env-file", "tools/server.ts"],
    });
    expect(stdioLaunch("/opt/bin/bunx", ["pkg"]).args).toEqual(["--no-env-file", "pkg"]);
    expect(stdioLaunch("bun", ["x", "pkg"]).args).toEqual(["--no-env-file", "x", "pkg"]);
    expect(stdioLaunch("C:\\bun\\BUN.EXE", undefined).args).toEqual(["--no-env-file"]);
    expect(stdioLaunch("bun", ["--no-env-file", "a.ts"]).args).toEqual(["--no-env-file", "a.ts"]);
  });

  test("any other command is launched as declared", () => {
    expect(stdioLaunch("node", ["server.js"])).toEqual({ command: "node", args: ["server.js"] });
    expect(stdioLaunch("npx", undefined)).toEqual({ command: "npx", args: undefined });
    expect(stdioLaunch("/opt/bunny", ["a"]).args).toEqual(["a"]);
  });
});

describe("a stdio server run by Bun in the harness directory", () => {
  test.skipIf(process.platform === "win32")(
    "never loads a loader setting from the harness's .env, nor passes one on",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "mcphost-envfile-"));
      roots.push(dir);
      const marker = join(dir, "preloaded");
      const out = join(dir, "out.json");
      writeFileSync(join(dir, ".env"), "BUN_OPTIONS=--preload ./pre.ts\nFROM_FILE=1\n");
      writeFileSync(
        join(dir, "pre.ts"),
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`,
      );
      // The server starts one Bun grandchild with its own environment, reading no env file
      // itself, so what it prints is what the server passed on.
      writeFileSync(
        join(dir, "server.ts"),
        [
          "const child = Bun.spawnSync(",
          '  [process.execPath, "--no-env-file", "-e", "console.log(process.env.BUN_OPTIONS ?? String())"],',
          "  { env: { ...process.env } },",
          ");",
          `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({`,
          "  options: process.env.BUN_OPTIONS ?? null,",
          "  fromFile: process.env.FROM_FILE ?? null,",
          "  grandchild: child.stdout.toString().trim(),",
          "}));",
        ].join("\n"),
      );
      const launch = stdioLaunch(process.execPath, [join(dir, "server.ts")]);
      const transport = new StdioClientTransport({ ...launch, cwd: dir, stderr: "ignore" });
      await transport.start();
      // Bounded wait for the server to write its answer; nothing is asserted about time.
      for (let i = 0; i < 400 && !existsSync(out); i++) await Bun.sleep(25);
      await transport.close();
      const seen = JSON.parse(readFileSync(out, "utf8")) as {
        options: string | null;
        fromFile: string | null;
        grandchild: string;
      };
      expect(seen).toEqual({ options: null, fromFile: null, grandchild: "" });
      expect(existsSync(marker)).toBe(false);
    },
    20_000, // three real Bun processes
  );
});
