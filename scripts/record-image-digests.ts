#!/usr/bin/env bun
/**
 * record-image-digests.ts — Close the digests.json loop for CI-published images (item 47).
 *
 * After the Release workflow's docker jobs push `ghcr.io/crewhaus/<target>:<version>`,
 * this script asks the registry for each image's manifest digest
 * (`docker buildx imagetools inspect`) and records it through the same
 * `recordDigest()` lockfile seam `crewhaus build-image` maintains locally.
 * The workflow then commits the updated docker/digests.json back to main.
 *
 * Run:
 *   bun scripts/record-image-digests.ts --version 0.1.9
 *   bun scripts/record-image-digests.ts --version 0.1.9 --registry ghcr.io/crewhaus \
 *     --targets cli,channel --digests /tmp/digests.json     # narrowed / testable form
 *
 * `--version` is REQUIRED — it is both the image tag to inspect and the
 * lockfile key. Targets default to every shape with a Dockerfile on disk.
 * Exits non-zero if any digest could not be resolved, so a half-recorded
 * lockfile never lands silently.
 */

// Relative import (not "@crewhaus/docker-images"): root-level scripts sit outside
// the workspace packages, so bare workspace specifiers would auto-install the
// published package from npm instead of using this checkout.
import {
  defaultRunner,
  digestsPath,
  isTargetShape,
  listAvailableTargets,
  recordDigest,
} from "../packages/docker-images/src/index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const version = flag("version");
if (version === undefined || version === "") {
  console.error("record-image-digests: --version <semver> is required (the pushed image tag)");
  process.exit(1);
}
const registry = flag("registry") ?? "ghcr.io/crewhaus";
const digestsFile = flag("digests") ?? digestsPath();
const targetsFlag = flag("targets");
const targets =
  targetsFlag !== undefined && targetsFlag !== ""
    ? targetsFlag.split(",").map((t) => t.trim())
    : [...listAvailableTargets()];

let failures = 0;
for (const target of targets) {
  if (!isTargetShape(target)) {
    console.error(`FAIL unknown target shape: ${target}`);
    failures++;
    continue;
  }
  const ref = `${registry}/${target}:${version}`;
  const { exitCode, stdout, stderr } = await defaultRunner(
    ["docker", "buildx", "imagetools", "inspect", ref],
    process.cwd(),
  );
  const digest = /sha256:[0-9a-f]{64}/.exec(stdout)?.[0];
  if (exitCode !== 0 || digest === undefined) {
    const reason =
      exitCode !== 0
        ? `imagetools inspect exited ${exitCode}: ${stderr.trim().slice(0, 300)}`
        : "no sha256 digest in imagetools output";
    console.error(`FAIL ${ref}: ${reason}`);
    failures++;
    continue;
  }
  recordDigest(target, version, digest, digestsFile);
  console.log(`recorded ${digest}  ${ref}`);
}

console.log(
  `[record-image-digests] recorded=${targets.length - failures} failed=${failures} → ${digestsFile}`,
);
if (failures > 0) process.exit(1);
