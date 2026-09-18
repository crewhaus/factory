/**
 * The tools driven the way the runtime drives them: registered in a catalog and
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and turns a thrown refusal into an error RESULT rather than a
 * crash. A tool that works when called directly but not here is a tool the
 * runtime cannot use, which is why this file exists separately.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { _setDnsLookup } from "@crewhaus/tool-fetch";
import { GHCR, OCI_INDEX_DIGEST, multiArchContent, registryStub } from "./fixtures";
import { CONTAINER_TOOLS, _setFetch } from "./index";

let catalog: ToolCatalog;

/** `content` is a union; every tool here returns the string arm. */
function text(result: { content: unknown }): string {
  if (typeof result.content !== "string") throw new Error("expected string content");
  return result.content;
}

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of CONTAINER_TOOLS) catalog.register(tool);
  _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
  _setFetch(
    registryStub(GHCR, "crewhaus/factory", {
      ...multiArchContent(),
      tagPages: [{ body: '{"name":"crewhaus/factory","tags":["1.4.2","1.4.1","latest"]}' }],
    }).fetch,
  );
});

afterEach(() => {
  _setFetch(undefined);
  _setDnsLookup(undefined);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(CONTAINER_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of CONTAINER_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("every tool can be dispatched with a minimal valid input", async () => {
    const inputs: Record<string, unknown> = {
      ContainerImageInspect: { image: "ghcr.io/crewhaus/factory:1.4.2" },
      ContainerImageTags: { image: "ghcr.io/crewhaus/factory" },
    };
    for (const tool of CONTAINER_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("the resolved digest survives the round trip through the runtime", async () => {
    const result = await executeTool(
      lookup("ContainerImageInspect"),
      { image: "ghcr.io/crewhaus/factory:1.4.2", includeConfig: false },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(text(result)).resolved.digest).toBe(OCI_INDEX_DIGEST);
  });

  test("input is validated before execute, so a bad type never reaches the network", async () => {
    const result = await executeTool(
      lookup("ContainerImageInspect"),
      { image: 42 },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
  });

  test("a refusal comes back as an error result with the reason, not a thrown crash", async () => {
    const result = await executeTool(
      lookup("ContainerImageInspect"),
      { image: "ghcr.io/crewhaus/factory:1.4.2", platform: "linux/s390x" },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("the index lists linux/amd64, linux/arm64/v8");
  });

  test("a malformed reference is an error result, not a crash", async () => {
    const result = await executeTool(
      lookup("ContainerImageTags"),
      { image: "ghcr.io/Crewhaus/Factory" },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("lowercase");
  });
});

describe("the question these two answer together", () => {
  test("list the tags, then pin the one you want to its digest", async () => {
    // The pair is the workflow: a harness asks what exists, picks a version,
    // and records the digest — so a later run can prove it is the same image
    // rather than trusting that a tag did not move.
    const tags = await executeTool(
      lookup("ContainerImageTags"),
      { image: "ghcr.io/crewhaus/factory", match: "1.4.*", limit: 1 },
      { toolUseId: "w1" },
    );
    const newest = JSON.parse(text(tags)).tags[0] as string;
    expect(newest).toBe("1.4.2");

    const inspected = await executeTool(
      lookup("ContainerImageInspect"),
      { image: `ghcr.io/crewhaus/factory:${newest}`, includeConfig: false },
      { toolUseId: "w2" },
    );
    const digest = JSON.parse(text(inspected)).resolved.digest as string;

    const pinned = await executeTool(
      lookup("ContainerImageInspect"),
      { image: `ghcr.io/crewhaus/factory@${digest}`, includeConfig: false },
      { toolUseId: "w3" },
    );
    expect(pinned.isError).toBe(false);
    expect(JSON.parse(text(pinned)).resolved.digest).toBe(digest);
  });
});
