#!/usr/bin/env bun
/**
 * Section 36 sandbox-image-r smoke. Probes A-F mirror the §36 sibling
 * smokes. Live-image probe pulls rocker/r-base:4.4 and runs
 * `Rscript -e cat(R.version.string)` when CREWHAUS_SECTION36_LIVE_DOCKER=1.
 */
import { execSync } from "node:child_process";
import { createSandbox } from "@crewhaus/sandbox";
import {
  R_COLD_START_BUDGET_MS,
  R_HEALTHCHECK_ARGV,
  R_IMAGE_ID,
  R_IMAGE_REF,
  registerRSandboxImage,
} from "@crewhaus/sandbox-image-r";
import {
  _resetSandboxImageRegistry,
  hasSandboxImage,
  listAllowedImageRefs,
  lookupSandboxImage,
} from "@crewhaus/sandbox-image-registry";

const log = (s: string) => process.stdout.write(`[section-36-r] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

_resetSandboxImageRegistry();

log("probe A: registerRSandboxImage()");
const entry = registerRSandboxImage();
check("entry id is 'r'", entry.id === R_IMAGE_ID);
check("entry image is rocker/r-base:4.4", entry.image === R_IMAGE_REF);
check(
  "entry defaultEntrypoint is `Rscript -e`",
  entry.defaultEntrypoint.join(" ") === "Rscript -e",
);

log("probe B: lookupSandboxImage");
check("hasSandboxImage('r')", hasSandboxImage(R_IMAGE_ID));
check("lookup returns the registered image", lookupSandboxImage(R_IMAGE_ID).image === R_IMAGE_REF);

log("probe C: listAllowedImageRefs surfaces the R ref");
{
  const refs = listAllowedImageRefs();
  check("allowlist contains rocker/r-base:4.4", refs.includes(R_IMAGE_REF));
  check("bootstrap trio still present", refs.includes("python:3.13-slim"));
}

log("probe D: noop sandbox round-trip via registry-derived allowlist");
{
  const sandbox = createSandbox({
    backend: "noop",
    allowedImages: listAllowedImageRefs(),
  });
  const result = await sandbox.exec({
    image: R_IMAGE_REF,
    argv: ["printf", "r-snippet-ok"],
  });
  check("noop exec via r ref", result.exitCode === 0 && result.stdout === "r-snippet-ok");
  await sandbox.close();
}

log("probe E: T7 — cold-start budget");
check(
  `healthcheck.timeoutMs ≤ ${R_COLD_START_BUDGET_MS}`,
  (entry.healthcheck.timeoutMs ?? 0) <= R_COLD_START_BUDGET_MS,
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
      image: R_IMAGE_REF,
      argv: [...R_HEALTHCHECK_ARGV],
      timeoutMs: 30_000,
    });
    check("live `Rscript -e cat(R.version.string)` exit 0", result.exitCode === 0);
    check(
      "live R version output contains `R version 4.`",
      /R version 4\./.test(result.stdout),
      `stdout=${result.stdout.slice(0, 200)}`,
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
