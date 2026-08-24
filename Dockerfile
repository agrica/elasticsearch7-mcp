# syntax=docker/dockerfile:1

# Multi-stage: the build stage needs typescript and shx, the runtime image must
# not carry them. Base pinned to the major in .nvmrc rather than the floating
# `lts` tag, so the image runs the Node the project is type-checked against.
FROM node:24-alpine AS build

WORKDIR /app

# Installed by exact version rather than through corepack: the image then does
# not depend on which pnpm shim the base tag happens to bundle.
RUN npm install -g pnpm@11.22.0

# Copied on their own so the dependency layer is only invalidated by a lockfile
# change, not by every source edit.
COPY package.json pnpm-lock.yaml ./

# --frozen-lockfile makes a lockfile that disagrees with package.json an error
# instead of a silent resolution. --ignore-scripts stops the `prepare` hook from
# building here, before any source has been copied.
RUN pnpm install --frozen-lockfile --ignore-scripts

# tsconfig.json has `include: ["*.ts"]`, so index.ts plus src/ is the whole
# input. Listing them beats `COPY . .`: the image cannot silently absorb a
# stray local file.
COPY tsconfig.json ./
COPY index.ts ./
COPY src ./src

RUN pnpm run build


FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# `org.opencontainers.image.source` is what links the image to its repository
# on GHCR; without it the package page shows up orphaned.
LABEL org.opencontainers.image.source="https://github.com/agrica/elasticsearch7-mcp"
LABEL org.opencontainers.image.description="MCP server exposing an Elasticsearch 7.x cluster over stdio"
LABEL org.opencontainers.image.licenses="MIT"

RUN npm install -g pnpm@11.22.0

COPY package.json pnpm-lock.yaml ./

# --prod is pnpm's --omit=dev. The store is pruned in the same layer, so the
# downloaded tarballs never reach the published image.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts && pnpm store prune

COPY --from=build /app/dist ./dist

# Configuration defaults. ES_HOST has no usable default: left empty, the zod
# schema rejects it at startup with a legible error rather than connecting
# somewhere unintended.
ENV ES_HOST=""
ENV ES_API_KEY=""
ENV ES_USERNAME=""
ENV ES_PASSWORD=""
ENV ES_CA_CERT=""

# OAuth2 client_credentials, for a cluster behind a gateway that validates
# bearer tokens. ES_OAUTH_TOKEN_URL is what turns the factor on; a partial block
# is refused at startup rather than silently falling back to another identity.
# Prefer ES_OAUTH_CLIENT_SECRET_FILE with a mounted secret: an env var is visible
# in `docker inspect`.
ENV ES_OAUTH_TOKEN_URL=""
ENV ES_OAUTH_CLIENT_ID=""
ENV ES_OAUTH_CLIENT_SECRET=""
ENV ES_OAUTH_CLIENT_SECRET_FILE=""
ENV ES_OAUTH_SCOPE=""
ENV ES_OAUTH_AUDIENCE=""
ENV ES_OAUTH_AUTH_STYLE=""
# Shown as the server title. Worth setting when a client declares more than one
# instance, so production and staging are not two identically named servers.
ENV ES_INSTANCE_LABEL=""
# Left empty so the server's own defaults apply: 30000 ms, 3 retries, and a
# 32 KB ceiling on one tool result. Repeating the numbers here is how they drift.
ENV ES_REQUEST_TIMEOUT=""
ENV ES_MAX_RETRIES=""
ENV ES_MAX_RESULT_BYTES=""
# Both tool gates default to off: an image pulled and run with no further
# thought exposes read-and-search tools only.
ENV ES_ADMIN_TOOLS="false"
ENV ES_ALLOW_DESTRUCTIVE="false"

# The `node` user ships with the image; nothing here needs root.
USER node

# stdio transport only — no port is exposed. The MCP client owns this process's
# stdin and stdout, which is why diagnostics go to stderr.
CMD ["node", "dist/index.js"]
