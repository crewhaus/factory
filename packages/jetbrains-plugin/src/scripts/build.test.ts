import { describe, expect, test } from "bun:test";

import {
  type BuildPluginRunner,
  JetbrainsPluginError,
  buildPlugin,
  fingerprintPluginXml,
  kotlinSourceFiles,
  kotlinSourceSize,
  packageRoot,
  pluginXmlPath,
  readBuildGradle,
  readPluginXml,
} from "./build";

describe("plugin.xml structural assertions (T1)", () => {
  test("plugin.xml exists and is readable", () => {
    expect(pluginXmlPath()).toMatch(
      /jetbrains-plugin\/src\/main\/resources\/META-INF\/plugin\.xml$/,
    );
    expect(readPluginXml().length).toBeGreaterThan(100);
  });

  test("declares io.crewhaus.jetbrains-plugin id + CrewHaus name", () => {
    const fp = fingerprintPluginXml(readPluginXml());
    expect(fp.id).toBe("io.crewhaus.jetbrains-plugin");
    expect(fp.name).toBe("CrewHaus");
  });

  test("registers spec schema provider, run-config types, tool window, actions", () => {
    const fp = fingerprintPluginXml(readPluginXml());
    expect(fp.extensionImplementations).toContain(
      "io.crewhaus.plugin.schema.CrewhausSpecSchemaProviderFactory",
    );
    expect(fp.configurationTypeImpls).toEqual([
      "io.crewhaus.plugin.run.RunSpecConfigurationType",
      "io.crewhaus.plugin.run.RunEvalConfigurationType",
      "io.crewhaus.plugin.run.RunCanaryConfigurationType",
    ]);
    expect(fp.toolWindowIds).toContain("CrewHaus Spec Registry");
    expect(fp.actionIds).toEqual(["crewhaus.runSpec", "crewhaus.openTrace"]);
  });

  test("declares the YAML plugin dependency for schema-driven autocomplete", () => {
    const fp = fingerprintPluginXml(readPluginXml());
    expect(fp.dependencies).toContain("com.intellij.modules.platform");
    expect(fp.dependencies).toContain("org.jetbrains.plugins.yaml");
  });
});

describe("build.gradle.kts structural assertions (T1)", () => {
  test("declares the JetBrains plugin Gradle plugin + IntelliJ 2024.2 platform", () => {
    const gradle = readBuildGradle();
    expect(gradle).toContain('id("org.jetbrains.intellij")');
    expect(gradle).toContain('version.set("2024.2")');
    expect(gradle).toContain('type.set("IC")');
  });

  test("depends on the YAML plugin (org.jetbrains.plugins.yaml)", () => {
    expect(readBuildGradle()).toContain("org.jetbrains.plugins.yaml");
  });

  test("publishPlugin token sourced from JETBRAINS_MARKETPLACE_TOKEN env", () => {
    expect(readBuildGradle()).toContain("JETBRAINS_MARKETPLACE_TOKEN");
  });
});

describe("Kotlin source layout (T1)", () => {
  test("ships at least the schema + run + tool-window + action sources", () => {
    const files = kotlinSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    const names = files.map((f) => f.replace(packageRoot(), ""));
    expect(names.some((n) => n.includes("CrewhausSpecSchemaProviderFactory.kt"))).toBe(true);
    expect(names.some((n) => n.includes("RunConfigurations.kt"))).toBe(true);
    expect(names.some((n) => n.includes("SpecRegistryToolWindowFactory.kt"))).toBe(true);
    expect(names.some((n) => n.includes("Actions.kt"))).toBe(true);
  });

  test("each source file is non-empty", () => {
    for (const f of kotlinSourceFiles()) {
      expect(kotlinSourceSize(f)).toBeGreaterThan(0);
    }
  });
});

describe("buildPlugin gradle wrapper (T2 — gated on JBR_BIN)", () => {
  test("returns {skipped:true} when JBR_BIN is unset", async () => {
    const r = await buildPlugin({ jbrBin: undefined });
    expect(r.skipped).toBe(true);
    if (r.skipped) {
      expect(r.reason).toContain("JBR_BIN");
    }
  });

  test("happy path argv when JBR_BIN is set + injected runner returns 0", async () => {
    let argv: readonly string[] = [];
    const runner: BuildPluginRunner = async (a) => {
      argv = a;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = await buildPlugin({ jbrBin: "/opt/jbr", runner });
    expect(r.skipped).toBe(false);
    if (!r.skipped) {
      expect(argv).toContain("./gradlew");
      expect(argv).toContain("buildPlugin");
      expect(r.outPath).toContain("build/distributions");
    }
  });

  test("non-zero exit propagates as JetbrainsPluginError", async () => {
    await expect(
      buildPlugin({
        jbrBin: "/opt/jbr",
        runner: async () => ({ exitCode: 1, stdout: "", stderr: "compile failed" }),
      }),
    ).rejects.toThrow(JetbrainsPluginError);
  });
});
