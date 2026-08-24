# Elasticsearch 7.x MCP Server

MCP Server for connecting to your Elasticsearch cluster directly from any MCP Client (like Claude Desktop, Cursor).

> [!IMPORTANT]
> **This fork targets Elasticsearch 7.x only.** It pins the `@elastic/elasticsearch` 7.17 client,
> whose product check accepts servers older than 7.14. For an Elasticsearch 8.x cluster, use the
> upstream project [@awesome-ai/elasticsearch-mcp](https://www.npmjs.com/package/@awesome-ai/elasticsearch-mcp),
> which this fork is derived from — the 8.x client cannot talk to a 7.x server, and vice versa.

This server connects agents to your Elasticsearch data using the Model Context Protocol. It allows you to interact with your Elasticsearch indices through natural language conversations.


## Demo

[![Elasticsearch MCP Demo](https://img.youtube.com/vi/Wqw1XL8de5A/0.jpg)](https://www.youtube.com/watch?v=Wqw1XL8de5A "Elasticsearch MCP Demo")

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
* `get_mappings`: field mappings of an index
* `create_mapping`: create or update the mapping of an index

#### Search and data
* `search`: run a query DSL search, with highlighting injected automatically
* `count`: how many documents match, without transferring any
* `get_document`: fetch one document by id
* `bulk`: index many documents at once

#### Templates
* `create_index_template`: create or update a composable index template
* `get_index_template`: read index templates

#### Tasks
* `get_task`: progress of a long-running task, such as the one `reindex` returns

### `ES_ADMIN_TOOLS=true` — diagnostics (read-only)

These only read, so they are safe to enable in production — and are the point of
this set: an agent can then explain *why* an index is unhealthy without anyone
logging into the cluster.

* `explain_allocation`: why a shard is unassigned, with each allocator's decision
* `list_shards`: shard-level state, leading with the copies that are not `STARTED`
* `list_nodes`: heap, CPU, load and disk pressure per node
* `get_index_stats`: per-index counters — size, segments, indexing, search, merges
* `get_index_settings`: an index's settings (`refresh_interval`, replicas, read-only blocks)
* `get_cluster_settings`: cluster settings that were overridden at runtime
* `list_tasks`: what the cluster is currently running

### `ES_ALLOW_DESTRUCTIVE=true` — irreversible

Intended for a staging environment, and off by default so production cannot
reach them at all.

* `delete_index`: delete an index and its data
* `delete_document`: delete one document by id
* `delete_by_query`: delete every document matching a query
* `delete_index_template`: delete an index template

Even with the flag on, these refuse a wildcard, a comma-separated list, `*` and
`_all`: they act on one named index at a time. A model that mistakes `logs-*`
for a single index gets a refusal instead of an emptied cluster.

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
`ES_USERNAME`/`ES_PASSWORD` for basic auth, and add `ES_ADMIN_TOOLS=true` to get
the diagnostic tools — see [Configuration Options](#configuration-options).

#### Claude Code

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

#### Claude Desktop

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

#### Codex

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

#### Any other MCP client

The server is a plain stdio MCP server, so anything on the
[MCP client list](https://modelcontextprotocol.io/clients) works. It needs three
things: the command `npx`, the arguments `-y @agrica/elasticsearch7-mcp`, and the
`ES_*` variables in its environment. It never listens on a port, and writes
nothing but MCP protocol to stdout — diagnostics go to stderr.

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
| `ES_ADMIN_TOOLS` | `true` to also expose the read-only diagnostic tools. Default off. | No |
| `ES_ALLOW_DESTRUCTIVE` | `true` to also expose the irreversible tools. Default off. | No |

> [!WARNING]
> `ES_ADMIN_TOOLS` and `ES_ALLOW_DESTRUCTIVE` have **no un-prefixed legacy alias**,
> unlike the connection variables above. That is deliberate: a bare `ADMIN_TOOLS`
> or `ALLOW_DESTRUCTIVE` in an environment is far too easy to set by accident for
> something that decides whether deletes are reachable.
>
> Both accept `true` or `1`; anything else, including an unset variable, means off.

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
* "Which of my indices is the largest, and how much of it is deleted documents?"
* "Has anyone disabled shard allocation on this cluster?"
* "Is a reindex still running?"

#### Destructive (needs `ES_ALLOW_DESTRUCTIVE=true`)
* "Delete the 'smoke-test-source' index."
* "Remove every document older than 2024 from 'logs-archive'."

## Troubleshooting

| Symptom | Cause |
|---|---|
| `npm error code E401` on install or `npx` | No GitHub Packages token in your user-level `~/.npmrc`. See [Authenticate to GitHub Packages](#authenticate-to-github-packages-once). |
| `Server error: ... invalid url` at startup | `ES_HOST` is unset or malformed. It is validated at startup on purpose, rather than failing later on the first query. |
| The client connects, but a diagnostic or delete tool is missing | That set is gated. Set `ES_ADMIN_TOOLS=true` or `ES_ALLOW_DESTRUCTIVE=true` and restart the client. |
| `Refusing to act on the pattern "logs-*"` | Working as intended: destructive tools take one concrete index name, never a pattern, even with the flag on. |
| A connection error mentioning the product check | The cluster is 8.x, or unreachable. This build talks to 7.x only. |

Found a bug or want a tool that is missing? Open an issue on the GitHub
repository. To work on the code, start from
[CONTRIBUTING.md](CONTRIBUTING.md).
