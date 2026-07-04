# syntax=docker/dockerfile:1

# ---- Stage 1: build the web client (Vite SPA) ----
FROM node:20-bookworm AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web ./apps/web
RUN npm run build

# ---- Stage 2: build the Rust gateway ----
FROM rust:1-bookworm AS server
# RocksDB is built from source by the `rocksdb` crate: bindgen needs libclang,
# and the C/C++ sources need a compiler.
RUN apt-get update && apt-get install -y --no-install-recommends \
    clang libclang-dev cmake build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY shared ./shared
# Cache mounts keep the cargo registry and compiled artifacts (incl. the
# expensive RocksDB C++ objects) across local rebuilds, so only changed crates
# recompile. target/ lives in the cache mount and is NOT part of the image, so
# copy the finished binary out to a stable path for the runtime stage.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p wilder-gateway \
    && cp target/release/wilder-gateway /usr/local/bin/wilder-gateway

# ---- Stage 3: slim runtime ----
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /usr/local/bin/wilder-gateway /app/wilder-gateway
COPY --from=web /src/apps/web/dist /app/web
COPY assets /app/assets

ENV WILDER_ASSETS=/app/assets \
    WILDER_WEB_DIST=/app/web \
    WILDER_DATA=/data/world \
    WILDER_DEV=0

# Render injects $PORT; the gateway reads WILDER_PORT, so bridge the two.
CMD ["sh", "-c", "WILDER_PORT=${PORT:-8080} exec /app/wilder-gateway"]
