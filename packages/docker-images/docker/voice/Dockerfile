# Section 32 — docker-images: voice target shape (realtime telephony agent).
# Adds libopus (PCM ↔ Opus codec for telephony codecs) on top of the base.
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY bun.lock package.json ./
COPY packages packages
COPY apps apps
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
RUN bun run typecheck
RUN bun build apps/cli/src/index.ts --target=bun --outfile=/app/dist/crewhaus.js

FROM oven/bun:1.2-alpine AS runtime
RUN apk add --no-cache curl ca-certificates libopus opus-tools && \
    addgroup -S crewhaus && adduser -S crewhaus -G crewhaus -u 10001 && \
    mkdir -p /app/.crewhaus && chown crewhaus:crewhaus /app/.crewhaus
WORKDIR /app
COPY --from=build --chown=crewhaus:crewhaus /app/dist/crewhaus.js /app/crewhaus.js
COPY --from=deps --chown=crewhaus:crewhaus /app/node_modules /app/node_modules
USER crewhaus
ENV NODE_ENV=production CREWHAUS_TARGET=voice PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:${PORT:-8080}/healthz || exit 1
ENTRYPOINT ["bun", "/app/crewhaus.js"]
CMD ["run", "/spec/crewhaus.yaml"]
