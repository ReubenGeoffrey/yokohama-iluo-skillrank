# Multi-stage production Dockerfile for Yokohama ILUO Portal on Google Cloud Run
# 1 vCPU (1000m) / 1Gi-2Gi RAM profile

# --- Stage 1: Build & Bundle ---
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Compile and validate production frontend assets into dist/
RUN node build.js

# --- Stage 2: Production Container ---
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV UV_THREADPOOL_SIZE=2

# Install runtime dependencies required for headless Chromium / Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy built application and production dependencies from builder
COPY --from=builder /app /app

EXPOSE 8080

# Launch server
CMD ["node", "server.js"]
