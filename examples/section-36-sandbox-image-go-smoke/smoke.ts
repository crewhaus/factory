#!/usr/bin/env bun
/**
 * Section 36 sandbox-image-go smoke.
 *
 * Probes:
 *   A) registerGoSandboxImage() registers golang:1.23-alpine
 *   B) lookupSandboxImage("go") returns the right shape
 *   C) listAllowedImageRefs surfaces the Go ref to sandbox callers
 *   D) noop sandbox round-trip via the registry-derived allowlist
 *   E) cold-start budget (T7): healthcheck.timeoutMs ≤ 2_000ms
 *   F) live-image probe — only when CREWHAUS_SECTION36_LIVE_DOCKER=1.
 *      Pulls golang:1.23-alpine and runs `go version` against the real
 *      sandbox; verifies exit-code 0 and stdout contains "go version go1.23".
 */
import { execSync } from "node:child_process";
import { createSandbox } from "@crewhaus/sandbox";
import {
  GO_COLD_START_BUDGET_MS,
  GO_DEFAULT_ENTRYPOINT,
  GO_IMAGE_ID,
  GO_IMAGE_REF,
  registerGoSandboxImage,
} from "@crewhaus/sandbox-image-go";
import {
  _resetSandboxImageRegistry,
  hasSandboxImage,
  listAllowedImageRefs,
  lookupSandboxImage,
} from "@crewhaus/sandbox-image-registry";

const log = (s: string) => process.stdout.write(`[section-36-go] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

_resetSandboxImageRegistry();

// ── Probe A: registration ──────────────────────────────────────────────────
log("probe A: registerGoSandboxImage()");
const entry = registerGoSandboxImage();
check("entry id is 'go'", entry.id === GO_IMAGE_ID);
check("entry image is golang:1.23-alpine", entry.image === GO_IMAGE_REF);
check("entry defaultEntrypoint is `go run -`", entry.defaultEntrypoint.join(" ") === "go run -");

// ── Probe B: lookup ────────────────────────────────────────────────────────
log("probe B: lookupSandboxImage");
check("hasSandboxImage('go')", hasSandboxImage(GO_IMAGE_ID));
check(
  "lookup returns the registered image",
  lookupSandboxImage(GO_IMAGE_ID).image === GO_IMAGE_REF,
);

// ── Probe C: allowlist surface ─────────────────────────────────────────────
log("probe C: listAllowedImageRefs surfaces the Go ref");
{
  const refs = listAllowedImageRefs();
  check("allowlist contains golang:1.23-alpine", refs.includes(GO_IMAGE_REF));
  check("bootstrap trio still present", refs.includes("python:3.13-slim"));
}

// ── Probe D: noop round-trip ───────────────────────────────────────────────
log("probe D: noop sandbox round-trip via registry-derived allowlist");
{
  const sandbox = createSandbox({
    backend: "noop",
    allowedImages: listAllowedImageRefs(),
  });
  const result = await sandbox.exec({
    image: GO_IMAGE_REF,
    argv: ["printf", "go-snippet-ok"],
  });
  check("noop exec via go ref", result.exitCode === 0 && result.stdout === "go-snippet-ok");
  await sandbox.close();
}

// ── Probe E: T7 cold-start budget ──────────────────────────────────────────
log("probe E: T7 — cold-start budget");
check(
  `healthcheck.timeoutMs ≤ ${GO_COLD_START_BUDGET_MS}`,
  (entry.healthcheck.timeoutMs ?? 0) <= GO_COLD_START_BUDGET_MS,
);

// ── Probe F: live-image probe ──────────────────────────────────────────────
const liveProbe = process.env["CREWHAUS_SECTION36_LIVE_DOCKER"] === "1";
log(`probe F: live-image probe (gate=${liveProbe ? "on" : "off"})`);
if (liveProbe) {
  let dockerOk = false;
  try {
    execSync("docker version", { stdio: "ignore" });
    dockerOk = true;
  } catch {
    dockerOk = false;
  }
  if (!dockerOk) {
    log("  ⓘ docker not reachable — skipping live probe");
  } else {
    const sandbox = createSandbox({
      backend: "docker",
      allowedImages: listAllowedImageRefs(),
    });
    const result = await sandbox.exec({
      image: GO_IMAGE_REF,
      argv: [...GO_DEFAULT_ENTRYPOINT.slice(0, 1), "version"],
      timeoutMs: 30_000,
    });
    check("live `go version` exit code is 0", result.exitCode === 0);
    check(
      "live `go version` stdout contains `go version go1.23`",
      result.stdout.includes("go version go1.23"),
      `stdout=${result.stdout.slice(0, 200)}`,
    );
    await sandbox.close();
  }
} else {
  log("  ⓘ skipped (set CREWHAUS_SECTION36_LIVE_DOCKER=1 to enable)");
}

// ── Done ───────────────────────────────────────────────────────────────────
if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
