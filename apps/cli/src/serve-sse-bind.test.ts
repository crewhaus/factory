/**
 * `crewhaus serve --mcp --sse` against the real CLI: where it listens and which
 * requests it answers. The CLI is spawned as a child process (the entry file
 * runs an argv switch on import). No model is called: `initialize` and
 * `tools/list` never run an agent turn, so no credential is needed.
 *
 * A request to the address the server bound says nothing about which bind it
 * made, so the address comes from `lsof`, and a request to this machine's own
 * non-loopback address has to be refused.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");
const CLI_SPEC = join(SRC_DIR, "..", "test-fixtures", "minimal-cli", "crewhaus.yaml");

// `serve --mcp` opens an audit chain under its cwd and registers the harness it
// touches, so both stay in throwaway directories.
const SANDBOX = mkdtempSync(join(tmpdir(), "crewhaus-serve-sse-bind-"));
const CHILD_ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "",
  CREWHAUS_REGISTRY_ROOT: join(SANDBOX, "registry"),
  CREWHAUS_WATCHME_ROOT: join(SANDBOX, "watchme"),
};

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

/** A port nothing is listening on right now; `--port` takes no 0. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("the probe server has no port");
  return port;
}

/**
 * Read `stream` until `marker` appears, and give back everything read. The
 * stream stays open, so the server can go on writing to its stdout.
 */
async function readUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`the server stopped before it printed "${marker}":\n${text}`);
    text += decoder.decode(value, { stream: true });
    if (text.includes(marker)) {
      reader.releaseLock();
      return text;
    }
  }
}

/** Boot the CLI with `args`, wait for its banner, run `body`, then stop it. */
async function withServer(
  args: ReadonlyArray<string>,
  body: (banner: string) => Promise<void>,
): Promise<void> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, "serve", "--mcp", ...args], {
    cwd: SANDBOX,
    env: CHILD_ENV,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    await body(await readUntil(proc.stdout, "POST MCP requests to /"));
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

/** The LISTEN rows `lsof` reports for `port`. */
function listenRows(port: number): string[] {
  const lsof = Bun.which("lsof", { PATH: `${CHILD_ENV["PATH"]}:/usr/sbin:/usr/bin` });
  if (lsof === null) throw new Error("this check needs lsof on PATH");
  const out = Bun.spawnSync([lsof, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return out.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes("(LISTEN)"));
}

/** `lsof` where it exists; the banner stands in for it on Windows. */
function expectBoundToLoopback(port: number, banner: string): void {
  expect(banner).toContain(`http://127.0.0.1:${port}, this computer only`);
  if (process.platform === "win32") return;
  const rows = listenRows(port);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row).toContain(`127.0.0.1:${port} (LISTEN)`);
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
});
const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const ACCEPT = "application/json, text/event-stream";

describe("crewhaus serve --mcp --sse", () => {
  test("listens on loopback, and answers only a request that names this computer", async () => {
    const port = freePort();
    await withServer([CLI_SPEC, "--sse", "--port", String(port)], async (banner) => {
      expectBoundToLoopback(port, banner);

      const url = `http://127.0.0.1:${port}/`;
      const post = (headers: Record<string, string>, body: string = INITIALIZE) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: ACCEPT, ...headers },
          body,
        });

      // This machine's own non-loopback address: nothing is listening there.
      const external = Object.values(networkInterfaces())
        .flat()
        .find((address) => address !== undefined && !address.internal && address.family === "IPv4");
      if (external !== undefined) {
        const outcome = await fetch(`http://${external.address}:${port}/`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: ACCEPT },
          body: INITIALIZE,
          signal: AbortSignal.timeout(5_000),
        }).then(
          (response) => `answered ${response.status}`,
          (err: { code?: string }) => err.code,
        );
        expect(outcome).toBe("ConnectionRefused");
      }

      // The loopback Host, a session, and a tool list through that session.
      const opened = await post({ host: `127.0.0.1:${port}` });
      expect(opened.status).toBe(200);
      const session = opened.headers.get("mcp-session-id");
      expect(session).toBeTruthy();
      await opened.text();
      const listed = await post(
        { host: `127.0.0.1:${port}`, "mcp-session-id": session as string },
        TOOLS_LIST,
      );
      expect(listed.status).toBe(200);
      expect(await listed.text()).toContain('"chat"');

      // Another name in Host: refused by this check, with no session.
      const otherHost = await post({ host: "other.example" });
      expect(otherHost.status).toBe(403);
      expect(otherHost.headers.get("mcp-session-id")).toBeNull();
      expect(await otherHost.text()).toBe("this server only answers on this computer");

      // The same refusal for a session that is already open.
      const otherHostInSession = await post(
        { host: `other.example:${port}`, "mcp-session-id": session as string },
        TOOLS_LIST,
      );
      expect(otherHostInSession.status).toBe(403);

      // Another name in Origin, with this computer in Host: the same refusal.
      const otherOrigin = await post({
        host: `127.0.0.1:${port}`,
        "content-type": "text/plain; application/json",
        origin: "https://other.example",
      });
      expect(otherOrigin.status).toBe(403);
      expect(otherOrigin.headers.get("mcp-session-id")).toBeNull();
      expect(await otherOrigin.text()).toBe("this server only answers on this computer");

      // A page on this computer is still welcome.
      const localOrigin = await post({
        host: `127.0.0.1:${port}`,
        origin: "http://localhost:3000",
      });
      expect(localOrigin.status).toBe(200);
      await localOrigin.text();
    });
  }, 20_000); // Spawns the CLI, which is slow by construction.

  test("a spec's expose.mcp.transport: sse gets the same listener, with no flag", async () => {
    const port = freePort();
    const spec = join(SANDBOX, "expose-sse.yaml");
    writeFileSync(
      spec,
      [
        "name: hello",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: Be helpful.",
        "expose:",
        "  mcp:",
        "    transport: sse",
        "",
      ].join("\n"),
    );
    await withServer([spec, "--port", String(port)], async (banner) => {
      expectBoundToLoopback(port, banner);
      const refused = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: ACCEPT, host: "other.example" },
        body: INITIALIZE,
      });
      expect(refused.status).toBe(403);
    });
  }, 20_000); // Spawns the CLI, which is slow by construction.
});
