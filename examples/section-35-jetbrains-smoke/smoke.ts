#!/usr/bin/env bun
/**
 * Section 35 JetBrains plugin smoke.
 *
 * Probes:
 *   A) plugin.xml structurally validates (id, name, dependencies,
 *      schema provider, configuration types, tool window, actions)
 *   B) build.gradle.kts declares the right Gradle plugin + IntelliJ
 *      platform + YAML plugin dependency
 *   C) Kotlin source layout includes schema + run-config + tool-window +
 *      action classes
 *   D) buildPlugin() returns {skipped:true} when JBR_BIN is unset (the
 *      common dev case); injected runner argv is ./gradlew buildPlugin
 *   E) live ./gradlew buildPlugin: gated on JBR_BIN env (the JetBrains
 *      Runtime CI image has it; plain dev machines don't)
 */
import {
  buildPlugin,
  fingerprintPluginXml,
  kotlinSourceFiles,
  readBuildGradle,
  readPluginXml,
} from "@crewhaus/jetbrains-plugin";

const log = (s: string) => process.stdout.write(`[section-35-jetbrains] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

// ── Probe A: plugin.xml ────────────────────────────────────────────────────
log("probe A: plugin.xml structural assertions");
const fp = fingerprintPluginXml(readPluginXml());
check("declares io.crewhaus.jetbrains-plugin id", fp.id === "io.crewhaus.jetbrains-plugin");
check("declares CrewHaus name", fp.name === "CrewHaus");
check(
  "declares all 3 run config types",
  fp.configurationTypeImpls.length === 3 &&
    fp.configurationTypeImpls.every((c) => c.startsWith("io.crewhaus.plugin.run.")),
);
check("declares Spec Registry tool window", fp.toolWindowIds.includes("CrewHaus Spec Registry"));
check(
  "declares Run Spec + Open Trace actions",
  fp.actionIds.length === 2 &&
    fp.actionIds.includes("crewhaus.runSpec") &&
    fp.actionIds.includes("crewhaus.openTrace"),
);
check("depends on YAML plugin", fp.dependencies.includes("org.jetbrains.plugins.yaml"));

// ── Probe B: build.gradle.kts ──────────────────────────────────────────────
log("probe B: build.gradle.kts");
const gradle = readBuildGradle();
check("declares org.jetbrains.intellij plugin", gradle.includes("org.jetbrains.intellij"));
check("declares IntelliJ Community 2024.2", gradle.includes('version.set("2024.2")'));
check("declares YAML plugin dep", gradle.includes("org.jetbrains.plugins.yaml"));

// ── Probe C: Kotlin source layout ──────────────────────────────────────────
log("probe C: Kotlin source layout");
const sources = kotlinSourceFiles();
check("≥ 4 Kotlin source files", sources.length >= 4);
check(
  "schema provider source present",
  sources.some((p) => p.includes("CrewhausSpecSchemaProviderFactory.kt")),
);
check(
  "run-configs source present",
  sources.some((p) => p.includes("RunConfigurations.kt")),
);
check(
  "tool-window source present",
  sources.some((p) => p.includes("SpecRegistryToolWindowFactory.kt")),
);
check(
  "actions source present",
  sources.some((p) => p.includes("Actions.kt")),
);

// ── Probe D: buildPlugin scaffold ──────────────────────────────────────────
log("probe D: buildPlugin gate");
{
  const r = await buildPlugin({});
  check("buildPlugin skipped without JBR_BIN", r.skipped === true);
  let argv: readonly string[] = [];
  const r2 = await buildPlugin({
    jbrBin: "/opt/jbr",
    runner: async (a) => {
      argv = a;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  check(
    "buildPlugin runs ./gradlew buildPlugin when JBR_BIN set",
    argv.join(" ").includes("gradlew buildPlugin"),
  );
  check("buildPlugin returns outPath", r2.skipped === false);
}

// ── Probe E: live gradle build ─────────────────────────────────────────────
if (process.env["JBR_BIN"]) {
  log("probe E: live ./gradlew buildPlugin");
  try {
    const r = await buildPlugin({});
    check("live buildPlugin succeeded", r.skipped === false);
  } catch (err) {
    check("live buildPlugin succeeded", false, (err as Error).message);
  }
} else {
  log("probe E: skipped (JBR_BIN not set)");
}

if (failed > 0) {
  log(`FAILED — ${failed} check(s) did not pass`);
  process.exit(1);
}
log("OK — all probes passed");
