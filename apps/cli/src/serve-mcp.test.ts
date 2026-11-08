import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SERVE_MCP_DEFAULT_PORT,
  SERVE_MCP_SUPPORTED_TARGET,
  SERVE_MCP_USAGE,
  SERVE_TOKEN_ENV,
  SERVE_TOKEN_FILE,
  ServeMcpError,
  assertServeTargetSupported,
  assertToolsModeSatisfiable,
  buildMcpSubAgentDescriptors,
  filterChildTools,
  isLoopbackRequest,
  resolveMcpToolsMode,
  resolveMcpTransport,
  resolveServeBearer,
  resolveServePort,
  serveRequestRefusal,
} from "./serve-mcp";

describe("resolveMcpTransport", () => {
  test("--sse forces sse over any spec transport", () => {
    expect(resolveMcpTransport(true, "stdio")).toBe("sse");
    expect(resolveMcpTransport(true, undefined)).toBe("sse");
  });
  test("without --sse, the spec's expose.transport decides", () => {
    expect(resolveMcpTransport(false, "sse")).toBe("sse");
    expect(resolveMcpTransport(false, "stdio")).toBe("stdio");
  });
  test("no flag + no expose block → stdio (the default projection)", () => {
    expect(resolveMcpTransport(false, undefined)).toBe("stdio");
  });
});

describe("isLoopbackRequest", () => {
  /** A request with exactly these headers; `Request` itself never adds a Host or an Origin. */
  const request = (headers: Record<string, string>): Request =>
    new Request("http://127.0.0.1:8000/", { method: "POST", headers });

  test.each(["127.0.0.1:8000", "localhost:8000", "localhost", "[::1]:8000", "[::1]", "LOCALHOST"])(
    "a Host of %s names this computer",
    (host) => {
      expect(isLoopbackRequest(request({ host }))).toBe(true);
    },
  );

  test.each([
    "other.example",
    "other.example:8000",
    "127.0.0.1.other.example",
    "localhost.other.example",
    "[::1].other.example",
    "[::1",
    "127.0.0.1:8000:9",
    "localhost:8000, other.example",
    "",
  ])("a Host of '%s' does not", (host) => {
    expect(isLoopbackRequest(request({ host }))).toBe(false);
  });

  test("a request with no Host at all does not", () => {
    expect(request({}).headers.get("host")).toBeNull();
    expect(isLoopbackRequest(request({}))).toBe(false);
  });

  test.each([
    "http://127.0.0.1:1",
    "http://localhost",
    "http://localhost:3000",
    "http://[::1]:3000",
  ])("with a loopback Host, an Origin of %s names this computer", (origin) => {
    expect(isLoopbackRequest(request({ host: "127.0.0.1:8000", origin }))).toBe(true);
  });

  test.each([
    "https://other.example",
    "http://127.0.0.1.other.example",
    "http://localhost.other.example",
    "null",
    "not a url",
  ])("with a loopback Host, an Origin of %s does not", (origin) => {
    expect(isLoopbackRequest(request({ host: "127.0.0.1:8000", origin }))).toBe(false);
  });

  test("a loopback Host with no Origin is enough", () => {
    expect(isLoopbackRequest(request({ host: "127.0.0.1:8000" }))).toBe(true);
  });

  test("a loopback Origin does not make up for another Host", () => {
    expect(isLoopbackRequest(request({ host: "other.example", origin: "http://localhost" }))).toBe(
      false,
    );
  });
});

describe("serveRequestRefusal", () => {
  const TOKEN = "a".repeat(64);
  /** A POST with exactly these headers, and this computer in Host unless they say otherwise. */
  const request = (headers: Record<string, string>): Request =>
    new Request("http://127.0.0.1:8000/", {
      method: "POST",
      headers: { host: "127.0.0.1:8000", ...headers },
    });

  /** The 401 a request without this listener's bearer gets, with the reason it is refused. */
  async function expectAskedForBearer(response: Response | undefined): Promise<void> {
    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toBe("Bearer");
    expect(response?.headers.get("content-type")).toBe("application/json");
    expect(await response?.json()).toEqual({
      error: "unauthorized: send Authorization: Bearer <token>",
    });
  }

  test("this computer in Host and the right bearer: answered", () => {
    expect(
      serveRequestRefusal(request({ authorization: `Bearer ${TOKEN}` }), TOKEN),
    ).toBeUndefined();
    expect(
      serveRequestRefusal(
        request({ authorization: `Bearer ${TOKEN}`, origin: "http://localhost:3000" }),
        TOKEN,
      ),
    ).toBeUndefined();
  });

  test.each([
    ["no Authorization header", {}],
    ["a wrong token", { authorization: "Bearer wrong" }],
    ["the right token with a lower-case scheme", { authorization: `bearer ${TOKEN}` }],
    ["another scheme", { authorization: `Basic ${btoa(`user:${TOKEN}`)}` }],
    ["the scheme with no token", { authorization: "Bearer " }],
    ["the right token with more after it", { authorization: `Bearer ${TOKEN}0` }],
    ["a prefix of the right token", { authorization: `Bearer ${TOKEN.slice(0, 32)}` }],
  ] as const)("%s: asked for the bearer", async (_label, headers) => {
    await expectAskedForBearer(serveRequestRefusal(request(headers), TOKEN));
  });

  test("another name in Host is refused by the Host check first, even with the right bearer", async () => {
    const refused = serveRequestRefusal(
      request({ host: "other.example", authorization: `Bearer ${TOKEN}` }),
      TOKEN,
    );
    expect(refused?.status).toBe(403);
    expect(await refused?.text()).toBe("this server only answers on this computer");
  });

  test("another Origin is refused by the Host check first, even with the right bearer", () => {
    const refused = serveRequestRefusal(
      request({ origin: "https://other.example", authorization: `Bearer ${TOKEN}` }),
      TOKEN,
    );
    expect(refused?.status).toBe(403);
  });

  test.each([
    ["another name in Host", { host: "other.example" }],
    ["another Origin", { origin: "https://other.example" }],
  ] as const)(
    "%s with no bearer at all: refused by the Host check first",
    async (_label, headers) => {
      // The order of the two checks: a caller that fails both hears about the Host.
      const refused = serveRequestRefusal(request(headers), TOKEN);
      expect(refused?.status).toBe(403);
      expect(refused?.headers.get("www-authenticate")).toBeNull();
      expect(await refused?.text()).toBe("this server only answers on this computer");
    },
  );
});

describe("resolveServeBearer", () => {
  const ROOTS: string[] = [];
  afterAll(() => {
    for (const root of ROOTS) {
      // A read-only directory from the last test has to be writable to go.
      try {
        chmodSync(join(root, ".crewhaus", "run"), 0o700);
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });
  const fresh = (): string => {
    const root = mkdtempSync(join(tmpdir(), "crewhaus-serve-bearer-"));
    ROOTS.push(root);
    return root;
  };
  const posix = process.platform !== "win32";

  test("the variable wins, and nothing is written", () => {
    const cwd = fresh();
    expect(resolveServeBearer({ cwd, env: { [SERVE_TOKEN_ENV]: "from-the-variable" } })).toEqual({
      token: "from-the-variable",
      source: SERVE_TOKEN_ENV,
    });
    expect(existsSync(join(cwd, ".crewhaus"))).toBe(false);
  });

  test("an empty variable counts as unset", () => {
    const cwd = fresh();
    const bearer = resolveServeBearer({ cwd, env: { [SERVE_TOKEN_ENV]: "" } });
    expect(bearer.source).toBe(`${SERVE_TOKEN_FILE} (minted this boot, 0600)`);
    expect(existsSync(join(cwd, SERVE_TOKEN_FILE))).toBe(true);
  });

  test("otherwise 64 hex characters and a newline, saved at 0600 beside a .gitignore of *", () => {
    const cwd = fresh();
    const bearer = resolveServeBearer({ cwd, env: {} });
    expect(bearer.token).toMatch(/^[0-9a-f]{64}$/);
    expect(bearer.source).toBe(".crewhaus/run/mcp-token (minted this boot, 0600)");
    const file = join(cwd, ".crewhaus", "run", "mcp-token");
    expect(readFileSync(file, "utf8")).toBe(`${bearer.token}\n`);
    expect(readFileSync(join(cwd, ".crewhaus", "run", ".gitignore"), "utf8")).toBe("*\n");
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("an existing .gitignore stays as it is", () => {
    const cwd = fresh();
    mkdirSync(join(cwd, ".crewhaus", "run"), { recursive: true });
    writeFileSync(join(cwd, ".crewhaus", "run", ".gitignore"), "pids/\n");
    resolveServeBearer({ cwd, env: {} });
    expect(readFileSync(join(cwd, ".crewhaus", "run", ".gitignore"), "utf8")).toBe("pids/\n");
  });

  test("a second start replaces the value", () => {
    const cwd = fresh();
    const first = resolveServeBearer({ cwd, env: {} });
    const second = resolveServeBearer({ cwd, env: {} });
    expect(second.token).not.toBe(first.token);
    expect(readFileSync(join(cwd, SERVE_TOKEN_FILE), "utf8")).toBe(`${second.token}\n`);
  });

  test.skipIf(!posix)("a link at the file is replaced, and its target is unchanged", () => {
    const cwd = fresh();
    const target = join(cwd, "elsewhere.txt");
    writeFileSync(target, "kept\n");
    mkdirSync(join(cwd, ".crewhaus", "run"), { recursive: true });
    symlinkSync(target, join(cwd, SERVE_TOKEN_FILE));
    const bearer = resolveServeBearer({ cwd, env: {} });
    expect(readFileSync(target, "utf8")).toBe("kept\n");
    expect(readFileSync(join(cwd, SERVE_TOKEN_FILE), "utf8")).toBe(`${bearer.token}\n`);
  });

  test.skipIf(!posix || process.getuid?.() === 0)(
    "a read-only directory: refused, naming the variable",
    () => {
      const cwd = fresh();
      const run = join(cwd, ".crewhaus", "run");
      mkdirSync(run, { recursive: true });
      chmodSync(run, 0o500);
      let thrown: unknown;
      try {
        resolveServeBearer({ cwd, env: {} });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ServeMcpError);
      expect((thrown as Error).message).toContain(`set ${SERVE_TOKEN_ENV}:`);
      expect((thrown as Error).message).toContain(join(cwd, SERVE_TOKEN_FILE));
    },
  );
});

describe("resolveMcpToolsMode", () => {
  test("uses the RESOLVED expose.tools value", () => {
    expect(resolveMcpToolsMode("chat")).toBe("chat");
    expect(resolveMcpToolsMode("per-subagent")).toBe("per-subagent");
  });
  test("absent expose block → chat (whole-agent projection)", () => {
    expect(resolveMcpToolsMode(undefined)).toBe("chat");
  });
});

describe("resolveServePort", () => {
  test("--port flag wins", () => {
    expect(resolveServePort("9001", "8123")).toBe(9001);
  });
  test("falls back to the env var, then the default", () => {
    expect(resolveServePort(undefined, "8123")).toBe(8123);
    expect(resolveServePort(undefined, undefined)).toBe(SERVE_MCP_DEFAULT_PORT);
    expect(resolveServePort(undefined, "")).toBe(SERVE_MCP_DEFAULT_PORT);
  });
  test("rejects a non-integer / out-of-range port", () => {
    expect(() => resolveServePort("abc", undefined)).toThrow(ServeMcpError);
    expect(() => resolveServePort("0", undefined)).toThrow(/1\.\.65535/);
    expect(() => resolveServePort("70000", undefined)).toThrow(ServeMcpError);
    expect(() => resolveServePort("80.5", undefined)).toThrow(ServeMcpError);
  });
  test("names CREWHAUS_MCP_PORT when the bad value came from the env", () => {
    expect(() => resolveServePort(undefined, "nope")).toThrow(/CREWHAUS_MCP_PORT/);
  });
});

describe("assertServeTargetSupported", () => {
  test("accepts the cli target", () => {
    expect(() => assertServeTargetSupported(SERVE_MCP_SUPPORTED_TARGET)).not.toThrow();
  });
  test("rejects a non-cli target with an actionable message", () => {
    expect(() => assertServeTargetSupported("voice")).toThrow(ServeMcpError);
    expect(() => assertServeTargetSupported("channel")).toThrow(/supports target: cli/);
  });
});

describe("assertToolsModeSatisfiable", () => {
  test("per-subagent with zero sub-agents throws", () => {
    expect(() => assertToolsModeSatisfiable("per-subagent", 0)).toThrow(ServeMcpError);
    expect(() => assertToolsModeSatisfiable("per-subagent", 0)).toThrow(/per-subagent/);
  });
  test("per-subagent with sub-agents, and chat regardless, are fine", () => {
    expect(() => assertToolsModeSatisfiable("per-subagent", 2)).not.toThrow();
    expect(() => assertToolsModeSatisfiable("chat", 0)).not.toThrow();
  });
});

describe("buildMcpSubAgentDescriptors", () => {
  test("projects name + description, dropping any extra fields", () => {
    expect(
      buildMcpSubAgentDescriptors([
        { name: "researcher", description: "digs up sources", instructions: "…" } as {
          name: string;
          description: string;
        },
        { name: "writer", description: "drafts prose" },
      ]),
    ).toEqual([
      { name: "researcher", description: "digs up sources" },
      { name: "writer", description: "drafts prose" },
    ]);
  });
});

describe("filterChildTools", () => {
  const tools = [{ name: "Read" }, { name: "Grep" }, { name: "Bash" }];
  test("keeps only the allowlisted tools, preserving parent order", () => {
    expect(filterChildTools(tools, ["Grep", "Read"]).map((t) => t.name)).toEqual(["Read", "Grep"]);
  });
  test("an empty allowlist yields an empty child catalog", () => {
    expect(filterChildTools(tools, [])).toEqual([]);
  });
  test("names not in the parent catalog are ignored", () => {
    expect(filterChildTools(tools, ["Nope", "Bash"]).map((t) => t.name)).toEqual(["Bash"]);
  });
});

describe("SERVE_MCP_USAGE", () => {
  test("documents the required --mcp flag and the --sse/--port options", () => {
    expect(SERVE_MCP_USAGE).toContain("--mcp");
    expect(SERVE_MCP_USAGE).toContain("--sse");
    expect(SERVE_MCP_USAGE).toContain("--port");
  });
  test("says where --sse listens", () => {
    expect(SERVE_MCP_USAGE).toContain("listens on this computer only");
  });
  test("says --sse asks for a bearer, and where the token comes from", () => {
    expect(SERVE_MCP_USAGE).toContain("`Authorization: Bearer <token>`");
    expect(SERVE_MCP_USAGE).toContain(SERVE_TOKEN_ENV);
    expect(SERVE_MCP_USAGE).toContain(`${SERVE_TOKEN_FILE} (0600)`);
  });
});
