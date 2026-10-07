# Multi-stage build for the media-agent sidecar.
# Debian (not Alpine): better-sqlite3 ^13 ships glibc-linked prebuilds for
# linux x64/arm64, so on Debian the native module installs from the prebuild
# with no compile; musl (Alpine) would always rebuild from source.

# ── Stage 1: builder ──
# build-essential + python3 are a FALLBACK only: node-gyp needs them if the
# running Node version has no matching prebuild. With prebuilds they sit idle.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

# tsx is a production dependency (the runtime executes TS directly — tsconfig
# is noEmit, there is no build step), so `npm ci --omit=dev` yields exactly
# the runtime dependency set, with better-sqlite3's native binary compiled/
# downloaded in the same image layer as the rest of the tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The isolated Vite package builds the static UI served by Fastify.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web/index.html web/postcss.config.js web/tailwind.config.js web/vite.config.ts web/tsconfig.json ./web/
COPY web/src ./web/src
COPY src/types ./src/types
RUN npm --prefix web run build

COPY src ./src

# ── Stage 2: runtime ──
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Same Debian base as the builder, so the compiled better-sqlite3 binary is
# binary-compatible — no toolchain needed here.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/web/dist ./web/dist
COPY LICENSE ./LICENSE

# DB_PATH defaults to data/media-agent.db (relative to /app); compose
# bind-mounts ./data here, so pre-create it and give it to the node user.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 7877
# HTTP_PORT is runtime config; HEALTHCHECK cannot interpolate it, so the
# one-liner reads it via process.env with the same default as src/config.ts.
# bookworm-slim ships neither wget nor curl — node's own fetch needs nothing extra.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||7877)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Exec form: node is PID 1 and receives SIGTERM directly, so the daemon's
# graceful-shutdown signal handler in src/daemon.ts runs before exit.
# Invoked via tsx's CLI entry (tsx is a prod dep) since the repo has no build step.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/daemon.ts"]
