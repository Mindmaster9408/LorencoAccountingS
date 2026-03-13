# ============================================================================
# Lorenco Ecosystem — Zeabur Production Dockerfile
# ============================================================================
#
# CRITICAL DEPLOYMENT RULES — DO NOT VIOLATE:
#
#   1. DO NOT create zbpack.json in accounting-ecosystem/
#      When zbpack.json exists, Zeabur ignores this Dockerfile entirely and
#      auto-generates a broken one. The generated Dockerfile uses wrong COPY
#      paths (accounting-ecosystem/backend/ in a context that IS accounting-ecosystem/)
#      causing all builds to fail. zbpack.json = build failure. No exceptions.
#
#   2. DO NOT change WORKDIR to anything other than /app
#      server.js uses path.join(__dirname, '..', 'frontend-*') to serve
#      frontend files. Changing WORKDIR breaks all frontend serving.
#
#   3. DO NOT use COPY . . without .dockerignore
#      Without .dockerignore, node_modules gets sent in the build context,
#      bloating the context and potentially corrupting installed deps.
#
#   4. Zeabur Root Directory MUST be set to: accounting-ecosystem
#      (not accounting-ecosystem/backend — that triggers wrong path generation)
#
# ============================================================================

FROM node:18-alpine

WORKDIR /app

# Install backend dependencies first (separate layer — only re-runs if package.json changes)
COPY backend/package*.json backend/
RUN cd backend && npm install --production

# Copy ALL source files — .dockerignore excludes node_modules/.env/tests
# This single COPY covers backend + every current and future frontend directory
# automatically. No manual update needed when new frontend apps are added.
COPY . .

EXPOSE 3000

CMD ["node", "backend/server.js"]
