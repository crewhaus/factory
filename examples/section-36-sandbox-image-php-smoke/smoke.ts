#!/usr/bin/env bun
/**
 * Section 36 sandbox-image-php smoke. Probes A-F mirror the §36 sibling
 * smokes. Live-image probe pulls php:8.3-alpine and runs `php --version`
 * when CREWHAUS_SECTION36_LIVE_DOCKER=1.
 */
import { execSync } from "node:child_process";
import { createSandbox } from "@crewhaus/sandbox";
import {
  PHP_COLD_START_BUDGET_MS,
  PHP_HEALTHCHECK_ARGV,
  PHP_IMAGE_ID,
  PHP_IMAGE_REF,
  registerPhpSandboxImage,
} from "@crewhaus/sandbox-image-php";
import {
  _resetSandboxImageRegistry,
  hasSandboxImage,
  listAllowedImageRefs,
  lookupSandboxImage,
} from "@crewhaus/sandbox-image-registry";

const log = (s: string) => process.stdout.write(`[section-36-php] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

_resetSandboxImageRegistry();

log("probe A: registerPhpSandboxImage()");
const entry = registerPhpSandboxImage();
check("entry id is 'php'", entry.id === PHP_IMAGE_ID);
check("entry image is php:8.3-alpine", entry.image === PHP_IMAGE_REF);
check("entry defaultEntrypoint is `php -r`", entry.defaultEntrypoint.join(" ") === "php -r");

log("probe B: lookupSandboxImage");
check("hasSandboxImage('php')", hasSandboxImage(PHP_IMAGE_ID));
check(
  "lookup returns the registered image",
  lookupSandboxImage(PHP_IMAGE_ID).image === PHP_IMAGE_REF,
);

log("probe C: listAllowedImageRefs surfaces the PHP ref");
{
  const refs = listAllowedImageRefs();
  check("allowlist contains php:8.3-alpine", refs.includes(PHP_IMAGE_REF));
  check("bootstrap trio still present", refs.includes("python:3.13-slim"));
}

log("probe D: noop sandbox round-trip via registry-derived allowlist");
{
  const sandbox = createSandbox({
    backend: "noop",
    allowedImages: listAllowedImageRefs(),
  });
  const result = await sandbox.exec({
    image: PHP_IMAGE_REF,
    argv: ["printf", "php-snippet-ok"],
  });
  check("noop exec via php ref", result.exitCode === 0 && result.stdout === "php-snippet-ok");
  await sandbox.close();
}

log("probe E: T7 — cold-start budget");
check(
  `healthcheck.timeoutMs ≤ ${PHP_COLD_START_BUDGET_MS}`,
  (entry.healthcheck.timeoutMs ?? 0) <= PHP_COLD_START_BUDGET_MS,
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
      image: PHP_IMAGE_REF,
      argv: [...PHP_HEALTHCHECK_ARGV],
      timeoutMs: 30_000,
    });
    check("live `php --version` exit 0", result.exitCode === 0);
    check(
      "live `php --version` stdout contains `PHP 8.3`",
      result.stdout.includes("PHP 8.3"),
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
