# /gif/mcp-server/Dockerfile
# MCP server — Node.js 22 / TypeScript (ADR-019, upgraded from 20 — Node 20 EOL Apr 2026)
# Self-contained image: source is copied in and compiled at build time, and the
# repository's docker-compose.yml mounts nothing over /app. What runs is what
# was built — rebuild the image to pick up a source change.

FROM node:22-alpine

# Set working directory inside container
WORKDIR /app

# Install dependencies first — separate layer so Docker cache is preserved
# when only source files change (not package.json)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source. .dockerignore is an allowlist (manifests, tsconfig.json, src/),
# so host node_modules/, dist/ and stray local files never enter the image.
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# Run as non-root user — the node:22-alpine image ships with a `node` user.
# Prevents container-escape escalation if the MCP server process is compromised.
USER node

# Expose MCP server port (ADR-019)
EXPOSE 3100

# Start compiled server
CMD ["node", "dist/index.js"]
