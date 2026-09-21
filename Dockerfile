# syntax=docker/dockerfile:1.6
#
# OpsFlow / TaskOs — production-ish container.
#
# Two-stage build:
#   1. `builder` — install all deps, generate Prisma client (linux-musl
#      target, see schema.prisma generator block), and build Next.
#   2. `runner`  — minimal Alpine + node_modules + build output. Runs as
#      a non-root user.
#
# Node 20 LTS on Debian bullseye (glibc 2.31). Prisma 4.16's query
# engine binary heap-corrupts on glibc 2.36 (bookworm) — both library
# and binary engines trip "malloc(): unaligned tcache chunk detected"
# / "malloc_consolidate(): invalid chunk size" within a few queries.
# Prisma 4.16 was released against bullseye-era glibc and runs cleanly
# there. jemalloc LD_PRELOAD didn't help because the Rust engine has
# its own statically-linked allocator.
ARG NODE_VERSION=20-bullseye-slim

# ── Build stage ───────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

# Debian system packages:
#   openssl + ca-certificates — Prisma's binary engine SSL deps
# No C toolchain: the dependency tree has zero native/node-gyp modules
# (verified against package-lock.json) and Prisma ships prebuilt engines, so
# python3/make/g++ were unused. Dropping them also avoids needing libc6-dev,
# which is unresolvable right now (see below).
#
# Debian bullseye LTS went EOL 2026-08-31. deb.debian.org dropped its package
# files (404s) with the Release flagged expired, and archive.debian.org does
# not yet carry the bullseye-security suite (its Release 404s too). So we
# repoint apt at archive.debian.org and drop BOTH the -security and -updates
# suites, installing the base 'main' packages we need. That's safe here because
# we no longer install any -dev package (whose exact '=' glibc pin would clash
# with the security-patched libc6 already in the base image); the runtime
# packages we do install use '>=' deps that the installed glibc satisfies.
# Check-Valid-Until=false skips the freshness assertion. Staying on bullseye
# (glibc 2.31 / OpenSSL 1.1) keeps Prisma 4.16's engine happy. Revisit when we
# move to bookworm, or once bullseye-security lands on the archive.
RUN sed -i -e '/bullseye-updates/d' -e '/bullseye-security/d' /etc/apt/sources.list && \
    sed -i 's|http://deb.debian.org/debian|http://archive.debian.org/debian|g' /etc/apt/sources.list && \
    apt-get -o Acquire::Check-Valid-Until=false update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install deps — copy lockfile-first for cache stability
COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps --no-audit --no-fund

# Copy source. Build artifacts and node_modules are excluded by .dockerignore.
COPY . .

# Generate Prisma client (uses linux-musl binary target from schema.prisma)
RUN node node_modules/prisma/build/index.js generate

# Build Next.js. distDir=build (set in next.config.ts) so the output
# lives under build/ not .next/.
ENV NEXT_TELEMETRY_DISABLED=1
RUN node node_modules/next/dist/bin/next build

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

# Runtime needs:
#   openssl + ca-certificates — Prisma engine SSL
#   postgresql-client         — pg_isready in entrypoint
#   tini                      — proper PID-1 signal handling
# Same bullseye-EOL archive repoint as the builder stage (see note above).
# These are all runtime packages ('>=' glibc deps), so they resolve against the
# base image's installed libc6 without the -security suite.
RUN sed -i -e '/bullseye-updates/d' -e '/bullseye-security/d' /etc/apt/sources.list && \
    sed -i 's|http://deb.debian.org/debian|http://archive.debian.org/debian|g' /etc/apt/sources.list && \
    apt-get -o Acquire::Check-Valid-Until=false update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates postgresql-client tini && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r app && useradd -r -g app app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    TZ=Asia/Kolkata

# Copy what the runtime actually needs:
#   - package.json so node resolves modules
#   - node_modules with prisma + tsx + next
#   - prisma/schema.prisma (db push reads it at startup)
#   - docker/ (entrypoint + admin seed)
#   - build/ (Next compiled output)
#   - public/ (static assets)
#   - next.config.ts (used by `next start` to find build/)
#   - src/lib/auth/password (imported by seed if you swap it later)
COPY --from=builder --chown=app:app /app/package.json ./
COPY --from=builder --chown=app:app /app/package-lock.json* ./
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/docker ./docker
COPY --from=builder --chown=app:app /app/build ./build
COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=app:app /app/tsconfig.json ./tsconfig.json
# tsx needs the source for seed-admin.ts; pull only what's referenced
COPY --from=builder --chown=app:app /app/src/lib ./src/lib
COPY --from=builder --chown=app:app /app/src/types ./src/types

USER app

EXPOSE 3000

# tini reaps zombies + forwards SIGTERM to Next so docker stop is clean.
# (Debian's tini ships at /usr/bin/tini, not /sbin/tini like Alpine.)
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
