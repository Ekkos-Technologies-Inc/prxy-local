# prxy-local — single-image Docker build
# Usage:
#   docker build -t prxymonster/local .
#   docker run -p 3099:3099 -v ~/.prxy:/data \
#     -e ANTHROPIC_API_KEY=sk-ant-xxx \
#     prxymonster/local

FROM node:22-alpine AS builder

# better-sqlite3 needs build tools.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ─── Runtime image ─────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Copy only what's needed to run.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Local mode is the only mode this image runs in.
ENV LOCAL_MODE=true
ENV NODE_ENV=production
ENV PORT=3099
ENV PRXY_DATA_DIR=/data

# Mount point for SQLite + blobs + evictions.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3099

# Health check — uses wget which ships in alpine.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget --quiet --tries=1 --spider http://localhost:3099/health || exit 1

CMD ["node", "dist/server.js"]
