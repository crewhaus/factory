#!/usr/bin/env bun
/**
 * Section 36 sandbox-image-dotnet smoke. Probes A-F mirror the §36
 * sibling smokes. Live-image probe pulls the .NET SDK image and runs
 * `dotnet --version` when CREWHAUS_SECTION36_LIVE_DOCKER=1.
 */
import { execSync } from "node:child_process";
import { createSandbox } from "@crewhaus/sandbox";
import {
  DOTNET_COLD_START_BUDGET_MS,
  DOTNET_HEALTHCHECK_ARGV,
  DOTNET_IMAGE_ID,
  DOTNET_IMAGE_REF,
  registerDotnetSandboxImage,
} from "@crewhaus/sandbox-image-dotnet";
import {
  _resetSandboxImageRegistry,
  hasSandboxImage,
  listAllowedImageRefs,
  lookupSandboxImage,
} from "@crewhaus/sandbox-image-registry";

const log = (s: string) => process.stdout.write(`[section-36-dotnet] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

_resetSandboxImageRegistry();

log("probe A: registerDotnetSandboxImage()");
const entry = registerDotnetSandboxImage();
check("entry id is 'dotnet'", entry.id === DOTNET_IMAGE_ID);
check("entry image is mcr.microsoft.com/dotnet/sdk:8.0-alpine", entry.image === DOTNET_IMAGE_REF);
check(
  "entry defaultEntrypoint is `dotnet script`",
  entry.defaultEntrypoint.join(" ") === "dotnet script",
);

log("probe B: lookupSandboxImage");
check("hasSandboxImage('dotnet')", hasSandboxImage(DOTNET_IMAGE_ID));
check(
  "lookup returns the registered image",
  lookupSandboxImage(DOTNET_IMAGE_ID).image === DOTNET_IMAGE_REF,
);

log("probe C: listAllowedImageRefs surfaces the dotnet ref");
{
  const refs = listAllowedImageRefs();
  check("allowlist contains the .NET SDK ref", refs.includes(DOTNET_IMAGE_REF));
  check("bootstrap trio still present", refs.includes("python:3.13-slim"));
}

log("probe D: noop sandbox round-trip via registry-derived allowlist");
{
  const sandbox = createSandbox({
    backend: "noop",
    allowedImages: listAllowedImageRefs(),
  });
  const result = await sandbox.exec({
    image: DOTNET_IMAGE_REF,
    argv: ["printf", "dotnet-snippet-ok"],
  });
  check("noop exec via dotnet ref", result.exitCode === 0 && result.stdout === "dotnet-snippet-ok");
  await sandbox.close();
}

log("probe E: T7 — cold-start budget (≤4s, the looser bucket)");
check(
  `healthcheck.timeoutMs ≤ ${DOTNET_COLD_START_BUDGET_MS}`,
  (entry.healthcheck.timeoutMs ?? 0) <= DOTNET_COLD_START_BUDGET_MS,
);
check(
  ".NET budget is 4s (looser than compiled-language 2s)",
  DOTNET_COLD_START_BUDGET_MS === 4_000,
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
      image: DOTNET_IMAGE_REF,
      argv: [...DOTNET_HEALTHCHECK_ARGV],
      timeoutMs: 60_000,
    });
    check("live `dotnet --version` exit 0", result.exitCode === 0);
    check(
      "live `dotnet --version` stdout starts with 8.",
      /^8\./.test(result.stdout.trim()),
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
