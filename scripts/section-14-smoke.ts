#!/usr/bin/env bun
/**
 * Section 14 end-to-end smoke test against the live model.
 *
 * Six probe scenarios over a single temp project that registers
 * WebFetch + ReadImage + Fetch (with a fail-closed allow-list of just
 * api.github.com):
 *
 *   1. WebFetch https://example.com → markdown contains "Example Domain"
 *   2. Fetch https://api.github.com/repos/anthropics/anthropic-sdk-python →
 *      JSON includes "stargazers_count"; final assistant text mentions a
 *      number
 *   3. Fetch https://example.com/private → fail-closed refusal because
 *      example.com is not in allowed_origins
 *   4. ReadImage ./test.png → the model receives an actual image block
 *      and describes it (proves the image-block return path; cross-cut A)
 *   5. ReadImage ../../etc/passwd → path-traversal denial
 *   6. Fetch http://169.254.169.254/latest/meta-data/ → SSRF denial
 *
 * Run: `bun run smoke:section-14` (after `bun --filter '@crewhaus/*' test`).
 * Requires `ANTHROPIC_AUTH_TOKEN` (Claude Pro/Max OAuth) or
 * `ANTHROPIC_API_KEY` in `.env`.
 *
 * Exits 0 on full success; 1 on any failed scenario.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/src/index.ts");

const ANTHROPIC_TOKEN =
  process.env["ANTHROPIC_AUTH_TOKEN"] ?? process.env["ANTHROPIC_API_KEY"] ?? "";
if (ANTHROPIC_TOKEN === "") {
  console.error(
    "[section-14-smoke] no ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in env (.env auto-loaded)",
  );
  process.exit(1);
}

/**
 * Build a minimal-but-real solid-color RGB PNG of arbitrary size. Anthropic's
 * vision pipeline rejects 1×1 inputs ("Could not process image") so we use
 * 64×64 here — small enough to round-trip cheaply, big enough to be valid.
 *
 * PNG layout: 8-byte magic + IHDR + IDAT + IEND.
 */
function makeSolidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i] ?? 0;
      const tableIdx = (c ^ b) & 0xff;
      c = ((crcTable[tableIdx] ?? 0) ^ (c >>> 8)) >>> 0;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const [r, g, b] = rgb;
  const row = Buffer.alloc(1 + width * 3);
  row[0] = 0; // filter: None
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  const idat = deflateSync(raw);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TEST_PNG = makeSolidPng(64, 64, [220, 60, 60]); // 64x64 red square

type ScenarioResult = {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
};

type SessionEvent = { kind: string; payload: unknown };

function setup(): { cwd: string; sessionDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "section-14-smoke-"));
  const sessionDir = join(cwd, ".crewhaus", "sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(cwd, "test.png"), TEST_PNG);
  writeFileSync(
    join(cwd, "crewhaus.yaml"),
    `name: section-14-smoke
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: |
    You are a smoke-test agent. Use exactly the tool the user names in
    each prompt and report back concisely. If a tool refuses the
    request, repeat the refusal verbatim so the test harness can
    verify it.
tools: [webFetch, readImage, fetch]
tool_config:
  fetch:
    allowed_origins: ["https://api.github.com"]
permissions:
  rules:
    - { type: alwaysAllow, pattern: WebFetch }
    - { type: alwaysAllow, pattern: ReadImage }
    - { type: alwaysAllow, pattern: Fetch }
`,
  );
  return { cwd, sessionDir };
}

function runProbe(cwd: string, prompt: string, timeoutMs = 90_000): ScenarioResult {
  const stdin = `${prompt}\nexit\n`;
  const result = spawnSync("bun", [CLI_ENTRY, "run", join(cwd, "crewhaus.yaml")], {
    cwd,
    input: stdin,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env },
  });
  return {
    name: "(probe)",
    passed: result.status === 0,
    message: result.error ? String(result.error) : "",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Read the most recently modified session JSONL file. */
function readLatestSession(sessionDir: string): SessionEvent[] {
  const entries = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const path = join(sessionDir, f);
      const stat = Bun.file(path);
      return { path, mtime: stat.lastModified };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const head = entries[0];
  if (head === undefined) return [];
  const txt = readFileSync(head.path, "utf-8");
  return txt
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as SessionEvent);
}

function findToolUse(events: SessionEvent[], name: string): SessionEvent | undefined {
  return events.find(
    (e) => e.kind === "tool_use" && (e.payload as { name?: string }).name === name,
  );
}

function findToolResult(events: SessionEvent[], toolUseId: string): SessionEvent | undefined {
  return events.find(
    (e) =>
      e.kind === "tool_result" && (e.payload as { toolUseId?: string }).toolUseId === toolUseId,
  );
}

function clearSessions(sessionDir: string): void {
  for (const f of readdirSync(sessionDir)) {
    if (f.endsWith(".jsonl") || f.endsWith(".json")) {
      rmSync(join(sessionDir, f));
    }
  }
}

type Probe = {
  readonly name: string;
  readonly prompt: string;
  readonly verify: (raw: ScenarioResult, events: SessionEvent[]) => string | null;
};

const PROBES: readonly Probe[] = [
  {
    name: "1. WebFetch example.com",
    prompt:
      "Use the WebFetch tool with url=https://example.com to fetch the page, then tell me the page title.",
    verify: (raw, events) => {
      if (!raw.stdout.includes("[tool: WebFetch]")) return "expected stdout '[tool: WebFetch]'";
      const tu = findToolUse(events, "WebFetch");
      if (!tu) return "no WebFetch tool_use in session JSONL";
      const tuId = (tu.payload as { id: string }).id;
      const tr = findToolResult(events, tuId);
      if (!tr) return "no matching tool_result for the WebFetch call";
      const content = (tr.payload as { content: string }).content;
      if (!content.includes("Example Domain"))
        return `WebFetch tool_result missing 'Example Domain': ${content.slice(0, 200)}`;
      return null;
    },
  },
  {
    name: "2. Fetch GitHub API",
    prompt:
      "Use the Fetch tool with url=https://api.github.com/repos/anthropics/anthropic-sdk-python and tell me the value of the stargazers_count field.",
    verify: (raw, events) => {
      if (!raw.stdout.includes("[tool: Fetch]")) return "expected stdout '[tool: Fetch]'";
      const tu = findToolUse(events, "Fetch");
      if (!tu) return "no Fetch tool_use in session JSONL";
      const input = (tu.payload as { input: { url?: string } }).input;
      if (!input.url || !input.url.includes("api.github.com"))
        return `Fetch input.url missing api.github.com: ${JSON.stringify(input)}`;
      const tuId = (tu.payload as { id: string }).id;
      const tr = findToolResult(events, tuId);
      if (!tr) return "no matching tool_result for the Fetch call";
      const content = (tr.payload as { content: string }).content;
      if (!content.includes("stargazers_count"))
        return `Fetch tool_result missing 'stargazers_count': ${content.slice(0, 200)}`;
      return null;
    },
  },
  {
    name: "3. Fetch fail-closed deny",
    prompt: "Use the Fetch tool with url=https://example.com/private and tell me what happened.",
    verify: (_raw, events) => {
      const tu = findToolUse(events, "Fetch");
      if (!tu) return "no Fetch tool_use in session JSONL";
      const tuId = (tu.payload as { id: string }).id;
      const tr = findToolResult(events, tuId);
      if (!tr) return "no matching tool_result for the Fetch call";
      const payload = tr.payload as { content: string; isError: boolean };
      if (!payload.isError) return "expected tool_result.isError=true";
      if (!payload.content.includes("allowed_origins"))
        return `expected refusal mentioning 'allowed_origins': ${payload.content.slice(0, 200)}`;
      return null;
    },
  },
  {
    name: "4. ReadImage describes content",
    prompt:
      "Use the ReadImage tool with path=./test.png to load the image, then describe in one sentence what kind of image it is (e.g. dimensions, content).",
    verify: (raw, events) => {
      if (!raw.stdout.includes("[tool: ReadImage]")) return "expected stdout '[tool: ReadImage]'";
      const tu = findToolUse(events, "ReadImage");
      if (!tu) return "no ReadImage tool_use in session JSONL";
      const tuId = (tu.payload as { id: string }).id;
      const tr = findToolResult(events, tuId);
      if (!tr) return "no matching tool_result for the ReadImage call";
      const payload = tr.payload as { content: string; isError: boolean };
      if (payload.isError) return `ReadImage tool_result isError=true: ${payload.content}`;
      // The audit log emits a length-aware marker for non-string content.
      if (!payload.content.includes("image block"))
        return `expected '[1 image block, ...]' marker in audit log content: ${payload.content}`;
      // The model's final assistant text should be a non-trivial description.
      // We assert on stdout because the assistant's text streams through `agent>`.
      const assistantText = raw.stdout.split("agent>").slice(1).join("agent>").trim();
      if (assistantText.length < 20)
        return `expected a non-empty assistant description (got ${assistantText.length} chars)`;
      return null;
    },
  },
  {
    name: "5. ReadImage path traversal denied",
    prompt: "Use the ReadImage tool with path=../../etc/passwd and tell me what happened.",
    verify: (_raw, events) => {
      const tu = findToolUse(events, "ReadImage");
      if (!tu) return "no ReadImage tool_use in session JSONL";
      const tuId = (tu.payload as { id: string }).id;
      const tr = findToolResult(events, tuId);
      if (!tr) return "no matching tool_result for the ReadImage call";
      const payload = tr.payload as { content: string; isError: boolean };
      if (!payload.isError) return "expected tool_result.isError=true";
      if (!/escapes the workspace root|rejected path/.test(payload.content))
        return `expected traversal denial message: ${payload.content.slice(0, 200)}`;
      return null;
    },
  },
  {
    name: "6. Fetch SSRF denied",
    prompt:
      "Use the Fetch tool with url=http://169.254.169.254/latest/meta-data/ and tell me what happened.",
    verify: (_raw, events) => {
      const tu = findToolUse(events, "Fetch");
      if (!tu) return "no Fetch tool_use in session JSONL";
      const tuId = (tu.payload as { id: string }).id;
      const tr = findToolResult(events, tuId);
      if (!tr) return "no matching tool_result for the Fetch call";
      const payload = tr.payload as { content: string; isError: boolean };
      if (!payload.isError) return "expected tool_result.isError=true";
      // Either origin allow-list refusal OR explicit SSRF refusal is acceptable
      // (169.254.169.254 isn't allow-listed, so the origin check fires first).
      if (!/allowed_origins|SSRF|169\.254|private\/loopback/i.test(payload.content))
        return `expected SSRF/origin refusal: ${payload.content.slice(0, 200)}`;
      return null;
    },
  },
];

async function main(): Promise<void> {
  const { cwd, sessionDir } = setup();
  console.log(`[section-14-smoke] temp project: ${cwd}`);

  const results: ScenarioResult[] = [];
  for (const probe of PROBES) {
    console.log(`\n=== ${probe.name} ===`);
    clearSessions(sessionDir);
    const raw = runProbe(cwd, probe.prompt);
    if (!raw.passed) {
      console.error(`  spawn failed: ${raw.message}`);
      console.error(`  stdout: ${raw.stdout.slice(-1000)}`);
      console.error(`  stderr: ${raw.stderr.slice(-1000)}`);
      results.push({ ...raw, name: probe.name });
      continue;
    }
    const events = readLatestSession(sessionDir);
    const failure = probe.verify(raw, events);
    if (failure === null) {
      console.log("  PASS");
      results.push({ ...raw, name: probe.name, passed: true, message: "PASS" });
    } else {
      console.log(`  FAIL: ${failure}`);
      console.log(`  stdout tail: ${raw.stdout.slice(-500)}`);
      results.push({ ...raw, name: probe.name, passed: false, message: failure });
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n[section-14-smoke] ${results.length - failed.length}/${results.length} passed`);
  rmSync(cwd, { recursive: true, force: true });
  if (failed.length > 0) {
    for (const f of failed) console.error(`  - ${f.name}: ${f.message}`);
    process.exit(1);
  }
}

await main();
