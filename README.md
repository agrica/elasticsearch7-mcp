# Elasticsearch 7.x MCP Server
[![M8ven Score](https://m8ven.ai/badge/mcp/agrica-elasticsearch7-mcp-1yus5i)](https://m8ven.ai/mcp/agrica-elasticsearch7-mcp-1yus5i)

MCP Server for connecting to your Elasticsearch cluster directly from any MCP Client (like Claude Desktop, Cursor).

> [!IMPORTANT]
> **This fork targets Elasticsearch 7.x only.** It pins the `@elastic/elasticsearch` 7.17 client,
> whose product check accepts servers older than 7.14. For an Elasticsearch 8.x cluster, use the
> upstream project [@awesome-ai/elasticsearch-mcp](https://www.npmjs.com/package/@awesome-ai/elasticsearch-mcp),
> which this fork is derived from — the 8.x client cannot talk to a 7.x server, and vice versa.

This server connects agents to your Elasticsearch data using the Model Context Protocol. It allows you to interact with your Elasticsearch indices through natural language conversations.

## Feature Overview

Tools come in three sets. Only the first is always exposed; the other two are
opt-in through an environment variable, so a production deployment can offer
diagnostics without offering deletes. Gating happens at registration: a disabled
tool never appears in `tools/list`, so the model cannot call it and it costs
nothing in the agent's context.

### Always available — read and write data

#### Cluster
* `elasticsearch_health`: cluster health, optionally down to index level
* `cluster_info`: cluster name, Elasticsearch version and build flavour

#### Index operations
* `list_indices`: list indices, filtered by an Elasticsearch wildcard (`log-*`)
* `create_index`: create an index with optional settings and mappings
* `reindex`: copy an index, optionally filtered by a query or transformed by a script
* `get_aliases`: which aliases point at which indices

#### Mappings
* `get_mappings`: the fields of an index, as dotted paths with their types, then the raw mapping
* `create_mapping`: create or update the mapping of an index

#### Search and data
* `search`: run a query DSL search, with highlighting injected over every text field — nested ones included — unless the query brings its own `highlight`
* `count`: how many documents match, without transferring any
* `get_document`: fetch one document by id
* `bulk`: index many documents at once

#### Templates
* `create_index_template`: create or update a composable index template
* `get_index_template`: read index templates

#### Fields
* `field_caps`: which fields exist across an index **pattern**, and whether each is searchable and aggregatable. Takes a wildcard, unlike `get_mappings` — and it is the only way to see a field mapped as two different types across indices, which makes an aggregation over it silently partial rather than failing.
* `analyze`: the terms a text is broken into, which is what a query must produce to match. This is the answer to "my search returns nothing and I do not know why".

#### Tasks
* `get_task`: progress of a long-running task, such as the one `reindex` returns

### `ES_ADMIN_TOOLS=true` — diagnostics (read-only)

These only read, so they are safe to enable in production — and are the point of
this set: an agent can then explain *why* an index is unhealthy without anyone
logging into the cluster.

* `explain_allocation`: why a shard is unassigned, with each allocator's decision
* `list_shards`: shard-level state, leading with the copies that are not `STARTED`
* `list_nodes`: heap, CPU, load and disk pressure per node
* `get_node_stats`: garbage collection, thread pool queues and rejections, tripped breakers — the counters `list_nodes` cannot show
* `get_index_stats`: per-index counters — size, segments, indexing, search, merges
* `get_index_settings`: an index's settings (`refresh_interval`, replicas, read-only blocks)
* `get_cluster_settings`: cluster settings that were overridden at runtime
* `list_tasks`: what the cluster is currently running

### `ES_ALLOW_DESTRUCTIVE=true` — irreversible

Intended for a staging environment, and off by default so production cannot
reach them at all.

* `delete_index`: delete an index and its data
* `delete_document`: delete one document by id
* `delete_by_query`: delete every document matching a query — **asynchronous**, it returns a task id and the deletion continues in the background
* `delete_index_template`: delete an index template

Even with the flag on, these refuse a wildcard, a comma-separated list, `*` and
`_all`: they act on one named index at a time. A model that mistakes `logs-*`
for a single index gets a refusal instead of an emptied cluster.

### `ES_ECS_TOOLS=true` — ECS log search (read-only)

Five tools for clusters whose application logs are in
[ECS](https://www.elastic.co/docs/reference/ecs/ecs-field-reference). They take
named parameters instead of a query DSL and answer in log lines instead of JSON
documents, because the schema is known in advance — which is also what lets them
request only the fields they print.

They need **`ES_ECS_INDEX_PATTERN`**, which has no default: the server refuses to
start with the flag on and the pattern missing. A guess like `logs-*` would sweep
whichever indices happen to match on your cluster and answer confidently from the
wrong data.

* `search_logs`: recent events, newest first, one line each — filter by `service`, `env`, `levels`/`minLevel`, `host`, `logger`, `dataset`, `traceId`, `requestId` and free text, over a window given as `15m`, `2h`, `7d`
* `log_histogram`: counts per time bucket, to see when something started, peaked or stopped. The bucket width is derived from the window, and empty buckets are kept because a gap is part of the answer
* `error_summary`: errors grouped by `error.type`, with counts, first and last occurrence, affected services and a sample message
* `trace_request`: one request across every service that handled it, oldest first, with the chain of services it travelled through and its failing events. Matches `trace.id` **or** `http.request.id`, so it works whether or not your stack emits distributed traces
* `top_values`: the most frequent values of a field — what your cluster actually indexes, before you filter on a guess

> [!TIP]
> **`env` matters on a shared logging cluster.** Where several environments are
> collected into one set of indices, omitting `env` sums them, and nothing in the
> answer says that it is a sum. Measured on one such cluster: a service reporting
> 390 errors over a day was 210 from integration, 179 from acceptance and 1 from
> qualification. Run `top_values` on `service.environment` to see whether yours is
> arranged that way.
>
> **`trace_request` is the "where did this come from" tool.** The other four
> aggregate across requests, so none of them can attribute a failure to a call two
> services further down. It reads oldest-first, because a chain is followed
> forwards, and its chain and failing events come from aggregations — so they stay
> complete even when the timeline is capped by `limit`.

> [!NOTE]
> **These target ECS 1.x field types, because that is what Elasticsearch 7.8 can
> express.** `match_only_text` arrived in 7.14 and `wildcard` in 7.9, so a mapping
> pushed to a 7.8 cluster necessarily predates ECS 1.12, where `error.message` and
> `error.stack_trace` moved to those types.
>
> The consequence is visible in the tools: `error.message` is `text` with no
> `keyword` sub-field, so errors **cannot** be grouped by message — `error_summary`
> groups by `error.type` and gives events lacking one their own reported bucket
> rather than dropping them. Grouping by `error.stack_trace` looks possible, since
> ECS 1.x types it as `keyword`, but ECS sets `ignore_above: 1024` on keywords, so
> a longer trace is not indexed and would silently vanish from the aggregation.

Enabling this set adds about **8.4 KB** to the `tools/list` response every
session, which is why it is a flag: a cluster whose logs are not in ECS would
pay for four tool schemas that can only return nothing.

### How It Works

1. The MCP Client analyzes your request and determines which Elasticsearch operations are needed.
2. The MCP server carries out these operations (listing indices, fetching mappings, performing searches).
3. The MCP Client processes the results and presents them in a user-friendly format.

## Getting Started

### Prerequisites

* An Elasticsearch 7.x instance (tested against 7.8; the 7.17 client supports 6.8 through 7.x)
* Elasticsearch credentials — an API key, or a username and password
* An MCP client: Claude Code, Claude Desktop, Codex, Cursor, or anything else that speaks MCP over stdio

### Authenticate to GitHub Packages, once

> [!IMPORTANT]
> This package is published to **GitHub Packages**, not npmjs.com, and GitHub
> Packages requires a token even for public packages. Until you add one, every
> install below fails with a 401. Put it in your **user-level** `~/.npmrc`:
>
> ```
> @agrica:registry=https://npm.pkg.github.com
> //npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
> ```
>
> `YOUR_GITHUB_TOKEN` is a personal access token with the `read:packages` scope.
>
> Keep it in your own `~/.npmrc` rather than a project file — a token committed
> to a repository is a leaked token, and some package managers refuse to read one
> from there at all.

### Connect it to your client

Every example below sets `ES_HOST` and `ES_API_KEY`. Swap in
`ES_USERNAME`/`ES_PASSWORD` for basic auth or the `ES_OAUTH_*` variables for
OAuth2 (see [OAuth2](#oauth2)), add `ES_ADMIN_TOOLS=true` to get
the diagnostic tools, and set `ES_INSTANCE_LABEL` when more than one instance is
declared — see [Configuration Options](#configuration-options).

<details open>
<summary><strong>Claude Code</strong> — <code>claude mcp add</code></summary>

```bash
claude mcp add elasticsearch7 \
  --env ES_HOST=https://your-cluster:9200 \
  --env ES_API_KEY=your-api-key \
  --env ES_ADMIN_TOOLS=true \
  -- npx -y @agrica/elasticsearch7-mcp
```

Then `/mcp` in a session lists the server and its tools.

Two details that are easy to get wrong:

* Everything after `--` is the command that runs the server; without it, Claude
  Code would try to parse `-y` as one of its own flags.
* Do not put the server name straight after `--env` — the CLI reads it as
  another `KEY=value` pair and rejects it. Above, the name comes first, which is
  why it works.

The server is added at local scope, so it loads in the current project only. Add
`--scope user` to get it everywhere, or `--scope project` to write it into
`.mcp.json` and share it with your team — mind that a committed `.mcp.json`
would carry your API key, so prefer user scope for credentials.

</details>

<details>
<summary><strong>Claude Desktop</strong> — <code>claude_desktop_config.json</code></summary>

Edit `claude_desktop_config.json` — **Settings > Developer > Edit Config** opens
it, or find it at `%APPDATA%\Claude\` on Windows and
`~/Library/Application Support/Claude/` on macOS:

```json
{
  "mcpServers": {
    "elasticsearch7": {
      "command": "npx",
      "args": ["-y", "@agrica/elasticsearch7-mcp"],
      "env": {
        "ES_HOST": "https://your-cluster:9200",
        "ES_API_KEY": "your-api-key",
        "ES_ADMIN_TOOLS": "true"
      }
    }
  }
}
```

Restart Claude Desktop afterwards; it only reads that file at startup.

</details>

<details>
<summary><strong>Codex</strong> — <code>codex mcp add</code> or <code>config.toml</code></summary>

```bash
codex mcp add elasticsearch7 \
  --env ES_HOST=https://your-cluster:9200 \
  --env ES_API_KEY=your-api-key \
  -- npx -y @agrica/elasticsearch7-mcp
```

Or write it into `~/.codex/config.toml` by hand. Note that Codex spells the
table `mcp_servers` with an underscore, and that the environment goes in its own
sub-table rather than inline:

```toml
[mcp_servers.elasticsearch7]
command = "npx"
args = ["-y", "@agrica/elasticsearch7-mcp"]

[mcp_servers.elasticsearch7.env]
ES_HOST = "https://your-cluster:9200"
ES_API_KEY = "your-api-key"
ES_ADMIN_TOOLS = "true"
```

`/mcp` inside Codex confirms the server is loaded.

</details>

<details>
<summary><strong>Any other MCP client</strong> — stdio, no port</summary>

The server is a plain stdio MCP server, so anything on the
[MCP client list](https://modelcontextprotocol.io/clients) works. It needs three
things: the command `npx`, the arguments `-y @agrica/elasticsearch7-mcp`, and the
`ES_*` variables in its environment. It never listens on a port, and writes
nothing but MCP protocol to stdout — diagnostics go to stderr.

</details>

### Configuration Options

The Elasticsearch MCP Server supports configuration options to connect to your Elasticsearch:

> [!NOTE]
> You must provide either an API key or both username and password for authentication.

| Environment Variable | Description | Required |
|---------------------|-------------|----------|
| `ES_HOST` | Your Elasticsearch instance URL(s) - supports single URL or comma-separated multiple URLs (also supports legacy `HOST`) | Yes |
| `ES_API_KEY` | Elasticsearch API key for authentication (also supports legacy `API_KEY`) | No |
| `ES_USERNAME` | Elasticsearch username for basic authentication (also supports legacy `USERNAME`) | No |
| `ES_PASSWORD` | Elasticsearch password for basic authentication (also supports legacy `PASSWORD`) | No |
| `ES_CA_CERT` | Path to custom CA certificate for Elasticsearch SSL/TLS (also supports legacy `CA_CERT`) | No |
| `ES_OAUTH_TOKEN_URL` | OAuth2 token endpoint. Setting it turns on OAuth2, which then takes precedence over the API key and basic auth. Must be `https://` (plain `http://` is accepted only for `localhost`). | No |
| `ES_OAUTH_CLIENT_ID` | OAuth2 client id. Required once `ES_OAUTH_TOKEN_URL` is set. | No |
| `ES_OAUTH_CLIENT_SECRET` | OAuth2 client secret. Required once `ES_OAUTH_TOKEN_URL` is set, unless the `_FILE` form is used. | No |
| `ES_OAUTH_CLIENT_SECRET_FILE` | Path to a file holding the secret, for a mounted Docker secret. Read and trimmed at startup. | No |
| `ES_OAUTH_SCOPE` | Scope to request, if the provider needs one. | No |
| `ES_OAUTH_AUDIENCE` | Audience to request. Auth0 needs it to issue a JWT; Keycloak and Azure AD use `ES_OAUTH_SCOPE` instead. | No |
| `ES_OAUTH_AUTH_STYLE` | `post` (default) sends the credentials in the form body; `basic` sends them in an HTTP Basic header. | No |
| `ES_REQUEST_TIMEOUT` | Per-request timeout in milliseconds. Default `30000` — raise it if aggregations over many indices time out. | No |
| `ES_MAX_RETRIES` | Retries per request. Default `3`; `0` disables them. | No |
| `ES_MAX_RESULT_BYTES` | Ceiling on one tool result. Default `32768`. Past it, detail is omitted and the result says so. | No |
| `ES_INSTANCE_LABEL` | Free-text name of this deployment, e.g. `production`. Shown as the server title, so several instances declared side by side are distinguishable. | No |
| `ES_ADMIN_TOOLS` | `true` to also expose the read-only diagnostic tools. Default off. | No |
| `ES_ALLOW_DESTRUCTIVE` | `true` to also expose the irreversible tools. Default off. | No |
| `ES_ECS_TOOLS` | `true` to also expose the ECS log search tools. Default off. | No |
| `ES_ECS_INDEX_PATTERN` | Index pattern the ECS log tools query, e.g. `logs-app-*`. **No default**: with `ES_ECS_TOOLS` on and this unset, the server refuses to start. | Only with `ES_ECS_TOOLS` |

> [!WARNING]
> `ES_ADMIN_TOOLS`, `ES_ALLOW_DESTRUCTIVE` and `ES_ECS_TOOLS` have **no un-prefixed legacy alias**,
> unlike the connection variables above. That is deliberate: a bare `ADMIN_TOOLS`
> or `ALLOW_DESTRUCTIVE` in an environment is far too easy to set by accident for
> something that decides whether deletes are reachable.
>
> Both accept `true` or `1`; anything else, including an unset variable, means off.

### OAuth2

Set `ES_OAUTH_TOKEN_URL`, `ES_OAUTH_CLIENT_ID` and `ES_OAUTH_CLIENT_SECRET` and
the server obtains a `client_credentials` token, renews it before it expires, and
sends it as `Authorization: Bearer …` on every request. It takes precedence over
`ES_API_KEY` and `ES_USERNAME`/`ES_PASSWORD`, and says so on stderr at startup if
those are still set — so you can see which identity is really talking to the
cluster.

**What it is for.** An Elasticsearch 7.x cluster cannot validate a third-party
OAuth2 token itself: the JWT realm arrived in 8.2, and the 7.x OIDC realm needs a
platinum licence and a browser. So this is for a cluster reached through a
**gateway that validates the token** and forwards the request. Point `ES_HOST` at
the gateway.

**Keep the secret out of the config file.** A project `.mcp.json` is checked into
version control, so reference the secret instead of pasting it:

```json
{
  "mcpServers": {
    "elasticsearch": {
      "command": "npx",
      "args": ["-y", "@agrica/elasticsearch7-mcp"],
      "env": {
        "ES_HOST": "https://es-gateway.internal",
        "ES_OAUTH_TOKEN_URL": "https://idp.internal/realms/data/protocol/openid-connect/token",
        "ES_OAUTH_CLIENT_ID": "mcp-elasticsearch",
        "ES_OAUTH_CLIENT_SECRET": "${ES_OAUTH_CLIENT_SECRET}",
        "ES_OAUTH_SCOPE": "es:read"
      }
    }
  }
}
```

`${VAR}` is expanded from your own environment. The alternatives are a
user-scoped server entry (`claude mcp add --scope local`, stored outside the
repository) or `ES_OAUTH_CLIENT_SECRET_FILE` pointing at a mounted file.

**Ask for the scope you can use.** If the deployment runs without
`ES_ALLOW_DESTRUCTIVE`, request a read-only scope: a write scope buys nothing
when no write tool is registered, and widens what the secret is worth if it
leaks. When the gateway refuses a request for want of a scope, the error names
the one it asked for.

### Result size

A tool result is capped at 32 KB (`ES_MAX_RESULT_BYTES`). This matters on a
logging cluster: before the cap, one `list_shards` call over a year of daily
indices returned 385 KB — around 96 000 tokens — in a single answer, which is
more than most sessions can hold.

When a result is trimmed it says so, says how much went, and says how to ask a
smaller question. Three tools shape their answers around it:

* `list_indices` and `list_shards` return a readable summary; the same rows as
  text are behind `verbose`.
* `search` caps `size` at 100 per call and tells you the `from` to page with.
* `get_mappings` lists the fields first and the raw mapping second, so a
  thousand-field index still answers the question it was asked.

Four tools — `list_indices`, `list_shards`, `get_index_settings` and
`get_mappings` — also return their answer as typed structured output, so a
client can read the rows instead of parsing the text. It is assembled from
whatever room the readable answer left, and reports `returned` against `total`
so a partial listing is visible as a number.

Run `pnpm run measure` against the built output to see the current figures for
your own configuration.

### Labelling several instances

Most setups declare this server more than once — one entry per cluster. The
entries are otherwise identical, so a client shows two servers with the same
name and nothing to tell them apart. `ES_INSTANCE_LABEL` becomes the server's
display title, and it is the natural place to say which environment an entry
reaches:

```json
{
  "mcpServers": {
    "es7-prod": {
      "command": "npx",
      "args": ["-y", "@agrica/elasticsearch7-mcp"],
      "env": {
        "ES_HOST": "https://es-prod:9200",
        "ES_API_KEY": "prod-key",
        "ES_INSTANCE_LABEL": "production",
        "ES_ADMIN_TOOLS": "true"
      }
    },
    "es7-staging": {
      "command": "npx",
      "args": ["-y", "@agrica/elasticsearch7-mcp"],
      "env": {
        "ES_HOST": "https://es-staging:9200",
        "ES_API_KEY": "staging-key",
        "ES_INSTANCE_LABEL": "staging",
        "ES_ADMIN_TOOLS": "true",
        "ES_ALLOW_DESTRUCTIVE": "true"
      }
    }
  }
}
```

That pair is the intended shape: **diagnostics on both, deletes only on
staging.** Production keeps the tools that explain an unhealthy index and never
exposes one that can remove data — the model cannot call what was never
registered.

The label is also printed to stderr at startup, which is where to look when a
client reports a connection but you cannot tell which cluster answered.

### Multiple URLs Configuration

You can configure multiple Elasticsearch nodes for high availability and load balancing:

```json
{
  "mcpServers": {
    "elasticsearch7-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@agrica/elasticsearch7-mcp"
      ],
      "env": {
        "ES_HOST": "https://es-node1:9200,https://es-node2:9200,https://es-node3:9200",
        "ES_API_KEY": "your-api-key"
      }
    }
  }
}
```

The client will automatically handle failover and load balancing between the configured nodes.

## Running with Docker

Each release publishes a multi-arch image (`linux/amd64`, `linux/arm64`) to the
GitHub Container Registry:

```bash
docker pull ghcr.io/agrica/elasticsearch7-mcp:latest
```

The server speaks stdio, so the container needs an interactive stdin and no
published port. In an MCP client:

```json
{
  "mcpServers": {
    "elasticsearch7-mcp": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "ES_HOST",
        "-e", "ES_API_KEY",
        "ghcr.io/agrica/elasticsearch7-mcp:latest"
      ],
      "env": {
        "ES_HOST": "your-elasticsearch-host",
        "ES_API_KEY": "your-api-key"
      }
    }
  }
}
```

> [!NOTE]
> Like the npm package, the image lives in GitHub Packages: pulling it requires a
> token with the `read:packages` scope, even though the repository is public.

The image needs no port published and no volume: it speaks stdio, and the MCP
client owns its stdin and stdout.

## Example Queries

> [!TIP]
> Here are some natural language queries you can try with your MCP Client.

#### Cluster Management
* "What is the health status of my Elasticsearch cluster?"
* "How many active nodes are in my cluster?"

#### Index Operations
* "What indices do I have in my Elasticsearch cluster?"
* "Create a new index called 'users' with 3 shards and 1 replica."
* "Reindex data from 'old_index' to 'new_index'."

#### Mapping Management
* "Show me the field mappings for the 'products' index."
* "Add a keyword type field called 'tags' to the 'products' index."

#### Search & Data Operations
* "Find all orders over $500 from last month."
* "Which products received the most 5-star reviews?"
* "Bulk import these customer records into the 'customers' index."

#### Template Management
* "Create an index template for logs with pattern 'logs-*'."
* "Show me all my index templates."

#### Diagnostics (needs `ES_ADMIN_TOOLS=true`)
* "The 'logs-2026' index is yellow — why are its shards unassigned?"
* "Is any node close to a disk watermark?"
* "Is the cluster rejecting writes, or spending its time in garbage collection?"
* "Which of my indices is the largest, and how much of it is deleted documents?"
* "Has anyone disabled shard allocation on this cluster?"
* "Is a reindex still running?"

#### ECS logs (needs `ES_ECS_TOOLS=true`)
* "What errors has the billing service logged in the last hour?"
* "When did the 5xx spike start, and is it still going?"
* "Which hosts are producing these timeouts?"
* "What log levels does this cluster actually index?"
* "Follow request aowQJmtrwvjJOWI3TyL_SAAAAA4 — which service did it fail in?"
* "How many errors on the billing service in acceptance, not counting the other environments?"

#### Destructive (needs `ES_ALLOW_DESTRUCTIVE=true`)
* "Delete the 'smoke-test-source' index."
* "Remove every document older than 2024 from 'logs-archive'."

## Troubleshooting

| Symptom | Cause |
|---|---|
| `npm error code E401` on install or `npx` | No GitHub Packages token in your user-level `~/.npmrc`. See [Authenticate to GitHub Packages](#authenticate-to-github-packages-once). |
| `Server error: ... invalid url` at startup | `ES_HOST` is unset or malformed. It is validated at startup on purpose, rather than failing later on the first query. |
| `Server error: ... ES_OAUTH_CLIENT_SECRET ... is required` | An `ES_OAUTH_*` variable is set but the block is incomplete. A half-configured factor is refused rather than falling back to another identity. |
| `Error: Authentication failed before any request was sent: …` on every tool | The token endpoint could not be reached, or refused the credentials. The message carries the provider's own `error` field. Nothing was sent to the cluster. |
| `Error: … error="insufficient_scope", and asks for scope "…"` | The gateway wants a scope the token does not carry. Add it to `ES_OAUTH_SCOPE`. |
| The client connects, but a diagnostic or delete tool is missing | That set is gated. Set `ES_ADMIN_TOOLS=true` or `ES_ALLOW_DESTRUCTIVE=true` and restart the client. |
| `Server error: ... ES_ECS_INDEX_PATTERN is required` | `ES_ECS_TOOLS` is on with no pattern. There is deliberately no default — set it to the pattern holding your ECS logs. |
| Every tool times out, and `ES_HOST` carries a path prefix such as `https://host/es/` | The client asks for the cluster root at the prefix **without** a trailing slash — `GET /es` — for its product check. A reverse proxy that only maps `/es/` answers that with a redirect, which the 7.x client does not follow. Map the prefix with and without the slash. |
| `search_logs` returns nothing, with no error | A keyword filter did not match the indexed spelling. `service.name`, `log.level` and the rest are exact and case-sensitive; run `top_values` on the field to see the real values. |
| `top_values` refuses a field as "analysed text" | Aggregations need a keyword. Try `<field>.keyword`, or ask `field_caps` which fields the pattern reports as aggregatable. |
| `Refusing to act on the pattern "logs-*"` | Working as intended: destructive tools take one concrete index name, never a pattern, even with the flag on. |
| A connection error mentioning the product check | The cluster is 8.x, or unreachable. This build talks to 7.x only. |

Found a bug or want a tool that is missing? Open an issue on the GitHub
repository. To work on the code, start from
[CONTRIBUTING.md](CONTRIBUTING.md).
