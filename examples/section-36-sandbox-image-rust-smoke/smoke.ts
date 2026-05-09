#!/usr/bin/env bun
/**
 * Section 36 sandbox-image-rust smoke.
 *
 * Probes A-F mirror the §36 sandbox-image-go pattern. Live-image probe
 * gated on CREWHAUS_SECTION36_LIVE_DOCKER=1 — pulls rust:1-alpine and
 * runs `rustc --version` against the real sandbox.
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
  RUST_COLD_START_BUDGET_MS,
  RUST_HEALTHCHECK_ARGV,
  RUST_IMAGE_ID,
  RUST_IMAGE_REF,
  registerRustSandboxImage,
} from "@crewhaus/sandbox-image-rust";

const log = (s: string) => process.stdout.write(`[section-36-rust] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

_resetSandboxImageRegistry();

log("probe A: registerRustSandboxImage()");
const entry = registerRustSandboxImage();
check("entry id is 'rust'", entry.id === RUST_IMAGE_ID);
check("entry image is rust:1-alpine", entry.image === RUST_IMAGE_REF);
check("entry defaultEntrypoint is `rustc -`", entry.defaultEntrypoint.join(" ") === "rustc -");

log("probe B: lookupSandboxImage");
check("hasSandboxImage('rust')", hasSandboxImage(RUST_IMAGE_ID));
check(
  "lookup returns the registered image",
  lookupSandboxImage(RUST_IMAGE_ID).image === RUST_IMAGE_REF,
);

log("probe C: listAllowedImageRefs surfaces the Rust ref");
{
  const refs = listAllowedImageRefs();
  check("allowlist contains rust:1-alpine", refs.includes(RUST_IMAGE_REF));
  check("bootstrap trio still present", refs.includes("python:3.13-slim"));
}

log("probe D: noop sandbox round-trip via registry-derived allowlist");
{
  const sandbox = createSandbox({
    backend: "noop",
    allowedImages: listAllowedImageRefs(),
  });
  const result = await sandbox.exec({
    image: RUST_IMAGE_REF,
    argv: ["printf", "rust-snippet-ok"],
  });
  check("noop exec via rust ref", result.exitCode === 0 && result.stdout === "rust-snippet-ok");
  await sandbox.close();
}

log("probe E: T7 — cold-start budget");
check(
  `healthcheck.timeoutMs ≤ ${RUST_COLD_START_BUDGET_MS}`,
  (entry.healthcheck.timeoutMs ?? 0) <= RUST_COLD_START_BUDGET_MS,
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
      image: RUST_IMAGE_REF,
      argv: [...RUST_HEALTHCHECK_ARGV],
      timeoutMs: 30_000,
    });
    check("live `rustc --version` exit 0", result.exitCode === 0);
    check(
      "live `rustc --version` stdout contains `rustc 1.`",
      /^rustc 1\./.test(result.stdout.trim()),
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
