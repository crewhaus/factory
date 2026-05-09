# Section 32 — docker-images: browser target shape (computer-use agent).
# Adds chromium + Playwright runtime so the BROW driver can spawn real browsers.
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
# chromium + the libs Playwright's bundled chromium needs at runtime
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      dbus \
      curl && \
    addgroup -S crewhaus && adduser -S crewhaus -G crewhaus -u 10001 && \
    mkdir -p /app/.crewhaus && chown crewhaus:crewhaus /app/.crewhaus
WORKDIR /app
COPY --from=build --chown=crewhaus:crewhaus /app/dist/crewhaus.js /app/crewhaus.js
COPY --from=deps --chown=crewhaus:crewhaus /app/node_modules /app/node_modules
USER crewhaus
ENV NODE_ENV=production CREWHAUS_TARGET=browser \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:${PORT:-8080}/healthz || exit 1
ENTRYPOINT ["bun", "/app/crewhaus.js"]
CMD ["run", "/spec/crewhaus.yaml"]
