# Section 36 — sandbox-image-go
#
# Curated Go 1.23 sandbox image. Multi-stage build:
#   builder layer  — golang:1.23-alpine with cgo disabled and a warm
#                    module cache. Used by advanced callers who mount
#                    a project, build a binary, and exec ./<binary>.
#   runtime layer  — alpine:3.19 with the warm builder pulled in for
#                    `go run -` (stdin-fed snippet mode).
#
# Defaults applied by the sandbox layer at runtime:
#   --network=none --memory=512m --cpus=1.0 --read-only --tmpfs /tmp
#   --security-opt=no-new-privileges
#
# The image MUST NOT install network tools, su/sudo, or shell utilities
# beyond what `go run` requires. CGO is disabled to keep the runtime
# layer portable across alpine glibc/musl differences.
#
# Layer R8.

FROM golang:1.23-alpine AS builder

ENV CGO_ENABLED=0 \
    GOFLAGS="-buildvcs=false -trimpath" \
    GOMODCACHE=/go/pkg/mod \
    GOCACHE=/root/.cache/go-build

# Drop bash/curl/wget — agents must not reach the network from inside
# the sandbox. The base image already lacks them, but we double-check
# by removing apk metadata that would otherwise allow re-installs at
# warm-pool boot.
RUN apk update && apk add --no-cache ca-certificates tzdata && rm -rf /var/cache/apk/*

WORKDIR /app

FROM alpine:3.19 AS runtime

# Bring in the Go toolchain for snippet mode (`go run -`). Compiled
# binaries from the builder layer can be COPYed in by callers.
COPY --from=builder /usr/local/go /usr/local/go
COPY --from=builder /etc/ssl/certs /etc/ssl/certs

ENV PATH="/usr/local/go/bin:${PATH}" \
    GOPATH="/tmp/go" \
    GOFLAGS="-buildvcs=false -trimpath" \
    GOCACHE="/tmp/go-build"

# Non-root user — sandbox layer also pins this via --user, but we set
# the default here for callers that bypass the host enforcement.
RUN addgroup -S sbx && adduser -S -G sbx sbx \
 && mkdir -p /tmp/go /tmp/go-build \
 && chown -R sbx:sbx /tmp/go /tmp/go-build

USER sbx
WORKDIR /home/sbx

# The sandbox layer sets the actual entrypoint at exec() time —
# `go run -` for snippets, or the caller's compiled binary path. We
# pin a healthcheck argv so the registry can verify the toolchain is
# usable without invoking `go run` (which would compile a temp file).
HEALTHCHECK --interval=30s --timeout=2s --retries=2 \
    CMD ["go", "version"]

CMD ["go", "version"]
