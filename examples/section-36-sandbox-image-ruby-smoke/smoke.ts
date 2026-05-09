#!/usr/bin/env bun
/**
 * Section 36 sandbox-image-ruby smoke. Probes A-F mirror the §36 sibling
 * smokes. Live-image probe pulls ruby:3.3-alpine and runs `ruby --version`
 * when CREWHAUS_SECTION36_LIVE_DOCKER=1.
 */
import { execSync } from "node:child_process";
import { createSandbox } from "@crewhaus/sandbox";
import {
  _resetSandboxImageRegistry,
  hasSandboxImage,
  listAllowedImageRefs,
  lookupSandboxImage,
} from "@crewhaus/sandbox-image-registry";
import {
  RUBY_COLD_START_BUDGET_MS,
  RUBY_HEALTHCHECK_ARGV,
  RUBY_IMAGE_ID,
  RUBY_IMAGE_REF,
  registerRubySandboxImage,
} from "@crewhaus/sandbox-image-ruby";

const log = (s: string) => process.stdout.write(`[section-36-ruby] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

_resetSandboxImageRegistry();

log("probe A: registerRubySandboxImage()");
const entry = registerRubySandboxImage();
check("entry id is 'ruby'", entry.id === RUBY_IMAGE_ID);
check("entry image is ruby:3.3-alpine", entry.image === RUBY_IMAGE_REF);
check("entry defaultEntrypoint is `ruby -e`", entry.defaultEntrypoint.join(" ") === "ruby -e");

log("probe B: lookupSandboxImage");
check("hasSandboxImage('ruby')", hasSandboxImage(RUBY_IMAGE_ID));
check(
  "lookup returns the registered image",
  lookupSandboxImage(RUBY_IMAGE_ID).image === RUBY_IMAGE_REF,
);

log("probe C: listAllowedImageRefs surfaces the Ruby ref");
{
  const refs = listAllowedImageRefs();
  check("allowlist contains ruby:3.3-alpine", refs.includes(RUBY_IMAGE_REF));
  check("bootstrap trio still present", refs.includes("python:3.13-slim"));
}

log("probe D: noop sandbox round-trip via registry-derived allowlist");
{
  const sandbox = createSandbox({
    backend: "noop",
    allowedImages: listAllowedImageRefs(),
  });
  const result = await sandbox.exec({
    image: RUBY_IMAGE_REF,
    argv: ["printf", "ruby-snippet-ok"],
  });
  check("noop exec via ruby ref", result.exitCode === 0 && result.stdout === "ruby-snippet-ok");
  await sandbox.close();
}

log("probe E: T7 — cold-start budget");
check(
  `healthcheck.timeoutMs ≤ ${RUBY_COLD_START_BUDGET_MS}`,
  (entry.healthcheck.timeoutMs ?? 0) <= RUBY_COLD_START_BUDGET_MS,
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
      image: RUBY_IMAGE_REF,
      argv: [...RUBY_HEALTHCHECK_ARGV],
      timeoutMs: 30_000,
    });
    check("live `ruby --version` exit 0", result.exitCode === 0);
    check(
      "live `ruby --version` stdout contains `ruby 3.3`",
      result.stdout.includes("ruby 3.3"),
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
