#!/usr/bin/env bun
/**
 * Section 36 sandbox-image-java smoke. Probes A-F mirror the §36 sibling
 * smokes. Live-image probe pulls eclipse-temurin:21-alpine and runs
 * `java -version` against the real sandbox when CREWHAUS_SECTION36_LIVE_DOCKER=1.
 */
import { execSync } from "node:child_process";
import { createSandbox } from "@crewhaus/sandbox";
import {
  JAVA_COLD_START_BUDGET_MS,
  JAVA_HEALTHCHECK_ARGV,
  JAVA_IMAGE_ID,
  JAVA_IMAGE_REF,
  registerJavaSandboxImage,
} from "@crewhaus/sandbox-image-java";
import {
  _resetSandboxImageRegistry,
  hasSandboxImage,
  listAllowedImageRefs,
  lookupSandboxImage,
} from "@crewhaus/sandbox-image-registry";

const log = (s: string) => process.stdout.write(`[section-36-java] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

_resetSandboxImageRegistry();

log("probe A: registerJavaSandboxImage()");
const entry = registerJavaSandboxImage();
check("entry id is 'java'", entry.id === JAVA_IMAGE_ID);
check("entry image is eclipse-temurin:21-alpine", entry.image === JAVA_IMAGE_REF);
check("entry defaultEntrypoint is `java`", entry.defaultEntrypoint.join(" ") === "java");

log("probe B: lookupSandboxImage");
check("hasSandboxImage('java')", hasSandboxImage(JAVA_IMAGE_ID));
check(
  "lookup returns the registered image",
  lookupSandboxImage(JAVA_IMAGE_ID).image === JAVA_IMAGE_REF,
);

log("probe C: listAllowedImageRefs surfaces the Java ref");
{
  const refs = listAllowedImageRefs();
  check("allowlist contains eclipse-temurin:21-alpine", refs.includes(JAVA_IMAGE_REF));
  check("bootstrap trio still present", refs.includes("python:3.13-slim"));
}

log("probe D: noop sandbox round-trip via registry-derived allowlist");
{
  const sandbox = createSandbox({
    backend: "noop",
    allowedImages: listAllowedImageRefs(),
  });
  const result = await sandbox.exec({
    image: JAVA_IMAGE_REF,
    argv: ["printf", "java-snippet-ok"],
  });
  check("noop exec via java ref", result.exitCode === 0 && result.stdout === "java-snippet-ok");
  await sandbox.close();
}

log("probe E: T7 — cold-start budget");
check(
  `healthcheck.timeoutMs ≤ ${JAVA_COLD_START_BUDGET_MS}`,
  (entry.healthcheck.timeoutMs ?? 0) <= JAVA_COLD_START_BUDGET_MS,
);

const liveProbe = process.env["CREWHAUS_SECTION36_LIVE_DOCKER"] === "1";
log(`probe F: live-image probe (gate=${liveProbe ? "on" : "off"})`);
if (liveProbe) {
  let dockerOk = false;
  try {
    execSync("docker version", { stdio: "ignore" });
    dockerOk = true;
  } catch {}
  if (!dockerOk) {
    log("  ⓘ docker not reachable — skipping live probe");
  } else {
    const sandbox = createSandbox({
      backend: "docker",
      allowedImages: listAllowedImageRefs(),
    });
    const result = await sandbox.exec({
      image: JAVA_IMAGE_REF,
      argv: [...JAVA_HEALTHCHECK_ARGV],
      timeoutMs: 30_000,
    });
    check("live `java -version` exit 0", result.exitCode === 0);
    // `java -version` writes to stderr by convention.
    const versionText = `${result.stdout}\n${result.stderr}`;
    check(
      "live `java -version` stream contains `21`",
      /\b21\b/.test(versionText),
      `versionText=${versionText.slice(0, 200)}`,
    );
    await sandbox.close();
  }
} else {
  log("  ⓘ skipped (set CREWHAUS_SECTION36_LIVE_DOCKER=1 to enable)");
}

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
