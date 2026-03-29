FROM node:20-alpine

WORKDIR /app

# Install optional dependencies
RUN apk add --no-cache \
    git \
    ripgrep \
    docker-cli

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY src ./src

# Build TypeScript
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Create non-root user and add to docker group
RUN addgroup -g 1001 -S nodejs && \
    adduser -S app -u 1001 && \
    addgroup app ping

# Note: Docker socket permissions handled by host system
USER app

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

ENTRYPOINT ["node", "dist/index.js"]
