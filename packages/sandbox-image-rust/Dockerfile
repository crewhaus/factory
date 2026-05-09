# Section 36 — sandbox-image-rust
#
# Curated Rust stable sandbox image. Multi-stage build:
#   builder layer  — rust:1-alpine + cargo cache. Used by advanced
#                    callers who mount a project, build a binary, and
#                    exec ./<binary>.
#   runtime layer  — alpine:3.19 with the rust toolchain available
#                    for cargo-script style snippet runs.
#
# Defaults applied by the sandbox layer at runtime:
#   --network=none --memory=512m --cpus=1.0 --read-only --tmpfs /tmp
#   --security-opt=no-new-privileges
#
# RUSTFLAGS strip symbols to keep the runtime layer compact (Rust
# binaries are routinely 10-30 MB without strip).
#
# Layer R8.

FROM rust:1-alpine AS builder

ENV CARGO_TERM_COLOR=never \
    CARGO_HOME=/usr/local/cargo \
    RUSTFLAGS="-C strip=symbols" \
    RUSTUP_HOME=/usr/local/rustup

# musl-dev for static linking; ca-certificates for HTTPS even though
# the sandbox runs with --network=none in production. apk metadata is
# cleared so re-installs at warm-pool boot are blocked.
RUN apk update \
 && apk add --no-cache musl-dev ca-certificates tzdata \
 && rm -rf /var/cache/apk/*

WORKDIR /app

FROM alpine:3.19 AS runtime

# Bring in the Rust toolchain for snippet mode. Compiled binaries
# from the builder layer can be COPYed in by callers.
COPY --from=builder /usr/local/cargo /usr/local/cargo
COPY --from=builder /usr/local/rustup /usr/local/rustup
COPY --from=builder /etc/ssl/certs /etc/ssl/certs

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    RUSTFLAGS="-C strip=symbols" \
    PATH="/usr/local/cargo/bin:${PATH}"

# musl-libc + libgcc are required for the Rust runtime.
RUN apk update \
 && apk add --no-cache libgcc \
 && rm -rf /var/cache/apk/* \
 && addgroup -S sbx && adduser -S -G sbx sbx \
 && mkdir -p /tmp/cargo /tmp/cargo-target \
 && chown -R sbx:sbx /tmp/cargo /tmp/cargo-target

USER sbx
WORKDIR /home/sbx

ENV CARGO_TARGET_DIR=/tmp/cargo-target

HEALTHCHECK --interval=30s --timeout=2s --retries=2 \
    CMD ["rustc", "--version"]

CMD ["rustc", "--version"]
