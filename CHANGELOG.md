# Elasticsearch 7.x MCP Server Changelog

All significant project changes will be documented in this file.

## [Unreleased]

### Added
- **15 new tools, in three sets gated at registration.** The always-on set gained `count`,
  `get_document`, `get_aliases`, `get_task` and `cluster_info`. Two new sets are opt-in:
  - `ES_ADMIN_TOOLS=true` adds seven read-only diagnostics — `explain_allocation`,
    `list_shards`, `list_nodes`, `get_index_stats`, `get_index_settings`,
    `get_cluster_settings`, `list_tasks`. They only read, so they are safe in production,
    which is the point: an agent can explain *why* an index is unhealthy without anyone
    holding cluster credentials.
  - `ES_ALLOW_DESTRUCTIVE=true` adds `delete_index`, `delete_document`, `delete_by_query`
    and `delete_index_template` — intended for staging, off in production.

  Gating is registration, not a runtime guard: an unregistered tool is absent from
  `tools/list`, so the model cannot call it and its schema costs the caller nothing.
  Measured `tools/list` payloads: **8043 B** for the 15 default tools, 10928 B with
  diagnostics, 12815 B with everything — so a production agent is spared 4772 B, 59% of
  its default tool budget, rather than merely being told not to call the deletes.
- Destructive tools refuse a wildcard, a comma-separated list, `*` and `_all` **even when
  the flag is on**, and send no request when they do. A model that mistakes `logs-*` for a
  single index gets a refusal, not an emptied cluster. Fifteen tests assert that nothing
  reaches the cluster for each of those forms.
- `search` now returns the `aggregations` block. An aggregation query typically asks for
  `size: 0`, so the previous output was `Total search results: 0` and nothing else — the
  answer was fetched from the cluster and then discarded.

### Changed
- `src/server.ts` is now composition only; registration moved to `src/register/{data,admin,destructive}Tools.ts`.
- `delete_index_template` moved from the always-on set to the destructive set. **Surface
  change:** it needs `ES_ALLOW_DESTRUCTIVE=true` to appear. Leaving one delete reachable in
  production while gating the others would be incoherent.

### Fixed
- `list_indices` advertised "support regex" while `pattern` reaches the cat API as an
  Elasticsearch wildcard. A calling model sending `^logs-` got an empty list with no hint
  why. The description now says wildcard, and a test fails if the claim returns.

### Changed
- Tool descriptions rewritten around what a calling model cannot infer: `reindex` is
  asynchronous and returns a task id, `create_mapping` creates the index when absent and
  cannot retype an existing field, `bulk` refreshes so documents are searchable at once,
  `create_index` fails when the index exists, and the template tools are the composable
  7.8+ API applying only to indices created later. Verified cost: the `tools/list` payload
  went from 6107 to 6376 bytes (+4.4%), descriptions +508 bytes against -243 clawed back
  from schema verbosity.
- `list_indices` now reports `store.size` and requests `bytes: "b"`, so a caller gets a
  comparable number instead of "4.7gb". It could not answer "which index is largest"
  before.

### Verified
- Every API call checked against `requestParams.d.ts` of the installed 7.17.14 client and
  the published 7.17 reference: `body` is required on `putMapping`, `putIndexTemplate`,
  `reindex` and `indices.create`, everything else is query-string, and the deprecated
  `type` / `include_type_name` parameters are correctly unused. No correction was needed.
- Composable index templates (`_index_template`) landed in Elasticsearch 7.8.0 exactly, so
  the three template tools work on the 7.8 target — but would 404 on anything older.


### Fixed
- `create_mapping` reported a successful write as a failure whenever the target was an
  alias, a wildcard or date math. `getMapping` keys its response by concrete index names,
  and the unguarded `body[index].mappings` threw a `TypeError` that the catch block turned
  into `Error: Cannot read properties of undefined` — after `putMapping` had already
  succeeded. It now reports what happened instead.
- `get_index_template` now tolerates the 404 Elasticsearch sends for a missing named
  template, so the "No template found" message is reachable. It was dead code, and the
  test that covered it asserted a 200-with-empty-list that no 7.x cluster returns.
- `search` no longer carries a dead `"dense_vector" in fieldData` disjunct. It tested for a
  *key* of that name, which no mapping has, so it never matched; documentation claiming
  dense_vector fields were highlighted has been corrected rather than the code changed.
  Runtime behaviour is unchanged.
- `test/server.test.ts` no longer depends on nothing listening on localhost:9200 — this
  project's own documented dev endpoint. It points at a port that cannot be bound.

### Changed
- **The tool contract is now typed.** `src/toolResult.ts` declares `ToolResult` and asserts
  at compile time that it satisfies the SDK's `CallToolResult`. All eleven tool functions
  are annotated `Promise<ToolResult>`; before, nothing checked the shape the whole server
  depends on.
- **Request bodies and public signatures use `estypes`** instead of `Record<string, any>`:
  `MappingTypeMapping`, `IndicesIndexSettings`, `QueryDslQueryContainer`, `Script`, and
  `NonNullable<estypes.XRequest["body"]>`. A misspelt body key is now a compile error.
- The `reindex` tool's `script` parameter is a shaped object (`source` required, optional
  `lang` and `params`) rather than a free-form record, which both matches
  `estypes.Script` and tells the calling model what a script needs.
- `createClientOptions` takes `z.input` of the config schema rather than `z.output`. It
  validates its own argument, so the output type was simply the wrong signature — it is
  what forced nine `as any` casts in the tests, all now gone.
- Extracted `textFragment` and `toolError`, removing the error-handling block that was
  duplicated across all nine tool files (22 copies of the same ternary).
- Enabled `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`,
  `noImplicitReturns` and `noFallthroughCasesInSwitch`. `exactOptionalPropertyTypes` is
  deliberately left off: it conflicts with the ES client's generated optionals and would
  buy casts rather than safety.
- Test helpers: `failEveryRoute` provokes real cluster failures (an unregistered route
  yields a 404, which a 404-tolerant tool treats as success), and `firstRequest` replaces
  unchecked `requests[0]` indexing with a readable failure.


### Added
- **Docker build chain in CI and release.** Every CI run builds the image and pipes a
  JSON-RPC handshake into the container, asserting via `scripts/check-mcp-tools.mjs` that
  it answers `tools/list` with all 11 tools — a Dockerfile break now surfaces on the pull
  request rather than on the tag meant to ship it. On a tag, a `docker` job builds
  `linux/amd64` and `linux/arm64` and pushes to `ghcr.io/agrica/elasticsearch7-mcp`,
  tagged `x.y.z`, `x.y` and `latest`. A manual run builds both platforms and pushes
  nothing, to rehearse the emulated arm64 build before tagging.
- `.dockerignore`, which the project had none of. CI installs `node_modules` before
  building the image, so `COPY . .` was copying the runner's tree over the image's own
  lockfile install.

### Changed
- `Dockerfile` is now multi-stage: dev dependencies and `tsc` stay in the build stage, the
  runtime stage installs `--omit=dev` and copies only `dist/`. It also pins
  `node:24-alpine` instead of the floating `node:lts-alpine` so the image runs the Node
  the project is type-checked against, runs as the non-root `node` user, and carries the
  OCI labels GHCR needs to link the image to this repository. The entry point is
  unchanged (`node dist/index.js`), so the Smithery configuration still applies.


### Changed
- Dependencies brought up to date. `@modelcontextprotocol/sdk` 1.8.0 -> 1.30.0,
  `@types/node` 22 -> 24, and `.nvmrc` 22.14.0 -> 24.19.0. `shx`, `typescript` and
  `vitest` were already current.
- **`zod` is now a direct dependency, on v4.** The SDK declares it as a non-optional
  peer (`^3.25 || ^4.0`) rather than shipping it transitively. zod 4 also requires a key
  schema on records, so the eight `z.record(z.any())` calls in `src/server.ts` became
  `z.record(z.string(), z.any())`. Tool names and parameter shapes are unchanged: an
  existing MCP client sees the same schemas.
- `@types/node` tracks the `.nvmrc` major deliberately. Node 26 is Current, not LTS;
  the project targets Node 24 ("Krypton"), so the types stay on 24.x.

### Kept back, on purpose
- `@elastic/elasticsearch` stays on `^7.17.14`: the whole point of this fork.
- `@elastic/elasticsearch-mock` stays on `^1.0.0`. 2.x extends `BaseConnection`, an export
  that only the 8.x client has, and throws at `getConnection()`.

### Added
- `test/server.test.ts`: four tests driving a real MCP session over the SDK's
  `InMemoryTransport`, covering the registration layer in `src/server.ts` that the tool
  tests bypass. One of them feeds an arbitrary query DSL through the zod schema, which is
  what would catch a future zod major tightening validation. 66 tests total.


### Changed
- **English throughout.** Removed `README.zh-CN.md` and translated every remaining
  Chinese string and comment (`createIndex.ts`, `getClusterHealth.ts`, `bulk.ts`,
  `listIndices.ts`, `config/schema.ts`). User-facing failures now always begin with
  `Error:`, so the former Chinese error prefix is gone from the tool contract and from
  the failure detection in `scripts/smoke.mjs` and the test helpers.

### Development Tools
- **Unit test suite** (`npm test`): 62 tests on vitest, mocking Elasticsearch at the
  client's connection layer through `@elastic/elasticsearch-mock` (pinned to 1.x — 2.x
  extends `BaseConnection`, an 8.x-only export). Mocking there rather than faking the
  client object means a test fails when a tool sends the wrong request shape, not only
  when it formats a response wrongly. Verified by mutation: removing the `body` nesting
  in `search` or reading `docsCount` instead of `docs.count` in `list_indices` makes six
  tests fail.
- Added `npm run typecheck` (`tsconfig.test.json`) covering `src`, `test` and the root
  entry points. vitest transpiles TypeScript without type-checking it, so this is what
  keeps the test files type-safe.
- CI and the release workflow now run `npm run typecheck` and `npm test`; a failing suite
  blocks a release.

### Changed
- TypeScript upgraded from 5.8.2 to **7.0.2** (the native port). No source or `tsconfig`
  change was needed: the same `Node16` module resolution, `strict` and `declaration`
  settings compile as-is, emitting the identical 12 JS files and 12 declarations.
