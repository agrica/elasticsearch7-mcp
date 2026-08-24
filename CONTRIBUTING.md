# Contributing

Development setup and the checks that must pass. User-facing documentation lives
in [README.md](README.md).

## pnpm is the package manager

The `packageManager` field pins the exact version, CI installs with
`--frozen-lockfile`, and `pnpm-lock.yaml` is the only lockfile in the repository.
Installing with npm or yarn produces a tree nothing was tested against, and
writes a second lockfile that the Docker build then ignores.

```bash
nvm use               # Node 24 (.nvmrc), the major the project is type-checked against
pnpm install          # the `prepare` hook builds as part of this
pnpm run build        # tsc + chmod +x dist/*.js
pnpm test             # vitest, single run
pnpm run test:watch   # vitest in watch mode
pnpm run typecheck    # tsc --strict over src, test and the root entry points
pnpm run watch        # tsc --watch
```

Without pnpm installed: `npm install -g pnpm@11.22.0`, or `corepack enable pnpm`
to let the `packageManager` field pick the version.

## Point a client at your local build

The recipes in the README run the published package through `npx`. To run what
you just built, replace the command with `node` and the absolute path to
`dist/index.js`:

```bash
claude mcp add es7-dev \
  --env ES_HOST=http://localhost:9200 \
  --env ES_ADMIN_TOOLS=true \
  --env ES_ALLOW_DESTRUCTIVE=true \
  -- node /absolute/path/to/elasticsearch7-mcp/dist/index.js
```

A dev deployment is the place to turn both gates on — that is what
`ES_ALLOW_DESTRUCTIVE` exists for. Rebuild after each change: the client spawns
the process fresh, but it runs `dist/`, not `src/`.

## Inspect the protocol without a client

```bash
ES_HOST=http://localhost:9200 ES_API_KEY=your-key pnpm run inspector
```

The MCP Inspector serves a UI where every tool can be called by hand:

```
Starting MCP inspector...
⚙️ Proxy server listening on port 6277
🔍 MCP Inspector is up and running at http://127.0.0.1:6274 🚀
```

Cheaper, with no UI — pipe a handshake in and read what comes back. This is what
CI runs against the Docker image:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dev","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | ES_HOST=http://localhost:9200 node dist/index.js > response.jsonl

node scripts/check-mcp-tools.mjs response.jsonl
# OK: 15 tools exposed — bulk, cluster_info, count, ...
```

That script asserts the default tool set exactly, in both directions, so it also
catches a diagnostic or destructive tool leaking into a default deployment.

## Measure what a tool call costs the caller

```bash
pnpm run build
pnpm run measure
```

Reports the bytes one tool result puts into the caller's context, against
fixtures shaped like a year of daily indices — 365 indices, 2190 shards, 500 log
hits — plus the `tools/list` payload for each configuration. This is the harness
behind the figures in `docs/architecture-review-2026-08-24.md`, committed so the
next review re-runs it instead of rebuilding it.

It found a real defect on its first run: the verbose dump was emitted as one
fragment, so the byte budget dropped it whole and `verbose` returned 145 bytes
where a caller had asked for detail. If you change how a tool formats a
collection, run this before trusting the tests.

## Tests

```bash
pnpm test
pnpm run typecheck
```

The suite mocks Elasticsearch at the client's *connection* layer via
[`@elastic/elasticsearch-mock`](https://github.com/elastic/elasticsearch-js-mock),
pinned to **1.x** — 2.x extends `BaseConnection`, which only the 8.x client
exports. Mocking there rather than faking the client object means a test fails
when a tool sends the wrong request shape (query DSL not nested under `body`),
not only when it formats a response wrongly.

`vitest` transpiles TypeScript without type-checking it, so `pnpm run typecheck`
is a separate, required step. Both run in CI.

## Smoke test against a real cluster

The unit suite mocks Elasticsearch, so it cannot prove the tools work against a
real server. This is the only check that does — it calls the same tool functions
the MCP server exposes, imported from the built output:

```bash
pnpm run build
ES_HOST=http://your-cluster:9200 ES_API_KEY=your-key pnpm run smoke
```

Read-only by default, diagnostics included — they only read, so this is safe
against production. To also exercise the write and destructive tools, pass an
index prefix; the script creates throwaway indices and deletes them afterwards:

```bash
ES_HOST=http://your-cluster:9200 node scripts/smoke.mjs --write smoke-test
```

Tool functions never throw — they return failures as `Error:` text fragments — so
the script scans the fragments and exits non-zero on any failure.

## Docker

```bash
docker build -t elasticsearch7-mcp:dev .
```

CI builds the same Dockerfile on every pull request and pipes an MCP handshake
into the container, so a break surfaces on the PR rather than on the tag that was
supposed to ship it.

## Elasticsearch 7.x, deliberately

`@elastic/elasticsearch` is pinned to `^7.17.14`. **Do not upgrade it to 8.x or
9.x**: the 8.x client hardcodes a product check requiring the `x-elastic-product`
header (which Elasticsearch only emits from 7.14) and `compatible-with=8` media
types that a 7.x server rejects. Neither is reachable through `ClientOptions`. A
real 8.x upgrade means re-migrating every tool, not bumping a version.

See [CLAUDE.md](CLAUDE.md) for the architecture, the tool contract, and the
conventions a change is expected to follow.
