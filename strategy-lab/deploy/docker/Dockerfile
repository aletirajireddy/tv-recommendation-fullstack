# strategy-lab archiver/backtest image.
# Build context = the strategy-lab folder root:
#   docker build -f deploy/docker/Dockerfile -t strategy-lab .
#
# better-sqlite3 is native, so we need build tools at install time.

FROM node:20-bookworm-slim AS base
WORKDIR /app

# Build deps for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching
COPY package.json ./
RUN npm install --omit=dev

# App source
COPY . .

# Data dir for the archive db (mount a volume here to persist)
RUN mkdir -p /app/data
ENV ARCHIVE_DB_PATH=/app/data/analytics_archive.db

# Default: continuous archive loop. Override with `--once` for one-shot.
CMD ["npm", "run", "archive:loop"]
