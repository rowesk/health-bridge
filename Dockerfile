# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS build
WORKDIR /app
# Build tools for better-sqlite3 native module (used if no prebuilt binary matches)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Recompile/install only production deps (better-sqlite3 native binary lives here)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# SQLite DB + OAuth tokens live here — mount a Dokploy volume to /data
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "dist/server.js"]
