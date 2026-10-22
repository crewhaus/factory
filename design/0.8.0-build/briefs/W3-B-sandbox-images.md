# W3-B — the Z3 and Lean 4 sandbox images, end to end (design §6.4, §13, §14 PR 8)

You own: `packages/sandbox-image-z3/**`, `packages/sandbox-image-lean4/**`,
`packages/proof-checker/**` (adapter fixes only), `.github/workflows/release.yml` (one NEW job
only — never rename the file: npm trusted publishing is bound to its filename), and a new
`scripts/` helper if you need one.

A Docker daemon is RUNNING on this machine (`docker info` works; it was started with
`dockerd --iptables=false`). Image pulls go through an HTTPS proxy and work. Processes INSIDE
`docker build` cannot reach the proxy by default — read `/root/.ccr/README.md` § "docker build /
docker run": use `--network host`, pass `--build-arg HTTPS_PROXY=$HTTPS_PROXY` (and lowercase),
and for TLS inside the build, copy `/root/.ccr/ca-bundle.crt` into a TEMPORARY build context
(never into the repo) and trust it in an early layer — but the committed Dockerfiles must build
cleanly on a GitHub runner with NO proxy and NO extra CA, so make the CA step optional (a build
ARG / secret mount that is absent in CI). Never commit the CA or proxy settings.

1. **Dockerfiles** — `packages/sandbox-image-z3/Dockerfile` and
   `packages/sandbox-image-lean4/Dockerfile`, in the style of `packages/sandbox-image-go/Dockerfile`
   (read its header: no network tools, no shells beyond need, non-root, read-only-root-friendly,
   `/tmp` scratch). Z3: a pinned Z3 release (e.g. Alpine/Debian package pinned by version, or
   the official GitHub release binary pinned by version + sha256) exposing `z3` on PATH; Lean 4:
   a pinned toolchain (elan with a pinned `leanprover/lean4:v4.x.y`, or the release tarball
   pinned + sha256) exposing `lean` on PATH, Mathlib-free. Keep images as small as is honest.
2. **Build and run them here**, and run the REAL checkers against them: write an integration
   test in proof-checker gated on an env var (follow the `CREWHAUS_SECTION36_LIVE_DOCKER=1`
   precedent in sandbox-image-go) that, with a real `@crewhaus/sandbox` docker backend, proves
   (a) an SMT goal (unsat on the negation) and rejects a false one with a counterexample, and
   rejects inconsistent hypotheses; (b) a Lean theorem (`2 + 2 = 4` by `rfl`/`decide`, and a
   small `∀ n : Nat, n + 0 = n` by `simp`), refuses `sorry`, records extra axioms when
   `Classical.choice` is used. Run it locally and paste the output in your report. Fix the
   adapters (argv, stdin, output parsing, `#print axioms` parsing, read-only root, /tmp) until
   it is green against the real images.
3. **Image refs**: the registration packages pin `ghcr.io/crewhaus/sandbox-z3:<tag>` /
   `ghcr.io/crewhaus/sandbox-lean4:<tag>` (wave 1 set a constant tag — keep it "0.8.0").
   Make sure these refs are on the sandbox allowlist the proof checkers use
   (`listAllowedImageRefs()` from sandbox-image-registry, or the sandbox `allowedImages` option)
   and that `formal.image` overrides work.
4. **Release job**: add a `sandbox-images` job to `.github/workflows/release.yml` (needs:
   build; `permissions: contents: read, packages: write`; matrix over `z3`, `lean4`) that builds
   `packages/sandbox-image-<id>/Dockerfile` and pushes `ghcr.io/crewhaus/sandbox-<id>:$VERSION`
   (+ `:latest` only for stable X.Y.Z, exactly like the `docker` job). Mirror the existing
   docker job's pinned action SHAs, env-var-only interpolation (the workflow-injection rule in
   the file header) and login step. Do NOT add these to `packages/docker-images` TARGET_SHAPES or
   the target matrix — they are not target shapes, and `record-image-digests` would reject them.
   Update the file's header comment listing channels. If the repo has a workflow lint/test
   (grep scripts/ and apps/cli for `release.yml`), keep it green.

Verify: `bunx tsc -b` + `bun test` in the three packages (unit tests must NOT need Docker —
only the gated integration test does); the gated integration test locally with Docker; biome;
`actionlint` if available (otherwise a careful YAML read + `bun -e` YAML parse).
