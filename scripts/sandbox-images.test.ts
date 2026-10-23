/**
 * The provability sandbox images ship through ONE path, and these tests hold
 * its pieces in step (design/0.8.0-provability-release.md §6.4, §14 PR 8):
 *
 *   - release.yml's `sandbox-images` job builds packages/sandbox-image-<id>/
 *     Dockerfile and pushes ghcr.io/crewhaus/sandbox-<id> — the repo the
 *     registration package pins, for every image that package set has;
 *   - the job follows the file's own rules: pinned action SHAs (the docker
 *     job's), `${{ }}` only in `env:` (the workflow-injection rule in the
 *     header), the docker job's GHCR login and `:latest` gate;
 *   - the images are not target shapes, so they stay out of docker-images'
 *     TARGET_SHAPES, the docker matrix and record-image-digests;
 *   - scripts/build-sandbox-images.ts tags local builds with the very refs
 *     the checkers run.
 *
 * The job's shell was also run end to end against the real images with
 * `docker push` stubbed (the 0.8.0 W3-B report); this file is what keeps it
 * from drifting.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TARGET_SHAPES } from "../packages/docker-images/src/index.ts";
import { LEAN4_IMAGE_REF, LEAN4_IMAGE_REPO } from "../packages/sandbox-image-lean4/src/index.ts";
import { Z3_IMAGE_REF, Z3_IMAGE_REPO } from "../packages/sandbox-image-z3/src/index.ts";
import { REPO_ROOT, SANDBOX_IMAGE_BUILDS, buildArgv, selectImages } from "./build-sandbox-images";

const ROOT = dirname(import.meta.dir);
const RELEASE = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");

type Step = { uses?: string; name?: string; env?: Record<string, string>; run?: string };
type Job = {
  needs?: string | string[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: Record<string, unknown> };
  steps?: Step[];
};
const WORKFLOW = Bun.YAML.parse(RELEASE) as { jobs: Record<string, Job> };
const JOB = WORKFLOW.jobs["sandbox-images"] as Job;
const DOCKER = WORKFLOW.jobs["docker"] as Job;
const step = (job: Job, name: string): Step | undefined => job.steps?.find((s) => s.name === name);

/** The repo each registration package pins, by image id. */
const REPOS: Record<string, string> = { z3: Z3_IMAGE_REPO, lean4: LEAN4_IMAGE_REPO };

describe("release.yml — the sandbox-images job", () => {
  test("exists, gated on the build like every channel, with only the permissions it needs", () => {
    expect(JOB).toBeDefined();
    expect(JOB.needs).toBe("build");
    expect(JOB["runs-on"]).toBe("ubuntu-latest");
    expect(JOB.permissions).toEqual({ contents: "read", packages: "write" });
    const minutes = JOB["timeout-minutes"];
    expect(typeof minutes === "number" && minutes > 0 && minutes <= 60).toBe(true);
  });

  test("its matrix is exactly the images the registration packages pin, each with a Dockerfile", () => {
    expect(JOB.strategy?.["fail-fast"]).toBe(false);
    const images = JOB.strategy?.matrix?.["image"] as string[];
    expect(images).toEqual(SANDBOX_IMAGE_BUILDS.map((b) => b.id));
    for (const id of images) {
      expect(existsSync(join(ROOT, "packages", `sandbox-image-${id}`, "Dockerfile"))).toBe(true);
      expect(REPOS[id]).toBe(`ghcr.io/crewhaus/sandbox-${id}`);
    }
    const run = step(JOB, "Build, smoke-test, push")?.run ?? "";
    expect(run).toContain('REF="ghcr.io/crewhaus/sandbox-$IMAGE:$VERSION"');
    expect(run).toContain('--file "packages/sandbox-image-$IMAGE/Dockerfile"');
    // Every matrix image has a smoke case; anything else fails the job.
    for (const id of images) expect(run).toMatch(new RegExp(`^\\s+${id}\\)$`, "m"));
    expect(run).toContain(`*) echo "::error::no smoke test for sandbox image '$IMAGE'"; exit 1 ;;`);
  });

  test("uses only the action SHAs the docker job pins, and its GHCR login verbatim", () => {
    const pinned = new Set((DOCKER.steps ?? []).flatMap((s) => (s.uses ? [s.uses] : [])));
    const uses = (JOB.steps ?? []).flatMap((s) => (s.uses ? [s.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u).toMatch(/@[0-9a-f]{40}$/);
      expect(pinned.has(u)).toBe(true);
    }
    expect(step(JOB, "Log in to GHCR")).toEqual(step(DOCKER, "Log in to GHCR") as Step);
  });

  test("every ${{ }} value reaches the shell through env:, never inlined (the header's rule)", () => {
    for (const s of JOB.steps ?? []) {
      expect(s.run ?? "").not.toContain("${{");
      for (const value of Object.values(s.env ?? {})) {
        expect(value).toMatch(
          /^\$\{\{ (github\.token|github\.actor|matrix\.image|needs\.build\.outputs\.version) \}\}$/,
        );
      }
    }
  });

  test("`:latest` moves only for a stable X.Y.Z, with the docker job's own test", () => {
    const gate = "grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+$'";
    expect(step(DOCKER, "Build + push image")?.run).toContain(gate);
    const run = step(JOB, "Build, smoke-test, push")?.run ?? "";
    expect(run).toContain(`if printf '%s' "$VERSION" | ${gate}; then`);
    expect(run).toContain('LATEST="ghcr.io/crewhaus/sandbox-$IMAGE:latest"');
  });

  test("the image is smoke-run the way the sandbox runs it before anything is pushed", () => {
    const run = step(JOB, "Build, smoke-test, push")?.run ?? "";
    // The WHOLE buildx command, `\` continuations joined: a `--push` (or a
    // registry output) on any of its lines would publish an untested image.
    // (Matching only its first two lines let `--load --push` through — W3-B
    // review.)
    const lines = run.split("\n");
    const start = lines.findIndex((l) => l.includes("docker buildx build"));
    expect(start).toBeGreaterThanOrEqual(0);
    let end = start;
    while (end < lines.length && /\\\s*$/.test(lines[end] as string)) end += 1;
    const build = lines.slice(start, end + 1).join(" ");
    expect(build).toContain("--load");
    expect(build).not.toMatch(/--push|--output|(^|\s)-o(\s|=)|type=registry/);
    expect(run.match(/docker buildx build/g)).toHaveLength(1);
    expect(run).toContain("--network=none --read-only --tmpfs /tmp");
    expect(run).toContain("--user 65532:65532");
    expect(run.indexOf("smoke OK")).toBeLessThan(run.indexOf("docker push"));
  });

  test("an already-published version tag is never rebuilt or overwritten", () => {
    const run = step(JOB, "Build, smoke-test, push")?.run ?? "";
    const guard = run.indexOf('if INSPECT="$(docker buildx imagetools inspect "$REF" 2>&1)"; then');
    expect(guard).toBeGreaterThan(run.indexOf('REF="ghcr.io/crewhaus/sandbox-$IMAGE:$VERSION"'));
    expect(guard).toBeLessThan(run.indexOf("docker buildx build"));
  });

  test("the file header lists the channel", () => {
    expect(RELEASE).toMatch(/^# {3}• GHCR {11}→ ghcr\.io\/crewhaus\/sandbox-<id>/m);
  });
});

/**
 * The job's shell, run for real under the runner's `bash -e` (GitHub's
 * default `run:` shell, no pipefail) with `docker` stubbed on PATH. The stub
 * logs every call and answers the way the real CLI does: the registry is a
 * file that inspect reads and push appends to, so a re-run sees what the last
 * attempt published; `lean` exits 1 when it reports an error, and a solver
 * that cannot start exits the way `docker run` does (127, nothing on stdout).
 * What is held here is behaviour, so a reworded script that still pushes
 * before the smoke run, pushes from the build, replaces a published tag,
 * strands `:latest` after a partial push, or dies on a failed smoke without
 * saying why fails.
 */
describe("release.yml — the sandbox-images job's shell, run with docker stubbed", () => {
  const RUN = step(JOB, "Build, smoke-test, push")?.run ?? "";
  const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1 $2" in
  "buildx imagetools")
    if grep -qxF "$4" "$FAKE_REGISTRY"; then echo "Name: $4"; exit 0; fi
    echo "ERROR: $4: not found" >&2; exit 1 ;;
  "buildx build") exit 0 ;;
esac
case "$1" in
  run)
    cat > /dev/null
    case "$*" in
      *" z3 -in")
        if [ -n "$FAKE_Z3_SAYS" ]; then printf '%s\\n' "$FAKE_Z3_SAYS"; fi
        if [ "$FAKE_Z3_EXIT" = 127 ]; then echo 'docker: exec: "z3": executable file not found in $PATH' >&2; fi
        exit "$FAKE_Z3_EXIT" ;;
      *" lean --stdin --json")
        printf '%s\\n' "$FAKE_LEAN_SAYS"
        case "$FAKE_LEAN_SAYS" in *'"severity":"error"'*) exit 1 ;; esac ;;
      *) exit 125 ;;
    esac ;;
  push)
    if [ "$2" = "$FAKE_PUSH_FAILS" ]; then echo "received unexpected HTTP status: 502 Bad Gateway" >&2; exit 1; fi
    printf '%s\\n' "$2" >> "$FAKE_REGISTRY" ;;
  *) echo "unexpected docker $*" >&2; exit 2 ;;
esac
`;

  type Outcome = { exitCode: number; stdout: string; calls: string[] };

  /** What the real image prints for the job's lean4 smoke file (one JSON message per line). */
  const LEAN_OK = [
    `{"data":"'smoke' does not depend on any axioms","severity":"information"}`,
    `{"data":"'smoke_sat' depends on axioms: [propext, smoke_sat._native.bv_decide.ax_1_5]","severity":"information"}`,
  ];

  /** A registry file shared by several runs of the job, as a re-run shares GHCR. */
  function withRegistry<T>(fn: (registry: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-sandbox-images-registry-"));
    try {
      const registry = join(dir, "registry");
      writeFileSync(registry, "");
      return fn(registry);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const published = (registry: string): string[] =>
    readFileSync(registry, "utf8").split("\n").filter(Boolean).sort();

  function runJob(
    image: string,
    version: string,
    opts: {
      /** A registry file to read and push to; a fresh empty one when absent. */
      registry?: string;
      /** Seed the registry with this run's version tag. */
      published?: boolean;
      z3Says?: string;
      z3Exit?: number;
      leanSays?: string[];
      /** The one ref whose push answers 502. */
      pushFails?: string;
    } = {},
  ): Outcome {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-sandbox-images-job-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "docker"), FAKE_DOCKER);
      chmodSync(join(bin, "docker"), 0o755);
      const script = join(dir, "run.sh");
      writeFileSync(script, RUN);
      const log = join(dir, "docker.log");
      writeFileSync(log, "");
      const registry = opts.registry ?? join(dir, "registry");
      if (opts.registry === undefined) writeFileSync(registry, "");
      if (opts.published === true) {
        writeFileSync(registry, `ghcr.io/crewhaus/sandbox-${image}:${version}\n`, { flag: "a" });
      }
      const proc = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", script], {
        cwd: ROOT,
        env: {
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          IMAGE: image,
          VERSION: version,
          FAKE_DOCKER_LOG: log,
          FAKE_REGISTRY: registry,
          FAKE_PUSH_FAILS: opts.pushFails ?? "",
          FAKE_Z3_SAYS: opts.z3Says ?? "unsat",
          FAKE_Z3_EXIT: String(opts.z3Exit ?? 0),
          FAKE_LEAN_SAYS: (opts.leanSays ?? LEAN_OK).join("\n"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
      return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const kinds = (calls: string[]): string[] =>
    calls.map((c) =>
      c.startsWith("buildx imagetools inspect ")
        ? "inspect"
        : c.startsWith("buildx build ")
          ? "build"
          : (c.split(" ")[0] as string),
    );

  test("a stable version: inspect, build (load only), smoke run, then push :latest and the version last", () => {
    for (const image of SANDBOX_IMAGE_BUILDS.map((b) => b.id)) {
      const r = runJob(image, "9.9.9");
      expect(r.exitCode).toBe(0);
      expect(kinds(r.calls)).toEqual(["inspect", "build", "run", "push", "push"]);
      const build = r.calls[1] as string;
      expect(build).toContain("--load");
      expect(build).not.toContain("--push");
      expect(build).toContain(`--file packages/sandbox-image-${image}/Dockerfile`);
      expect(build).toContain(`--tag ghcr.io/crewhaus/sandbox-${image}:9.9.9`);
      expect(build).toContain(`--tag ghcr.io/crewhaus/sandbox-${image}:latest`);
      expect(r.calls[2]).toContain("--network=none --read-only --tmpfs /tmp");
      expect(r.calls.slice(3)).toEqual([
        `push ghcr.io/crewhaus/sandbox-${image}:latest`,
        `push ghcr.io/crewhaus/sandbox-${image}:9.9.9`,
      ]);
      expect(r.stdout).toContain(`ghcr.io/crewhaus/sandbox-${image}:9.9.9 smoke OK`);
    }
  }, 20_000);

  // The guard keys on the version tag alone, so whichever push fails, the
  // re-run must find that tag absent and publish both. With the version pushed
  // first, a 502 on `:latest` left the re-run green and `:latest` on the
  // previous release (W3-B post-fix review).
  for (const failing of ["latest", "9.9.9"]) {
    test(`a push of :${failing} that fails: the job fails, and its re-run publishes every tag`, () => {
      withRegistry((registry) => {
        const tags = ["ghcr.io/crewhaus/sandbox-z3:9.9.9", "ghcr.io/crewhaus/sandbox-z3:latest"];
        const first = runJob("z3", "9.9.9", {
          registry,
          pushFails: `ghcr.io/crewhaus/sandbox-z3:${failing}`,
        });
        expect(first.exitCode).not.toBe(0);
        expect(published(registry)).not.toContain("ghcr.io/crewhaus/sandbox-z3:9.9.9");
        const rerun = runJob("z3", "9.9.9", { registry });
        expect(rerun.exitCode).toBe(0);
        expect(rerun.stdout).not.toContain("already published");
        expect(kinds(rerun.calls)).toEqual(["inspect", "build", "run", "push", "push"]);
        expect(new Set(published(registry))).toEqual(new Set(tags));
        // And a third run, with everything published, builds nothing.
        const again = runJob("z3", "9.9.9", { registry });
        expect(again.exitCode).toBe(0);
        expect(kinds(again.calls)).toEqual(["inspect"]);
      });
    }, 20_000);
  }

  test("a pre-release pushes its own tag only", () => {
    const r = runJob("z3", "0.0.0-rc.1");
    expect(r.exitCode).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("push "))).toEqual([
      "push ghcr.io/crewhaus/sandbox-z3:0.0.0-rc.1",
    ]);
    expect(r.calls.find((c) => c.startsWith("buildx build "))).not.toContain(":latest");
  }, 20_000);

  test("a published tag: nothing is built or pushed, and the job stays green", () => {
    const r = runJob("lean4", "9.9.9", { published: true });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual(["buildx imagetools inspect ghcr.io/crewhaus/sandbox-lean4:9.9.9"]);
    expect(r.stdout).toContain(
      "::warning::ghcr.io/crewhaus/sandbox-lean4:9.9.9 is already published; not rebuilding or overwriting it",
    );
  }, 20_000);

  test("a failed smoke run pushes nothing and fails the job", () => {
    const r = runJob("z3", "9.9.9", { z3Says: "sat" });
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("push "))).toEqual([]);
    expect(r.stdout).toContain("::error::z3 smoke printed 'sat', expected 'unsat'");
  }, 20_000);

  test("a z3 image whose solver cannot start pushes nothing and fails the job, saying so", () => {
    // `docker run` exits 127 with nothing on stdout. Left to `bash -e`, the
    // assignment ended the job with no ::error:: line.
    const r = runJob("z3", "9.9.9", { z3Says: "", z3Exit: 127 });
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("push "))).toEqual([]);
    expect(r.stdout).toContain("::error::z3 smoke exited 127: ");
  }, 20_000);

  test("a lean4 image whose bv_decide cannot run cadical pushes nothing and fails the job with lean's output", () => {
    // What the real image prints with its cadical masked (`-v empty:/usr/
    // local/bin/cadical:ro`), and lean exits 1. Left to `bash -e`, the
    // assignment ended the job before this output reached the log (W3-B
    // post-fix review).
    const cadical = `{"caption":"","data":"Failed to execute external prover:\\ncould not execute external process '/usr/local/bin/cadical'\\n","fileName":"<stdin>","severity":"error"}`;
    const r = runJob("lean4", "9.9.9", {
      leanSays: [
        cadical,
        `{"data":"'smoke' does not depend on any axioms","severity":"information"}`,
        `{"data":"'smoke_sat' depends on axioms: [sorryAx]","severity":"information"}`,
      ],
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("push "))).toEqual([]);
    expect(r.stdout).toContain("::error::lean smoke exited 1: ");
    expect(r.stdout).toContain("could not execute external process '/usr/local/bin/cadical'");
  }, 20_000);

  test("a lean4 smoke that exits 0 without the expected axioms report pushes nothing", () => {
    const r = runJob("lean4", "9.9.9", { leanSays: [LEAN_OK[0] as string] });
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("push "))).toEqual([]);
    expect(r.stdout).toContain("::error::lean smoke did not check:");
  }, 20_000);

  test("an image with no smoke case pushes nothing and fails the job", () => {
    const r = runJob("coq", "9.9.9");
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("push "))).toEqual([]);
    expect(r.stdout).toContain("::error::no smoke test for sandbox image 'coq'");
  }, 20_000);
});

describe("the sandbox images are not target shapes", () => {
  test("not in TARGET_SHAPES, and no docker-images Dockerfile for them", () => {
    for (const id of SANDBOX_IMAGE_BUILDS.map((b) => b.id)) {
      for (const name of [id, `sandbox-${id}`]) {
        expect((TARGET_SHAPES as readonly string[]).includes(name)).toBe(false);
        expect(existsSync(join(ROOT, "packages", "docker-images", "docker", name))).toBe(false);
      }
    }
  });
});

describe("scripts/build-sandbox-images.ts", () => {
  test("tags each local build with the ref the checker runs", () => {
    expect(SANDBOX_IMAGE_BUILDS.map((b) => b.ref)).toEqual([Z3_IMAGE_REF, LEAN4_IMAGE_REF]);
    expect(buildArgv(SANDBOX_IMAGE_BUILDS[0] as (typeof SANDBOX_IMAGE_BUILDS)[number])).toEqual([
      "docker",
      "buildx",
      "build",
      "--load",
      "--tag",
      Z3_IMAGE_REF,
      "--file",
      "packages/sandbox-image-z3/Dockerfile",
      "packages/sandbox-image-z3",
    ]);
    // podman's own `build` (buildah) sets TARGETARCH as BuildKit does.
    expect(
      buildArgv(SANDBOX_IMAGE_BUILDS[1] as (typeof SANDBOX_IMAGE_BUILDS)[number], "podman"),
    ).toEqual([
      "podman",
      "build",
      "--tag",
      LEAN4_IMAGE_REF,
      "--file",
      "packages/sandbox-image-lean4/Dockerfile",
      "packages/sandbox-image-lean4",
    ]);
  });

  test("selects all images, some, or refuses an unknown one", () => {
    expect(selectImages([])).toEqual({ images: [...SANDBOX_IMAGE_BUILDS], dryRun: false });
    expect(selectImages(["lean4", "--dry-run"])).toEqual({
      images: SANDBOX_IMAGE_BUILDS.filter((b) => b.id === "lean4"),
      dryRun: true,
    });
    expect(selectImages(["z3", "coq"])).toEqual({
      error: 'unknown image "coq" (known: z3, lean4)',
    });
  });

  test("builds from the repo root, even when the checkout's path has a space or non-ASCII", () => {
    expect(REPO_ROOT).toBe(ROOT);
    // A copy of the script in `sp ace/ü/scripts/` (its `../packages` imports
    // through a symlink), with `docker` stubbed on PATH to print the
    // directory it was started in. `new URL("..", import.meta.url).pathname`
    // gave `sp%20ace/%C3%BC/`, and the spawn failed with ENOENT.
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-build-sandbox-images-"));
    try {
      const checkout = join(realpathSync(dir), "sp ace", "ü");
      mkdirSync(join(checkout, "scripts"), { recursive: true });
      symlinkSync(join(ROOT, "packages"), join(checkout, "packages"));
      const script = join(checkout, "scripts", "build-sandbox-images.ts");
      writeFileSync(script, readFileSync(join(import.meta.dir, "build-sandbox-images.ts")));
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "docker"), '#!/bin/sh\necho "docker ran in $(pwd -P)"\n');
      chmodSync(join(bin, "docker"), 0o755);
      const proc = Bun.spawnSync(["bun", script, "z3"], {
        cwd: dir,
        env: { ...process.env, CREWHAUS_SANDBOX: "docker", PATH: `${bin}:${process.env["PATH"]}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.stderr.toString()).toBe("");
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toContain(`docker ran in ${checkout}\n`);
      expect(proc.stdout.toString()).toContain(`built ${Z3_IMAGE_REF}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("--dry-run prints the commands and builds nothing", () => {
    const env = { ...process.env, CREWHAUS_SANDBOX: "docker" };
    const proc = Bun.spawnSync(
      ["bun", join(import.meta.dir, "build-sandbox-images.ts"), "--dry-run"],
      {
        cwd: ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim().split("\n")).toEqual([
      `$ docker buildx build --load --tag ${Z3_IMAGE_REF} --file packages/sandbox-image-z3/Dockerfile packages/sandbox-image-z3`,
      `$ docker buildx build --load --tag ${LEAN4_IMAGE_REF} --file packages/sandbox-image-lean4/Dockerfile packages/sandbox-image-lean4`,
    ]);
    const bad = Bun.spawnSync(["bun", join(import.meta.dir, "build-sandbox-images.ts"), "nope"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain('unknown image "nope"');
  }, 20_000);
});
