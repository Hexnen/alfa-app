# syntax=docker/dockerfile:1

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
# build when no prebuilt binary matches the platform).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

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
ENV PORT=4001
ENV HOST=0.0.0.0
EXPOSE 4001

# Apply pending migrations, then start the server.
CMD ["sh", "-c", "npm run db:migrate && npm run start"]
