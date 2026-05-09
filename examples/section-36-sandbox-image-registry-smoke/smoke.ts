#!/usr/bin/env bun
/**
 * Section 36 sandbox-image-registry smoke.
 *
 * Probes:
 *   A) §18 trio (python / javascript / shell) auto-registers
 *   B) registerSandboxImage validates id / image / healthcheck shape
 *   C) duplicate registration is refused (T8)
 *   D) untrusted image refs are refused (T8)
 *   E) listAllowedImageRefs feeds into sandbox.allowedImages cleanly —
 *      a noop sandbox can exec the registered images via lookup
 *   F) snapshotImageStatuses reflects markHealthy / markUnhealthy
 *   G) runHealthchecks drives a caller-supplied probe and updates state
 *
 * The smoke does not require docker — it uses the noop backend so the
 * baseline workspace test layer stays green. The per-language language
 * smokes (sandbox-image-go, -rust, etc.) attach their own per-image
 * probes and reuse this same registry.
 */
import { createSandbox } from "@crewhaus/sandbox";
import {
  ImageNotFoundError,
  ImageRegistrationError,
  _resetSandboxImageRegistry,
  hasSandboxImage,
  listAllowedImageRefs,
  listSandboxImages,
  lookupSandboxImage,
  markHealthy,
  markUnhealthy,
  registerSandboxImage,
  runHealthchecks,
  snapshotImageStatuses,
} from "@crewhaus/sandbox-image-registry";

const log = (s: string) => process.stdout.write(`[section-36-registry] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

_resetSandboxImageRegistry();

// ── Probe A: bootstrap trio ────────────────────────────────────────────────
log("probe A: §18 trio auto-registers");
check("python registered", hasSandboxImage("python"));
check("javascript registered", hasSandboxImage("javascript"));
check("shell registered", hasSandboxImage("shell"));
check(
  "python image is python:3.13-slim",
  lookupSandboxImage("python").image === "python:3.13-slim",
);
check(
  "javascript image is node:22-alpine",
  lookupSandboxImage("javascript").image === "node:22-alpine",
);
check("shell image is alpine:3.19", lookupSandboxImage("shell").image === "alpine:3.19");

// ── Probe B: registration shape ────────────────────────────────────────────
log("probe B: register a Go sandbox image");
const goEntry = registerSandboxImage({
  id: "go",
  image: "golang:1.23-alpine",
  defaultEntrypoint: ["go", "run", "-"],
  healthcheck: { command: ["go", "version"], expectedExitCode: 0, timeoutMs: 2_000 },
  description: "Go 1.23 alpine",
});
check("go entry image", goEntry.image === "golang:1.23-alpine");
check("go entry entrypoint", goEntry.defaultEntrypoint.join(" ") === "go run -");
{
  const ids = listSandboxImages().map((e) => e.id);
  check(
    "listSandboxImages includes go + bootstrap trio",
    ids.includes("go") &&
      ids.includes("python") &&
      ids.includes("javascript") &&
      ids.includes("shell"),
  );
}

// ── Probe C: duplicate registration refused ────────────────────────────────
log("probe C: duplicate registration refused");
let duplicated = false;
try {
  registerSandboxImage({
    id: "go",
    image: "golang:1.23-alpine",
    defaultEntrypoint: ["go", "run", "-"],
    healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
  });
} catch (err) {
  duplicated = err instanceof ImageRegistrationError && /already registered/.test(err.message);
}
check("duplicate go id is refused", duplicated);

// ── Probe D: untrusted image refs refused ──────────────────────────────────
log("probe D: T8 — untrusted image refs refused");
const refusals: ReadonlyArray<{ name: string; image: string }> = [
  { name: "CLI flag injection", image: "--privileged" },
  { name: "whitespace tampering", image: "alpine:3.19 --privileged" },
  { name: "newline injection", image: "alpine:3.19\n--privileged" },
  { name: "shell-meta tag", image: "alpine:$(id)" },
];
for (const t of refusals) {
  let refused = false;
  try {
    registerSandboxImage({
      id: `evil-${t.name.replace(/\s+/g, "-")}`,
      image: t.image,
      defaultEntrypoint: ["sh", "-c"],
      healthcheck: { command: ["true"], expectedExitCode: 0 },
    });
  } catch (err) {
    refused = err instanceof ImageRegistrationError;
  }
  check(`refuses ${t.name}`, refused);
}

// ── Probe E: registry feeds sandbox.allowedImages ──────────────────────────
log("probe E: registry → sandbox.allowedImages round-trip (noop backend)");
{
  const sandbox = createSandbox({
    backend: "noop",
    allowedImages: listAllowedImageRefs(),
  });
  // python:3.13-slim → noop spawns the argv directly. Use an argv that's
  // present everywhere (printf) so we get a clean exit code.
  const result = await sandbox.exec({
    image: lookupSandboxImage("python").image,
    argv: ["printf", "registered"],
  });
  check(
    "noop exec via registry-derived allowlist",
    result.stdout === "registered" && result.exitCode === 0,
  );
  await sandbox.close();
}

// ── Probe F: status tracking ───────────────────────────────────────────────
log("probe F: markHealthy / markUnhealthy update statuses");
markHealthy("python", 1700000000000);
{
  const s = snapshotImageStatuses().find((x) => x.id === "python");
  check("python markHealthy → healthy=true", s?.healthy === true);
  check(
    "python lastHealthyAt is ISO timestamp",
    s?.lastHealthyAt === new Date(1700000000000).toISOString(),
  );
}
markUnhealthy("python", "image pull denied");
{
  const s = snapshotImageStatuses().find((x) => x.id === "python");
  check("python markUnhealthy → healthy=false", s?.healthy === false);
  check("python lastError set", s?.lastError === "image pull denied");
}

let notFound = false;
try {
  markHealthy("ghost");
} catch (err) {
  notFound = err instanceof ImageNotFoundError;
}
check("markHealthy(unknown) throws ImageNotFoundError", notFound);

// ── Probe G: runHealthchecks drives a caller-supplied probe ────────────────
log("probe G: runHealthchecks drives caller-supplied probe");
{
  const calls: string[] = [];
  const statuses = await runHealthchecks(async (entry) => {
    calls.push(entry.id);
    if (entry.id === "javascript") return { exitCode: 17, stderr: "node not found" };
    if (entry.id === "shell") throw new Error("shell probe failed");
    return { exitCode: 0, stderr: "" };
  });
  check("probe ran for every registered image", calls.length === listSandboxImages().length);
  const byId = new Map(statuses.map((s) => [s.id, s]));
  check(
    "healthy entries: go + python",
    byId.get("go")?.healthy === true && byId.get("python")?.healthy === true,
  );
  check("unhealthy via non-zero exit", byId.get("javascript")?.healthy === false);
  check("unhealthy via thrown probe", byId.get("shell")?.healthy === false);
}

// ── Done ───────────────────────────────────────────────────────────────────
if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
