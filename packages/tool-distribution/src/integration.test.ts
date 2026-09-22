/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema and turns a thrown refusal into an error RESULT rather than
 * a crash. A tool that works when called directly but not here is a tool the
 * runtime cannot use, which is why this file exists separately.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  renderDebianControl,
  renderHomebrewFormula,
  renderWingetManifest,
} from "@crewhaus/single-binary-cli";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { _setDnsLookup } from "@crewhaus/tool-fetch";
import {
  ASSET_SHAS,
  DOWNLOAD_BASE,
  HOMEPAGE,
  RELEASE,
  VERSION,
  forbidNetwork,
  releaseRoutes,
  stubFetch,
} from "./fixtures";
import { DISTRIBUTION_TOOLS, _setFetch } from "./index";

let catalog: ToolCatalog;

/** `content` is a union; both tools here return the string arm. */
function text(result: { content: unknown }): string {
  if (typeof result.content !== "string") throw new Error("expected string content");
  return result.content;
}

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

const GENERATE_INPUT = {
  version: VERSION,
  homepage: HOMEPAGE,
  downloadBaseUrl: DOWNLOAD_BASE,
  sha256: { ...ASSET_SHAS },
};

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of DISTRIBUTION_TOOLS) catalog.register(tool);
  _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
  _setFetch(forbidNetwork);
});

afterEach(() => {
  _setFetch(undefined);
  _setDnsLookup(undefined);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(DISTRIBUTION_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of DISTRIBUTION_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("every tool can be dispatched with a minimal valid input", async () => {
    _setFetch(stubFetch(releaseRoutes()).fetch);
    const inputs: Record<string, unknown> = {
      PackageManifestGenerate: GENERATE_INPUT,
      PackageManifestVerify: { manifests: [{ text: renderDebianControl(RELEASE) }] },
    };
    for (const tool of DISTRIBUTION_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("the optional fields really are optional through the runtime", async () => {
    // zod's `.default()` does not compile in this repo, so every default is an
    // `.optional()` plus a `??` inside execute. That only works if the runtime
    // passes the input through without one — which is what this checks.
    const generated = await executeTool(lookup("PackageManifestGenerate"), GENERATE_INPUT, {
      toolUseId: "g1",
    });
    expect(JSON.parse(text(generated)).manifests).toHaveLength(4);

    const verified = await executeTool(
      lookup("PackageManifestVerify"),
      { manifests: [{ text: renderHomebrewFormula(RELEASE) }], download: false },
      { toolUseId: "v1" },
    );
    expect(JSON.parse(text(verified)).verdict).toBe("incomplete");
  });

  test("input is validated before execute, so a bad type never reaches a renderer", async () => {
    const result = await executeTool(
      lookup("PackageManifestGenerate"),
      { ...GENERATE_INPUT, version: 123 },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(true);
  });

  test("the schema caps the download budget before any byte moves", async () => {
    const result = await executeTool(
      lookup("PackageManifestVerify"),
      {
        manifests: [{ text: renderWingetManifest(RELEASE) }],
        maxBytes: 99 * 1024 * 1024 * 1024,
      },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
  });

  test("a refusal comes back as its reason, not as a crash", async () => {
    const result = await executeTool(
      lookup("PackageManifestGenerate"),
      { ...GENERATE_INPUT, downloadBaseUrl: "http://dl.example.com/v1.2.3" },
      { toolUseId: "t3" },
    );
    // The refusal is the answer, so it arrives as content. What matters is
    // that it names the reason and that nothing was rendered.
    expect(result.isError).toBe(false);
    expect(text(result)).toMatch(/refused/);
    expect(text(result)).not.toContain("class Crewhaus");
  });

  test("a manifest that could not be read does not come back as a pass", async () => {
    const result = await executeTool(
      lookup("PackageManifestVerify"),
      { manifests: [{ text: "not a manifest" }], download: false },
      { toolUseId: "t4" },
    );
    expect(JSON.parse(text(result)).verdict).toBe("incomplete");
  });
});

describe("the question these two answer together", () => {
  test("cut a release, then prove the files that describe it are true", async () => {
    const generated = await executeTool(lookup("PackageManifestGenerate"), GENERATE_INPUT, {
      toolUseId: "w1",
    });
    const manifests = JSON.parse(text(generated)).manifests as {
      kind: string;
      text: string;
      filename: string;
    }[];

    _setFetch(stubFetch(releaseRoutes()).fetch);
    const verified = await executeTool(
      lookup("PackageManifestVerify"),
      {
        manifests: manifests.map((m) => ({ text: m.text, kind: m.kind, label: m.filename })),
        expectVersion: VERSION,
      },
      { toolUseId: "w2" },
    );
    const out = JSON.parse(text(verified));
    expect(out.verdict).toBe("verified");
    expect(out.summary.verified).toBe(6);
  });

  test("the run is cancellable: a caller's signal stops the downloads", async () => {
    // The runtime can abort a tool mid-call. The result must still be a
    // RESULT — assets that were not fetched reported as not fetched, with the
    // reason — rather than a crash or a silent pass.
    const controller = new AbortController();
    controller.abort();
    _setFetch(stubFetch(releaseRoutes()).fetch);
    const result = await executeTool(
      lookup("PackageManifestVerify"),
      { manifests: [{ text: renderHomebrewFormula(RELEASE) }] },
      { toolUseId: "w3", signal: controller.signal },
    );
    const out = JSON.parse(text(result));
    expect(out.verdict).toBe("incomplete");
    expect(out.summary.verified).toBe(0);
    // "cancelled", not "timeout": the run was stopped, the host was not slow.
    expect(out.assets.every((a: { reason: string }) => a.reason === "cancelled")).toBe(true);
  });
});
