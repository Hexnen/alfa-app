# syntax=docker/dockerfile:1

# ---------- Stage 0: LibreDWG (GPL) — dwg2dxf/dwgread dla importu DWG ----------
# Budowane ze źródeł GNU; do obrazu trafiają tylko binarki + archiwum źródeł
# (wymóg GPL przy dystrybucji binarek). ODA File Converter jest ZAKAZANY licencyjnie.
FROM debian:bookworm-slim AS libredwg
ARG LIBREDWG_VERSION=0.13.3
# python3-minimal: ./configure LibreDWG woła AM_PATH_PYTHON bezwarunkowo (skrypty
# testowe), także przy --disable-bindings — bez interpretera kończy się błędem
# „no suitable Python interpreter found". Zostaje w tym stage'u, do runtime nie idzie.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl ca-certificates xz-utils python3-minimal \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSL -o libredwg-${LIBREDWG_VERSION}.tar.xz \
      https://ftp.gnu.org/gnu/libredwg/libredwg-${LIBREDWG_VERSION}.tar.xz \
    && tar xf libredwg-${LIBREDWG_VERSION}.tar.xz
RUN cd libredwg-${LIBREDWG_VERSION} \
    && ./configure --disable-shared --disable-bindings --disable-docs \
    && make -j"$(nproc)" \
    && install -s programs/dwg2dxf programs/dwgread /usr/local/bin/

# ---------- Stage 1: build the Vite frontend ----------
FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: runtime (Hono API + built frontend) ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Build toolchain for better-sqlite3 native addon (falls back to source
# build when no prebuilt binary matches the platform) + python3/pip dla
# analizy DXF (ezdxf; wersja z pip — bookworm ma za starą, bez SVGBackend).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip make g++ \
    && pip3 install --break-system-packages --no-cache-dir "ezdxf>=1.3,<2" \
    && apt-get purge -y python3-pip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.cache

# LibreDWG: binarki + źródła (GPL) ze stage 0
COPY --from=libredwg /usr/local/bin/dwg2dxf /usr/local/bin/dwgread /usr/local/bin/
COPY --from=libredwg /build/libredwg-*.tar.xz /usr/local/share/libredwg-src/

# Install backend deps (devDeps included: tsx runs the TS at runtime).
COPY package.json package-lock.json ./
RUN npm ci

# Backend source + migrations + config
COPY src ./src
COPY scripts ./scripts
COPY drizzle.config.ts tsconfig.json ./

# Built frontend from stage 1
COPY --from=frontend /app/frontend/dist ./frontend/dist

# SQLite lives here; mount a persistent volume on this path in Dokploy.
RUN mkdir -p ./data

ENV NODE_ENV=production
# Kalendarz/asystent liczą „dzisiaj” lokalnie — proces ma działać w czasie warszawskim (patrz src/lib/tz.ts).
ENV TZ=Europe/Warsaw
ENV PORT=4001
ENV HOST=0.0.0.0
EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The server self-migrates and bootstraps the admin on startup (see src/index.ts).
CMD ["npm", "run", "start"]
