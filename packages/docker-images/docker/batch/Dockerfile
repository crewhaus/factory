# Section 32 — docker-images: batch target shape (queue worker daemon).
# Section 23 BATCH worker pulls from queue-protocol, runs one runChatLoop per job.
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY bun.lock package.json ./
COPY packages packages
COPY apps apps
RUN bun install --frozen-lockfile --production=false

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
RUN bun run typecheck
RUN bun build apps/cli/src/index.ts --target=bun --outfile=/app/dist/crewhaus.js

FROM oven/bun:1.2-alpine AS runtime
RUN addgroup -S crewhaus && adduser -S crewhaus -G crewhaus -u 10001 && \
    mkdir -p /app/.crewhaus && chown crewhaus:crewhaus /app/.crewhaus
WORKDIR /app
COPY --from=build --chown=crewhaus:crewhaus /app/dist/crewhaus.js /app/crewhaus.js
COPY --from=deps --chown=crewhaus:crewhaus /app/node_modules /app/node_modules
USER crewhaus
ENV NODE_ENV=production CREWHAUS_TARGET=batch
EXPOSE 0
# Batch worker is a long-running consumer; healthcheck just verifies the process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD pgrep -f crewhaus.js > /dev/null || exit 1
ENTRYPOINT ["bun", "/app/crewhaus.js"]
CMD ["run", "/spec/crewhaus.yaml"]
