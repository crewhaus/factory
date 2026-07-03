# Section 32 — docker-images: CLI target shape (interactive REPL).
# Multi-stage: deps → build → runtime. Non-root user, read-only root, HEALTHCHECK.

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: deps (cached layer for node_modules)
# ──────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY bun.lock package.json ./
COPY packages packages
COPY apps apps
RUN bun install --frozen-lockfile

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: build (typecheck + bundle the CLI entrypoint)
# ──────────────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
RUN bun run typecheck
RUN bun build apps/cli/src/index.ts --target=bun --outfile=/app/dist/crewhaus.js

# ──────────────────────────────────────────────────────────────────────────────
# Stage 3: runtime (minimal — only what the CLI needs at boot)
# ──────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.2-alpine AS runtime
RUN addgroup -S crewhaus && adduser -S crewhaus -G crewhaus -u 10001
WORKDIR /app
COPY --from=build --chown=crewhaus:crewhaus /app/dist/crewhaus.js /app/crewhaus.js
COPY --from=deps --chown=crewhaus:crewhaus /app/node_modules /app/node_modules
USER crewhaus
ENV NODE_ENV=production CREWHAUS_TARGET=cli
EXPOSE 0
HEALTHCHECK --interval=30s --timeout=5s --start-period=2s --retries=3 \
  CMD bun /app/crewhaus.js doctor --liveness || exit 1
ENTRYPOINT ["bun", "/app/crewhaus.js"]
CMD ["--help"]
