# Section 32 — docker-images: channel target shape (long-running daemon).
# Section 12 daemon listens on $PORT (default 3000) for inbound webhooks.
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
RUN apk add --no-cache curl ca-certificates && \
    addgroup -S crewhaus && adduser -S crewhaus -G crewhaus -u 10001 && \
    mkdir -p /app/.crewhaus && chown crewhaus:crewhaus /app/.crewhaus
WORKDIR /app
COPY --from=build --chown=crewhaus:crewhaus /app/dist/crewhaus.js /app/crewhaus.js
COPY --from=deps --chown=crewhaus:crewhaus /app/node_modules /app/node_modules
USER crewhaus
ENV NODE_ENV=production CREWHAUS_TARGET=channel PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS http://localhost:${PORT:-3000}/healthz || exit 1
ENTRYPOINT ["bun", "/app/crewhaus.js"]
CMD ["run", "/spec/crewhaus.yaml"]
