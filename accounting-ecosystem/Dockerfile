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

FROM node:22-alpine

# OCR dependencies: tesseract (engine + English data) + poppler-utils (pdftoppm for PDF→image)
# tesseract-ocr-data-eng: ~15MB — add more langs e.g. tesseract-ocr-data-afr for Afrikaans
# Cache-bust: 2026-04-24-v3 — add hard build failure if frontend-inventory missing
ARG CACHE_BUST=2026-04-24-v3
RUN echo "cache-bust: $CACHE_BUST" && apk update && apk add --no-cache \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    poppler-utils \
  && tesseract --version 2>&1 | head -1 \
  && echo "tesseract installed OK"

WORKDIR /app

# Install backend dependencies first (separate layer — only re-runs if package.json changes)
COPY backend/package*.json backend/
RUN cd backend && npm install --production

# Copy ALL source files — .dockerignore excludes node_modules/.env/tests
# This single COPY covers backend + every current and future frontend directory
# automatically. No manual update needed when new frontend apps are added.
COPY . .

# Explicit per-folder copy — belt-and-suspenders: ensures Docker cache cannot
# silently omit frontend-inventory even if the COPY . . layer is stale/cached
# from before this folder was added. Docker re-evaluates this layer against the
# current folder content independently of the broader COPY . . layer above.
COPY frontend-inventory ./frontend-inventory

# ── BUILD VERIFICATION — fails the build if the file is missing ───────────────
# If this step fails, the COPY above did not include frontend-inventory/index.html.
# Check: (a) that frontend-inventory/ is in the git repo, (b) that it is not
# excluded by .dockerignore, (c) that Zeabur Root Directory = accounting-ecosystem.
RUN echo "=== /app contents ===" \
  && ls -la /app \
  && echo "=== /app/frontend-inventory contents ===" \
  && ls -la /app/frontend-inventory || echo "WARNING: frontend-inventory directory not found" \
  && test -f /app/frontend-inventory/index.html \
  || (echo "FATAL: /app/frontend-inventory/index.html is missing from Docker image" \
      && echo "Build context must include frontend-inventory/ at its root" \
      && exit 1)

EXPOSE 3000

CMD ["node", "backend/server.js"]
