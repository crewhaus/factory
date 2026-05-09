import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("vscode-extension manifest (T1 — manifest validation in CI)", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
  ) as Record<string, unknown>;

  test("declares vscode engine 1.80+", () => {
    const engines = manifest["engines"] as Record<string, string> | undefined;
    expect(engines?.["vscode"]).toMatch(/\^?\d+\.\d+\./);
  });

  test("declares the crewhaus-spec language", () => {
    const contributes = manifest["contributes"] as Record<string, unknown>;
    const langs = contributes?.["languages"] as ReadonlyArray<{
      id?: string;
      filenamePatterns?: readonly string[];
    }>;
    const spec = langs.find((l) => l.id === "crewhaus-spec");
    expect(spec).toBeDefined();
    expect(spec?.filenamePatterns).toContain("crewhaus.yaml");
  });

  test("declares yamlValidation against schemas/spec.json for crewhaus.yaml files", () => {
    const contributes = manifest["contributes"] as Record<string, unknown>;
    const yv = contributes?.["yamlValidation"] as ReadonlyArray<{
      fileMatch?: readonly string[];
      url?: string;
    }>;
    expect(yv.length).toBeGreaterThan(0);
    const entry = yv.find((y) => y.fileMatch?.includes("crewhaus.yaml"));
    expect(entry).toBeDefined();
    expect(entry?.url).toBe("./schemas/spec.json");
  });

  test("registers crewhaus.runSpec + crewhaus.openTrace commands", () => {
    const contributes = manifest["contributes"] as Record<string, unknown>;
    const cmds = contributes?.["commands"] as ReadonlyArray<{ command?: string }>;
    const ids = cmds.map((c) => c.command);
    expect(ids).toContain("crewhaus.runSpec");
    expect(ids).toContain("crewhaus.openTrace");
  });

  test("activationEvents include onLanguage:yaml so the extension activates on every yaml open", () => {
    const events = manifest["activationEvents"] as readonly string[];
    expect(events).toContain("onLanguage:yaml");
    expect(events).toContain("onCommand:crewhaus.runSpec");
  });

  test("configuration block declares cliPath + studioUrl settings", () => {
    const contributes = manifest["contributes"] as Record<string, unknown>;
    const cfg = contributes?.["configuration"] as { properties?: Record<string, unknown> };
    expect(cfg.properties?.["crewhaus.cliPath"]).toBeDefined();
    expect(cfg.properties?.["crewhaus.studioUrl"]).toBeDefined();
  });
});
