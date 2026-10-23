#!/usr/bin/env bun
/**
 * build-sandbox-images.ts — build the provability checkers' sandbox images
 * locally, tagged exactly as the checkers run them (design/0.8.0-provability-release.md
 * §6.4, §14 PR 8).
 *
 * Run:
 *   bun scripts/build-sandbox-images.ts               # z3 and lean4
 *   bun scripts/build-sandbox-images.ts lean4         # one of them
 *   bun scripts/build-sandbox-images.ts --dry-run     # print the commands only
 *
 * The release job (`sandbox-images` in .github/workflows/release.yml) builds
 * the same Dockerfiles on GitHub's amd64 runners and pushes them to GHCR; this
 * is the local half — for the live checker test
 * (`CREWHAUS_SECTION36_LIVE_DOCKER=1 bun test src/sandbox.live.test.ts` in
 * packages/proof-checker) and for a machine that cannot pull the release
 * images yet. The tags come from the registration packages, so a local build
 * cannot drift from the ref `@crewhaus/proof-checker` runs. A local build is
 * the host's architecture (linux/arm64 on Apple silicon): each Dockerfile
 * picks its download by BuildKit's TARGETARCH, which is why this uses
 * `docker buildx build` and never the legacy builder.
 *
 * With `CREWHAUS_SANDBOX=podman` — the backend that will then run the images —
 * it builds with podman (buildah sets TARGETARCH too).
 */

// Relative imports (not "@crewhaus/sandbox-image-*"): root-level scripts sit
// outside the workspace packages, so bare workspace specifiers would
// auto-install the published packages from npm instead of using this checkout
// (record-image-digests.ts's rule).
import { join } from "node:path";
import { LEAN4_IMAGE_REF } from "../packages/sandbox-image-lean4/src/index.ts";
import { Z3_IMAGE_REF } from "../packages/sandbox-image-z3/src/index.ts";

export type SandboxImageBuild = {
  /** The registry id, and the `sandbox-<id>` the release job pushes. */
  readonly id: "z3" | "lean4";
  /** The ref the checker runs (the registration package's constant). */
  readonly ref: string;
  /** The package directory: its Dockerfile, and the (empty) build context. */
  readonly dir: string;
};

export const SANDBOX_IMAGE_BUILDS: ReadonlyArray<SandboxImageBuild> = [
  { id: "z3", ref: Z3_IMAGE_REF, dir: "packages/sandbox-image-z3" },
  { id: "lean4", ref: LEAN4_IMAGE_REF, dir: "packages/sandbox-image-lean4" },
];

/**
 * The repo root, where the build runs (the argv's paths are relative to it).
 * A file path, not `new URL("..", import.meta.url).pathname`: that stays
 * percent-encoded, so a checkout under a directory with a space or a
 * non-ASCII character got a cwd that does not exist (W3-B review).
 */
export const REPO_ROOT = join(import.meta.dir, "..");

/** The argv that builds one image into the local daemon (`--load`), tagged with its ref. */
export function buildArgv(image: SandboxImageBuild, cli = "docker"): string[] {
  const build = cli === "podman" ? ["build"] : ["buildx", "build", "--load"];
  return [cli, ...build, "--tag", image.ref, "--file", `${image.dir}/Dockerfile`, image.dir];
}

/** The images named on the command line (every image when none is), or a usage error. */
export function selectImages(
  args: ReadonlyArray<string>,
): { readonly images: SandboxImageBuild[]; readonly dryRun: boolean } | { readonly error: string } {
  const dryRun = args.includes("--dry-run");
  const ids = args.filter((a) => a !== "--dry-run");
  const unknown = ids.filter((id) => !SANDBOX_IMAGE_BUILDS.some((b) => b.id === id));
  if (unknown.length > 0) {
    return {
      error: `unknown image ${unknown.map((u) => `"${u}"`).join(", ")} (known: ${SANDBOX_IMAGE_BUILDS.map((b) => b.id).join(", ")})`,
    };
  }
  const images =
    ids.length === 0
      ? [...SANDBOX_IMAGE_BUILDS]
      : SANDBOX_IMAGE_BUILDS.filter((b) => ids.includes(b.id));
  return { images, dryRun };
}

if (import.meta.main) {
  const picked = selectImages(process.argv.slice(2));
  if ("error" in picked) {
    console.error(`build-sandbox-images: ${picked.error}`);
    process.exit(2);
  }
  const cli = process.env["CREWHAUS_SANDBOX"]?.trim() === "podman" ? "podman" : "docker";
  for (const image of picked.images) {
    const argv = buildArgv(image, cli);
    console.log(`$ ${argv.join(" ")}`);
    if (picked.dryRun) continue;
    const proc = Bun.spawnSync(argv, { cwd: REPO_ROOT, stdio: ["inherit", "inherit", "inherit"] });
    if (proc.exitCode !== 0) {
      console.error(`build-sandbox-images: building ${image.ref} failed (exit ${proc.exitCode})`);
      process.exit(proc.exitCode ?? 1);
    }
    console.log(`built ${image.ref}`);
  }
}
