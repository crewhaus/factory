#!/usr/bin/env bun
/**
 * Section 32 smoke — exercise docker-images / single-binary-cli / helm-chart /
 * crewhaus-cloud against fake runners (no real Docker / Bun --compile / Helm /
 * Terraform required). The real-infra probes (probe 1–5 in the kickoff) are
 * gated on env vars and are skipped when unavailable.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultCloudConfig,
  deployCloud,
  renderKustomizeOverlay,
  renderTerraformModule,
  summariseDeploy,
} from "@crewhaus/crewhaus-cloud";
import {
  TARGET_SHAPES,
  buildImage,
  fingerprintDockerfile,
  readDockerfile,
} from "@crewhaus/docker-images";
import { defaultValues, isDaemonShape, renderChart } from "@crewhaus/helm-chart";
import {
  BUILD_MATRIX,
  buildBinary,
  renderHomebrewFormula,
  renderScoopManifest,
  renderWingetManifest,
} from "@crewhaus/single-binary-cli";

const log = (line: string) => process.stdout.write(`[section-32-smoke] ${line}\n`);

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
}

// ─── Probe A: every Dockerfile compiles its structural contract ──────────────
log("probe A: structural contract per Dockerfile");
for (const target of TARGET_SHAPES) {
  const text = readDockerfile(target);
  const fp = fingerprintDockerfile(text);
  check(
    `dockerfile/${target}: multi-stage`,
    fp.stages.some((s) => s.stage === "deps") && fp.stages.length >= 2,
  );
  check(`dockerfile/${target}: HEALTHCHECK`, fp.hasHealthcheck);
  check(`dockerfile/${target}: USER crewhaus`, fp.nonRootUser === "crewhaus");
}

// ─── Probe B: buildImage argv shape with a fake runner ───────────────────────
log("probe B: buildImage argv via fake runner");
{
  const captured: string[] = [];
  await buildImage({
    target: "channel",
    tag: "smoke",
    runner: async (argv) => {
      captured.push(...argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  check(
    "buildImage emits docker buildx build",
    captured.includes("buildx") && captured.includes("build"),
  );
  check("buildImage tags crewhaus/channel:smoke", captured.includes("crewhaus/channel:smoke"));
}

// ─── Probe C: single-binary-cli matrix shape ────────────────────────────────
log("probe C: single-binary-cli matrix");
check(
  "BUILD_MATRIX has 5 entries (windows-arm64 absent)",
  BUILD_MATRIX.length === 5 &&
    !BUILD_MATRIX.some((m) => m.platform === "windows" && m.arch === "arm64"),
);

{
  let argv: readonly string[] = [];
  await buildBinary({
    target: { platform: "linux", arch: "x64" },
    version: "0.0.1",
    runner: async (a) => {
      argv = a;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  check(
    "buildBinary emits bun build --compile --target=bun-linux-x64",
    argv.includes("--compile") && argv.includes("bun-linux-x64"),
  );
}

// ─── Probe D: package manifest renderers are deterministic ──────────────────
log("probe D: package manifest renderers");
const sha = {
  "macos-arm64": "a".repeat(64),
  "macos-x64": "b".repeat(64),
  "linux-arm64": "c".repeat(64),
  "linux-x64": "d".repeat(64),
  "windows-x64": "e".repeat(64),
};
const inputs = {
  version: "1.0.0",
  homepage: "https://github.com/crewhaus/factory",
  downloadBaseUrl: "https://github.com/crewhaus/factory/releases/download/v1.0.0",
  sha256: sha,
};
const formula = renderHomebrewFormula(inputs);
check("homebrew formula has class Crewhaus", formula.includes("class Crewhaus < Formula"));
check("homebrew formula contains macos-arm64 sha", formula.includes(sha["macos-arm64"]));
const scoop = renderScoopManifest(inputs) as { architecture: { "64bit": { hash: string } } };
check(
  "scoop manifest hash matches windows-x64 sha",
  scoop.architecture["64bit"].hash === sha["windows-x64"],
);
const winget = renderWingetManifest(inputs);
check("winget manifest contains uppercase sha", winget.includes(sha["windows-x64"].toUpperCase()));

// ─── Probe E: helm-chart render per target shape ────────────────────────────
log("probe E: helm-chart per-shape render");
for (const target of TARGET_SHAPES) {
  const out = renderChart({ ...defaultValues(), target });
  check(
    `helm/${target}: deployment.yaml has kind: Deployment`,
    out["deployment.yaml"]?.includes("kind: Deployment") === true,
  );
  if (isDaemonShape(target)) {
    check(
      `helm/${target}: service.yaml has kind: Service`,
      out["service.yaml"]?.includes("kind: Service") === true,
    );
  } else {
    check(
      `helm/${target}: NO Service rendered (non-daemon)`,
      !out["service.yaml"]?.includes("kind: Service"),
    );
  }
}

// ─── Probe F: crewhaus-cloud render + dry-run deploy ────────────────────────
log("probe F: crewhaus-cloud render");
const cfg = defaultCloudConfig("aws", "us-east-1");
const tf = renderTerraformModule(cfg);
check("terraform module has aws_eks_cluster", tf.includes("aws_eks_cluster"));
check("terraform module has aws_s3_bucket audit_log", tf.includes("aws_s3_bucket"));

const overlay = renderKustomizeOverlay(cfg);
check(
  "kustomize overlay declares Kustomization",
  overlay.kustomization.includes("kind: Kustomization"),
);

const dryDir = mkdtempSync(join(tmpdir(), "section-32-smoke-"));
try {
  const result = await deployCloud({ config: cfg, workingDir: dryDir });
  check("deployCloud writes terraform/main.tf", existsSync(join(dryDir, "terraform", "main.tf")));
  check(
    "deployCloud writes kustomize/kustomization.yaml",
    existsSync(join(dryDir, "kustomize", "kustomization.yaml")),
  );
  check(
    "deployCloud marks all steps skipped without runner",
    result.steps.every((s) => s.skipped === true),
  );
  log(summariseDeploy(result));
} finally {
  rmSync(dryDir, { recursive: true, force: true });
}

// ─── Probe G: real Docker (gated) ─────────────────────────────────────────────
if (process.env.CREWHAUS_SECTION32_LIVE_DOCKER === "1") {
  log("probe G: real docker buildx (CREWHAUS_SECTION32_LIVE_DOCKER=1)");
  try {
    const r = await buildImage({ target: "cli", tag: "smoke" });
    check("docker buildx build crewhaus/cli:smoke", r.tag === "smoke");
  } catch (err) {
    check("docker buildx build crewhaus/cli:smoke", false, (err as Error).message);
  }
} else {
  log("probe G: skipped (CREWHAUS_SECTION32_LIVE_DOCKER not set)");
}

if (failed > 0) {
  log(`FAILED — ${failed} check(s) did not pass`);
  process.exit(1);
}
log("OK — all probes passed");
