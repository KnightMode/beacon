# Indexer service container.
# IMPORTANT: build with the repo root as the build context so the workspace
# packages (packages/shared) are available:
#
#   docker build -f services/indexer/Dockerfile -t scintel-indexer .
#   docker run --rm -p 8787:8787 --env-file services/indexer/.env scintel-indexer
#
FROM node:22-slim

WORKDIR /app

# Workspace manifests first (better layer caching).
COPY package.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY services/indexer/package.json ./services/indexer/package.json

# Install all workspace dependencies (web-tree-sitter ships prebuilt wasm,
# tree-sitter-wasms ships the grammar wasm files — no native build needed).
RUN npm install

# Source.
COPY packages/shared ./packages/shared
COPY services/indexer ./services/indexer

ENV PORT=8787
EXPOSE 8787

CMD ["npm", "run", "start", "--workspace", "services/indexer"]
