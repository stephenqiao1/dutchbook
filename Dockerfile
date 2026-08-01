# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# deps — production node_modules only
#
# Built in its own stage so the final image never sees a dev dependency. The
# lockfile is copied alone first, so a source-only change reuses this layer.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ---------------------------------------------------------------------------
# build — full dependency tree, compiled to dist/
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini reaps zombies and forwards signals. Without it Node runs as PID 1, where
# the default SIGTERM handler does not apply — and the graceful shutdown this
# service depends on to finish an in-flight ingest would never run.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# `node` (uid 1000) ships with the image. Nothing here needs to write to the
# filesystem, so the application files stay owned by root and read-only to it.
COPY --from=deps  --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
# Read at runtime by the release command, which applies pending migrations.
COPY --chown=root:root drizzle ./drizzle
COPY --chown=root:root drizzle.config.ts ./

USER node

EXPOSE 3000

# No shell in between: signals reach Node directly.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
