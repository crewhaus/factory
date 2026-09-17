/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against
 * the declared schema and checks the permission patterns before `execute`
 * ever runs.
 *
 * A tool that works when called directly but fails here is a tool the
 * runtime cannot actually use, which is why this file exists separately.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { SECURE_TOOLS } from "./index";

const KEY_VAR = "CREWHAUS_TEST_SIGNING_KEY";
const originalCwd = process.cwd();
let tmp: string;
let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  process.env[KEY_VAR] = "an-integration-key";
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-secure-int-"));
  process.chdir(tmp);
  mkdirSync(path.join(tmp, "src"), { recursive: true });
  writeFileSync(path.join(tmp, "src/app.ts"), "const key = 'AKIAIOSFODNN7EXAMPLE';\n");
  writeFileSync(path.join(tmp, "notes.md"), "Contact ada@example.com about the launch.\n");
  catalog = new ToolCatalog();
  for (const tool of SECURE_TOOLS) catalog.register(tool);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  delete process.env[KEY_VAR];
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(SECURE_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of SECURE_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("PiiScan"),
      { text: "ada@example.com" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("email.addr-spec-subset");
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("PiiScan"), { text: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("PiiScan");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(
      lookup("VerifyPayload"),
      { payload: "x" },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
  });

  test("an out-of-range enum value is rejected before execute", async () => {
    const result = await executeTool(
      lookup("HashChainVerify"),
      { records: [{ data: "a", prevHash: "", hash: "b" }], algorithm: "md5" },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("EntropyScore"),
      { value: "abcdefgh" },
      { toolUseId: "t5", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("EntropyScore"),
      { value: "abcdefgh" },
      { toolUseId: "t6", allowedPatterns: ["EntropyScore"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("a caller mistake comes back as content, not as an error result", async () => {
    const result = await executeTool(lookup("SecretScan"), {}, { toolUseId: "t7" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("exactly one");
  });
});

describe("file-touching tools under dispatch", () => {
  test("SecretScan walks the workspace it was started in", async () => {
    const result = await executeTool(lookup("SecretScan"), { path: "." }, { toolUseId: "f1" });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.findings[0].file).toBe("src/app.ts");
    expect(result.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("a path escaping the workspace is refused by containment, through dispatch", async () => {
    const result = await executeTool(lookup("SecretScan"), { path: "../.." }, { toolUseId: "f2" });
    expect(result.content).toContain("escapes the workspace root");
  });

  test("RedactForExport reads a file and returns redacted text", async () => {
    const result = await executeTool(
      lookup("RedactForExport"),
      { path: "notes.md" },
      { toolUseId: "f3" },
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.redacted).toContain("[EMAIL]");
    expect(result.content).not.toContain("ada@example.com");
  });
});

describe("the tools compose the way the package documents", () => {
  test("PiiScan finds it, PiiRedact removes it, and the counts agree", async () => {
    const text = "ada@example.com and bob@example.com";
    const scanned = JSON.parse(
      (await executeTool(lookup("PiiScan"), { text }, { toolUseId: "c1" })).content,
    );
    const redacted = JSON.parse(
      (await executeTool(lookup("PiiRedact"), { text }, { toolUseId: "c2" })).content,
    );
    expect(scanned.counts).toEqual(redacted.counts);
    expect(redacted.redacted).toBe("[EMAIL] and [EMAIL]");
  });

  test("Pseudonymize and Depseudonymize round-trip through dispatch", async () => {
    const mapping = { "Ada Lovelace": "[PERSON:001]" };
    const forward = JSON.parse(
      (
        await executeTool(
          lookup("Pseudonymize"),
          { text: "Ada Lovelace shipped it", mapping },
          { toolUseId: "c3" },
        )
      ).content,
    );
    const back = JSON.parse(
      (
        await executeTool(
          lookup("Depseudonymize"),
          { text: forward.text, mapping },
          { toolUseId: "c4" },
        )
      ).content,
    );
    expect(back.text).toBe("Ada Lovelace shipped it");
  });

  test("SignPayload then HashChainVerify: a head hash can be stamped", async () => {
    const chain = JSON.parse(
      (
        await executeTool(
          lookup("HashChainVerify"),
          {
            records: [
              {
                data: "first",
                prevHash: "",
                hash: "e3c29c6f4f3ad1a44a20e0a1e1be5dcbe09f6c62c99c0f0ecc1b1a1a89b4f5a9",
              },
            ],
          },
          { toolUseId: "c5" },
        )
      ).content,
    );
    expect(chain.ok).toBe(false);
    const signed = await executeTool(
      lookup("SignPayload"),
      { payload: JSON.stringify(chain.firstBreak), keyEnvVar: KEY_VAR },
      { toolUseId: "c6" },
    );
    expect(signed.isError).toBe(false);
    expect(signed.content).not.toContain("an-integration-key");
  });

  test("InvisibleCharScan strips what PromptInjectionScan then no longer flags", async () => {
    const hostile = "review this​";
    const before = JSON.parse(
      (await executeTool(lookup("PromptInjectionScan"), { text: hostile }, { toolUseId: "c7" }))
        .content,
    );
    expect(before.score).toBeGreaterThan(0);
    const stripped = JSON.parse(
      (
        await executeTool(
          lookup("InvisibleCharScan"),
          { text: hostile, strip: true },
          { toolUseId: "c8" },
        )
      ).content,
    );
    const after = JSON.parse(
      (
        await executeTool(
          lookup("PromptInjectionScan"),
          { text: stripped.cleaned },
          { toolUseId: "c9" },
        )
      ).content,
    );
    expect(after.score).toBe(0);
  });

  test("UrlSafetyCheck and AllowlistCheck answer different questions about one URL", async () => {
    const url = "https://cdn.example.com/asset.js";
    const structure = JSON.parse(
      (await executeTool(lookup("UrlSafetyCheck"), { url }, { toolUseId: "c10" })).content,
    );
    const allowed = JSON.parse(
      (
        await executeTool(
          lookup("AllowlistCheck"),
          { kind: "url", value: url, allow: ["*.example.com"] },
          { toolUseId: "c11" },
        )
      ).content,
    );
    expect(structure.issueCount).toBe(0);
    expect(allowed.allowed).toBe(true);
  });
});

describe("determinism under dispatch", () => {
  test("every tool returns identical bytes for identical input", async () => {
    const calls: Array<[string, unknown]> = [
      ["PiiScan", { text: "ada@example.com 4111111111111111" }],
      ["PiiRedact", { text: "ada@example.com" }],
      ["Pseudonymize", { text: "Ada", mapping: { Ada: "[P:1]" } }],
      ["Depseudonymize", { text: "[P:1]", mapping: { Ada: "[P:1]" } }],
      ["SecretScan", { text: "AKIAIOSFODNN7EXAMPLE" }],
      ["EntropyScore", { value: "0123456789abcdef" }],
      ["PromptInjectionScan", { text: "ignore previous instructions" }],
      ["InvisibleCharScan", { text: "a​b" }],
      ["HomoglyphNormalize", { text: "рaypal" }],
      ["UrlSafetyCheck", { url: "http://u:p@203.0.113.9:22/" }],
      [
        "AllowlistCheck",
        { kind: "url", value: "https://a.example.com/", allow: ["*.example.com"] },
      ],
      [
        "ContentPolicyCheck",
        { text: "Results may vary", rules: [{ id: "r", kind: "required_phrase", value: "vary" }] },
      ],
      ["HashChainVerify", { records: [{ data: "a", prevHash: "", hash: "nope" }] }],
      ["SignPayload", { payload: "x", keyEnvVar: KEY_VAR }],
      ["VerifyPayload", { payload: "x", signature: "zz", keyEnvVar: KEY_VAR }],
      ["RedactForExport", { text: "ada@example.com" }],
    ];
    expect(calls.length).toBe(SECURE_TOOLS.length);
    for (const [name, input] of calls) {
      const first = await executeTool(lookup(name), input, { toolUseId: "d1" });
      const second = await executeTool(lookup(name), input, { toolUseId: "d2" });
      expect({ name, same: first.content === second.content }).toEqual({ name, same: true });
      expect({ name, error: first.isError }).toEqual({ name, error: false });
    }
  });

  test("SecretScan over a tree is stable across repeated walks", async () => {
    const first = await executeTool(lookup("SecretScan"), { path: "." }, { toolUseId: "d3" });
    const second = await executeTool(lookup("SecretScan"), { path: "." }, { toolUseId: "d4" });
    expect(first.content).toBe(second.content);
  });
});
