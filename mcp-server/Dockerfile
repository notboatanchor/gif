# /gif/mcp-server/Dockerfile
# MCP server — Node.js 26 / TypeScript (ADR-019; 20 → 22 → 26 as each line approached EOL — Node 22 security support ends 2027-04-30)
# Self-contained image: source is copied in and compiled at build time, and the
# repository's docker-compose.yml mounts nothing over /app. What runs is what
# was built — rebuild the image to pick up a source change.

FROM node:26-alpine

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

# Run as non-root user — the node:26-alpine image ships with a `node` user.
# Prevents container-escape escalation if the MCP server process is compromised.
USER node

# Expose MCP server port (ADR-019)
EXPOSE 3100

# Start compiled server
CMD ["node", "dist/index.js"]
