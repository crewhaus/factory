# v0.8.0 — sandbox-image-z3 (design/0.8.0-provability-release.md §6.4, §13)
#
# The curated Z3 image behind the provability ladder's `smt` proof checker.
# The release builds it from this file and pushes
# ghcr.io/crewhaus/sandbox-z3:<version> (.github/workflows/release.yml, job
# `sandbox-images`); `@crewhaus/sandbox-image-z3` pins the tag the checker runs.
#
# Two stages:
#   fetch    — debian:13-slim with curl + unzip. Downloads the official Z3
#              release for the build's architecture, checks its sha256, and
#              keeps the one `z3` binary. Nothing from this stage ships but
#              that file and its licence.
#   runtime  — distroless cc-debian13 (glibc, libstdc++, libgcc; no shell, no
#              package manager, no network tools), non-root (uid 65532).
#
# Architecture: BuildKit sets TARGETARCH (`docker buildx build`); each
# architecture has its own release asset and its own sha256 below. The
# release job builds linux/amd64; a local build on Apple silicon is
# linux/arm64. The legacy builder leaves TARGETARCH empty and the build
# refuses rather than guessing.
#
# Why not a distro package: Debian's z3 is 4.8 and Alpine's revision pins
# vanish from the mirror when it updates; the release binary is a version and
# a hash. The asset names carry the glibc they were built against (2.38 arm64,
# 2.39 x64), so the runtime is Debian 13 (glibc 2.41), not 12 (2.36).
#
# Defaults applied by @crewhaus/sandbox at run time:
#   --network=none --memory=512m --cpus=1.0 --read-only
#   --tmpfs /tmp:rw,size=64m,mode=1777,exec --security-opt=no-new-privileges
# Z3 reads its script on stdin (`z3 -in`) and writes nothing, so a read-only
# root costs it nothing.
#
# Bumping Z3: change Z3_VERSION and both sha256s (GitHub shows each release
# asset's digest), update Z3_SOLVER_VERSION in src/index.ts (a unit test holds
# the two in step), and run the live probe in
# packages/proof-checker/src/sandbox.live.test.ts — it fails when the new
# solver resolves a built-in name the smt checker's reserved list lacks.
# Bump Z3_IMAGE_TAG when the image changes.

FROM debian:13-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad AS fetch

ARG TARGETARCH
ARG Z3_VERSION=4.16.0
ARG Z3_SHA256_AMD64=7288c49a5bd6dbafd7b0b0d1f65956b91672da24b08f09242919af159be3418e
ARG Z3_SHA256_ARM64=87fcd963d3eecb0f12cf1c3ef0ad74e84a3a7bd3caed5d94445645ef94ae6274

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) asset="z3-${Z3_VERSION}-x64-glibc-2.39"; sum="$Z3_SHA256_AMD64" ;; \
      arm64) asset="z3-${Z3_VERSION}-arm64-glibc-2.38"; sum="$Z3_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH '${TARGETARCH}' (build with BuildKit: docker buildx build)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /tmp/z3.zip \
      "https://github.com/Z3Prover/z3/releases/download/z3-${Z3_VERSION}/${asset}.zip"; \
    echo "${sum}  /tmp/z3.zip" | sha256sum -c -; \
    unzip -q /tmp/z3.zip -d /tmp/z3; \
    install -D -m 0755 "/tmp/z3/${asset}/bin/z3" /out/usr/local/bin/z3; \
    install -D -m 0644 "/tmp/z3/${asset}/LICENSE.txt" /out/usr/local/share/licenses/z3/LICENSE.txt; \
    "/out/usr/local/bin/z3" --version | grep -qF "Z3 version ${Z3_VERSION} "; \
    rm -rf /tmp/z3 /tmp/z3.zip

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:83b9b50586253821cf63ffcec87d3d94265a093ad30da232039af962dd8f4edf AS runtime

LABEL org.opencontainers.image.source="https://github.com/crewhaus/factory" \
      org.opencontainers.image.description="Z3 SMT solver for the CrewHaus provability smt checker" \
      org.opencontainers.image.licenses="MIT"

COPY --from=fetch /out/ /

# The :nonroot base already runs as uid 65532; restated so a base bump that
# drops it cannot quietly make the solver root.
USER 65532:65532
WORKDIR /tmp

# The sandbox sets the argv at exec() time (`z3 -in`, the script on stdin).
# The healthcheck is the registry's (`z3 --version`), so `crewhaus sandbox
# doctor` and the checker's availability probe ask the same question.
HEALTHCHECK --interval=30s --timeout=2s --retries=2 \
    CMD ["z3", "--version"]

CMD ["z3", "--version"]
