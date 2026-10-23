# v0.8.0 — sandbox-image-lean4 (design/0.8.0-provability-release.md §6.4, §13, §17.4)
#
# The curated Lean 4 image behind the provability ladder's `lean4` proof
# checker. Mathlib-free. The release builds it from this file and pushes
# ghcr.io/crewhaus/sandbox-lean4:<version> (.github/workflows/release.yml, job
# `sandbox-images`); `@crewhaus/sandbox-image-lean4` pins the tag the checker
# runs.
#
# Two stages:
#   fetch    — debian:13-slim with curl + zstd. Downloads the official Lean
#              release for the build's architecture, checks its sha256, and
#              extracts only what `lean --stdin --json` needs to elaborate a
#              file that imports Init and Std (below), then elaborates one
#              such file with the pruned tree — `bv_decide` included, so the
#              SAT solver it runs is exercised too — so a toolchain bump that
#              needs another file fails the build, not the first proof.
#   runtime  — distroless cc-debian13 (glibc; no shell, no package manager, no
#              network tools), non-root (uid 65532).
#
# What ships, and why only that: the lean4 checker's pre-scan accepts imports
# of Init and Std alone (Mathlib only on an overridden image), so the image
# carries `bin/lean`, the shared libraries it links, the Init and Std
# module files — each module's .olean, .olean.private, .olean.server (a file
# that is not itself a `module` loads all three) and .ir — and `bin/cadical`,
# the SAT solver Std's `bv_decide` runs from beside `lean`, with the four
# runtime libraries it links from lib/ (libc++, libc++abi, libunwind,
# libatomic; about 3 MB in all). Without it `bv_decide` fails on any goal its
# preprocessing cannot close. Its proofs trust the compiler (Lean 4.34
# records a `<decl>._native.bv_decide.…` axiom), so the checker refuses them
# unless the harness drops native_decide from `formal.forbid`. Left out: the
# bundled clang/lld and static libraries (for compiling Lean programs, which
# the checker never does), lake, the Lean and Lake modules (an `import Lean`
# is refused before Lean runs), .ilean editor indexes and sources. That is
# about 0.9 GB of a 3 GB toolchain.
#
# Architecture: BuildKit sets TARGETARCH (`docker buildx build`); each
# architecture has its own release asset and its own sha256 below. The
# release job builds linux/amd64; a local build on Apple silicon is
# linux/arm64. The legacy builder leaves TARGETARCH empty and the build
# refuses rather than guessing.
#
# Why not elan: elan resolves a toolchain over the network at first use, and
# ships its proxy binaries and a writable ~/.elan; the release tarball is a
# version and a hash, installed once into a read-only root.
#
# Defaults applied by @crewhaus/sandbox at run time:
#   --network=none --memory=512m --cpus=1.0 --read-only
#   --tmpfs /tmp:rw,size=64m,mode=1777,exec --security-opt=no-new-privileges
# `lean --stdin` reads the file from stdin and writes no .olean, so a
# read-only root costs it nothing; the modules are memory-mapped from the
# image.
#
# Bumping Lean: change LEAN_VERSION and both sha256s (GitHub shows each
# release asset's digest), update LEAN4_TOOLCHAIN_VERSION in src/index.ts (a
# unit test holds the two in step), and run the live checker test in
# packages/proof-checker/src/sandbox.live.test.ts. Bump LEAN4_IMAGE_TAG when
# the image changes.

FROM debian:13-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad AS fetch

ARG TARGETARCH
ARG LEAN_VERSION=4.34.1
ARG LEAN_SHA256_AMD64=47bf4bbd78f70c2e9670598ab7124d92b6efb7330ff33e5fbb4030f6fd72e4e4
ARG LEAN_SHA256_ARM64=fdb974c2cdb4627e090d5d4007b913e09d13c4868720fb5594e22808b3de9e37

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl zstd \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) asset="lean-${LEAN_VERSION}-linux"; sum="$LEAN_SHA256_AMD64" ;; \
      arm64) asset="lean-${LEAN_VERSION}-linux_aarch64"; sum="$LEAN_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH '${TARGETARCH}' (build with BuildKit: docker buildx build)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /tmp/lean.tar.zst \
      "https://github.com/leanprover/lean4/releases/download/v${LEAN_VERSION}/${asset}.tar.zst"; \
    echo "${sum}  /tmp/lean.tar.zst" | sha256sum -c -; \
    mkdir -p /out/usr/local; \
    tar --zstd -xf /tmp/lean.tar.zst -C /out/usr/local --strip-components=1 \
      --wildcards --exclude='*.ilean' \
      "${asset}/bin/lean" \
      "${asset}/bin/cadical" \
      "${asset}/lib/libc++.so.1*" "${asset}/lib/libc++abi.so.1*" \
      "${asset}/lib/libunwind.so.1*" "${asset}/lib/libatomic.so.1*" \
      "${asset}/lib/lean/libInit_shared.so" \
      "${asset}/lib/lean/libleanshared*.so" \
      "${asset}/lib/lean/Init.*" "${asset}/lib/lean/Init/*" \
      "${asset}/lib/lean/Std.*" "${asset}/lib/lean/Std/*" \
      "${asset}/LICENSE" "${asset}/LICENSES"; \
    rm /tmp/lean.tar.zst; \
    mkdir -p /out/usr/local/share/licenses/lean4; \
    mv /out/usr/local/LICENSE /out/usr/local/LICENSES /out/usr/local/share/licenses/lean4/; \
    /out/usr/local/bin/lean --version | grep -qF "version ${LEAN_VERSION},"; \
    printf '%s\n' \
      'import Std' \
      'theorem smoke : (∀ n : Nat, n + 0 = n) ∧ 2 + 2 = 4 := ⟨by intro n; simp, by decide⟩' \
      'theorem smoke_sat : ∀ x y : BitVec 8, x * y = y * x := by intro x y; bv_decide' \
      '#print axioms smoke' \
      '#print axioms smoke_sat' \
      | /out/usr/local/bin/lean --stdin --json > /tmp/smoke.json \
      || { cat /tmp/smoke.json >&2; exit 1; }; \
    if grep -qF '"severity":"error"' /tmp/smoke.json; then cat /tmp/smoke.json >&2; exit 1; fi; \
    grep -qF "'smoke' depends on axioms" /tmp/smoke.json; \
    grep -qF "'smoke_sat' depends on axioms" /tmp/smoke.json; \
    rm /tmp/smoke.json

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:83b9b50586253821cf63ffcec87d3d94265a093ad30da232039af962dd8f4edf AS runtime

LABEL org.opencontainers.image.source="https://github.com/crewhaus/factory" \
      org.opencontainers.image.description="Lean 4 (Mathlib-free) for the CrewHaus provability lean4 checker" \
      org.opencontainers.image.licenses="Apache-2.0"

# lean finds its modules relative to its own path (bin/../lib/lean), so the
# toolchain keeps its layout under /usr/local, and `lean` is on the base PATH.
COPY --from=fetch /out/ /

# The :nonroot base already runs as uid 65532; restated so a base bump that
# drops it cannot quietly make the checker root.
USER 65532:65532
WORKDIR /tmp

# The sandbox sets the argv at exec() time (`lean --stdin --json`, the file
# on stdin). The healthcheck is the registry's (`lean --version`), so
# `crewhaus sandbox doctor` and the checker's availability probe ask the same
# question.
HEALTHCHECK --interval=30s --timeout=4s --retries=2 \
    CMD ["lean", "--version"]

CMD ["lean", "--version"]
