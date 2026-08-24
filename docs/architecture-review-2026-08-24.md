# Architecture review and improvement plan

24 August 2026, against commit `e494a32`. Every number below was measured, not
estimated; the method is given with each one so it can be re-run.

> **Status.** All five phases are implemented. The findings below describe the
> state at `e494a32` and are kept as written — a review edited to match the code
> stops being a record of what was wrong. `pnpm run measure` reports the current
> figures; `test/outputScale.test.ts` holds the ceilings.
>
> Three calls the plan left open, and how they went:
>
> - **Item 10 (the mapping request).** Cached per client rather than made
>   opt-in. Highlighting *shrinks* the answer — a snippet instead of a whole
>   stack trace — so making it opt-in would have made the default result larger,
>   which is the opposite of what Phase 1 is for. The cache removes the
>   round-trip after the first search per index, and the guard from item 8
>   removes it entirely for a caller who brings their own `highlight`.
> - **Item 11 (structured output).** Measured, and it changed the design twice.
>   Reserving half the budget for the structured payload cut `list_indices` from
>   365 indices to about half, because the same facts cost roughly twice as much
>   as JSON as they do as a line; the text is now assembled first and the
>   structured copy takes the remainder. Letting it fill that remainder then
>   turned a 26-byte `list_shards` summary into 32 KB, so the structured payload
>   is now as terse as the text it accompanies. The cost that remains is
>   `tools/list`: 10 321 → 11 451 bytes for the default fifteen tools, 16 662 →
>   18 704 with every set enabled.
> - **Item 13 (splitting `dataTools.ts`).** Not done, deliberately. The
>   threshold the finding names is roughly twenty tools; there are fifteen, and
>   the file still reads as a list.

## The finding that reframes the rest

This server spends real design effort on the calling model's context budget. Tools
are split into three sets so a production deployment does not pay for schemas it
will never call, and that saving was measured: **6058 bytes**, the difference
between the 15 default tools (9813 B) and all 26 (15 871 B).

Meanwhile a single `list_shards` call on a realistic logging cluster returns
**385 469 bytes — roughly 96 000 tokens**.

The economy is inverted by a factor of sixty. Everything in Phase 1 follows from
that one asymmetry: the tool *list* is carefully budgeted and the tool *output* is
unbounded.

Measured with the mocked connection against a cluster shaped like a year of daily
indices — 365 indices, 3 primaries and 1 replica each, so 2190 shards:

| Call | Bytes returned | ≈ tokens |
|---|---|---|
| `list_shards`, 2190 shards | 385 469 | 96 000 |
| `search`, `size: 500` on a log index | 127 716 | 32 000 |
| `list_indices`, 365 indices | 54 405 | 13 600 |
| `elasticsearch_health`, index detail on 365 | 12 226 | 3 100 |
| *whole `tools/list`, all 26 tools* | *15 871* | *4 000* |

The target cluster of this fork is named `rec-logging`. Daily indices are exactly
this shape, so these are not adversarial numbers — they are Tuesday.

## What the architecture gets right

Stated first because the plan below only touches what needs changing, and the
rest is worth not breaking.

- **The layering holds.** `index.ts` bootstraps, `src/register/*` declares,
  `src/tools/*` executes. No tool knows about MCP; no register module knows about
  Elasticsearch beyond passing a client. That is why the whole 26-tool
  registration layer could be rewritten to `registerTool` mechanically, in one
  pass, without touching a single tool.
- **Gating at registration, not in a guard.** An unregistered tool cannot be
  called and costs nothing. This is the right shape and should not be
  "simplified".
- **The tool contract is typed and enforced.** `ToolResult` is checked against the
  SDK's `CallToolResult` at compile time, and `test/toolContract.test.ts` proves
  all 26 tools honour never-throwing and `isError`. Dropping `isError` from
  `toolResult.ts` fails 27 tests.
- **The tests mock at the connection layer**, so they fail on a wrong request
  shape rather than only on wrong formatting. Verified repeatedly by mutation
  during this session.
- **`rejectBulkTarget()` is a real guardrail**, independent of the environment
  flag, and it sends nothing to the cluster when it refuses.

## Findings, ranked

### P1 — Tool output is unbounded

`JSON.stringify` appears in nine of the sixteen tool files, and every one of
those dumps whatever the cluster returned. No tool caps its output, none
truncates, none says it truncated. Numbers above.

The consequence is not a slow response, it is a poisoned session: a single
`list_shards` on a mid-sized cluster can exceed the context window outright, and
what survives is a wall of JSON in which the two unassigned shards that mattered
are indistinguishable from the 2188 healthy ones.

Note that `list_shards` already *formats* the answer well — it leads with the
shards that are not `STARTED` — and then appends the full JSON dump anyway. The
summary is the useful part; the dump is what breaks it.

### P2 — `delete_by_query` runs synchronously and can time out mid-delete

`src/tools/destructive.ts` calls `deleteByQuery` without `wait_for_completion`,
so the call blocks until Elasticsearch finishes. The client's default
`requestTimeout` is 30 000 ms. On a large index the timeout fires, the tool
reports `Error: Request timed out` — **and Elasticsearch carries on deleting.**

The model is therefore told a destructive operation failed while it is
succeeding. A model that retries then issues a second delete over a moving
target.

`reindex` in this same codebase already does the right thing: it passes
`wait_for_completion: false` and returns a task id for `get_task`. The pattern
exists; the most dangerous tool is the one not using it.

### P3 — `search` pays a round-trip to break the caller's intent

Every `search` issues two requests: `GET /<index>/_mapping`, then the search.
Measured: 2 requests per call, no caching between calls.

What the round-trip buys is worse than nothing:

- **A caller-supplied `highlight` block is silently overwritten.** Verified: a
  request carrying `pre_tags: ["**"]` reaches the cluster with `["<em>"]`. The
  model's explicit instruction is discarded without a word.
- **Nested text fields are not highlighted.** The scan reads top-level
  `properties` only, so on a mapping with `kubernetes.pod.name` as `text`, that
  field is absent from the highlight block. Verified. On a logging mapping —
  where nesting is the norm — this means the feature mostly does not fire.

So: a mandatory extra request per search, which overrides what the caller asked
for and misses most of the fields it exists to cover.

### P4 — Request timeout and retries are not configurable

`createClientOptions()` sets neither, so both are the client's defaults: 30 s and
3 retries. A legitimate aggregation over a year of daily indices exceeds 30 s
routinely, and there is no way to raise it short of editing the source.

### P5 — `bulk` accepts an unbounded array

`documents: z.array(...)` has no `.max()`. One call can carry any number of
documents, and `bulk` uses `refresh: true`, which is the expensive option. A
model that decides to import 50 000 documents in one call will try.

### P6 — Structured output is still absent

Deferred knowingly from the MCP conformance audit. It matters more now, because
it is the *right* fix for part of P1: a capped `structuredContent` payload with an
`outputSchema` is better than a truncated JSON blob for the tools whose answer is
genuinely tabular — `list_indices`, `list_shards`, `get_index_settings`,
`get_mappings`.

### P7 — Duplication in the register layer

The index-name validator appears twelve times across the three register modules.
The `.describe()` text differs between them on purpose — `"Index name"` versus
`"Exact index name. No wildcard, no comma-separated list."` — so this is a
partial extraction, not a wholesale one: the builder should take the description.

### P8 — `register/dataTools.ts` is 431 lines

Acceptable today: it is declarative, and the file reads as a list. Worth watching
rather than acting on. If the data set grows past roughly twenty tools, split it
by domain (documents / indices / templates) the way the tool sets are already
split by blast radius.

## The plan

Phased so each phase is independently shippable and independently verifiable.
Effort is a rough scale, not a commitment.

### Phase 1 — Bound the output (highest value, do first)

1. **Add a shared output budget.** One helper, `src/outputBudget.ts`: a byte cap
   per tool result, a truncation that keeps the *summary* fragments and trims the
   *detail* fragments, and a final fragment that says plainly what was dropped and
   how to narrow the call — for `list_shards`, "pass an index".
   A silent truncation is worse than a large answer: the model cannot tell that
   what it needed was cut. Effort: medium. Risk: low, additive.
2. **Make the detail dump opt-in for the three list tools.** `list_shards`,
   `list_indices` and `list_nodes` already produce a good summary; the raw JSON
   should be behind a `verbose` parameter, defaulting off. Effort: small. Risk:
   low, but it is a **surface change** for anyone parsing the JSON fragment.
3. **Cap `search` result size.** Clamp `size` to a documented maximum, and say in
   the tool description what the maximum is, so the model paginates instead of
   being silently trimmed. Effort: small.
4. **Add tests that assert the caps hold** with the same 365-index / 2190-shard
   fixtures used above, so the numbers in this document stay true.

### Phase 2 — Correctness of the destructive and long-running paths

5. **Make `delete_by_query` asynchronous**, mirroring `reindex`:
   `wait_for_completion: false`, return the task id, and say in the description
   that the deletion continues in the background and `get_task` follows it.
   Effort: small. Risk: **surface change** — the result no longer carries a
   deleted count, which is the honest outcome rather than a count that may be a
   timeout away from wrong.
6. **Expose `ES_REQUEST_TIMEOUT`** (and consider `ES_MAX_RETRIES`), documented in
   both READMEs, `smithery.yaml` and the `Dockerfile`. Effort: small.
7. **Bound `bulk`.** A `.max()` on the array with a description saying to chunk,
   and consider making `refresh` a parameter rather than always `true` — the
   current behaviour is right for a smoke test and wrong for an import.
   Effort: small.

### Phase 3 — Make `search` earn its round-trip

8. **Never override a caller-supplied `highlight`.** One guard. Effort: trivial,
   and it removes a silent surprise.
9. **Walk nested `properties`** so nested text fields are covered, emitting dotted
   paths. Effort: small.
10. **Cache the mapping per index** for the process lifetime, invalidated by
    nothing — a mapping change mid-session is rare, and the fallback is one stale
    highlight block, not a wrong result. Or, alternatively, make highlighting
    opt-in and skip the request entirely when it is off. Decide between these two
    before implementing: they point in opposite directions on whether
    highlighting is worth a request at all. Effort: medium.

### Phase 4 — Structured output, where it pays

11. **Add `outputSchema` and `structuredContent`** to the four genuinely tabular
    tools only. Measure the `tools/list` cost before and after: the specification
    says the JSON *should also* be returned as text, so this trades payload for
    machine-readability and the trade has to be seen to be judged. Effort:
    medium. Do not do this for the whole set.

### Phase 5 — Housekeeping

12. Extract an `indexName(description)` zod builder (P7).
13. Revisit `dataTools.ts` only if it grows (P8).

## Deliberately not in this plan

- **Rate limiting.** The specification states it as a `MUST`; this server serves
  one local client over stdio, so the client is the trust boundary and a limiter
  would throttle the operator rather than an attacker. Documented as a knowing
  deviation in `CLAUDE.md`. Revisit if a non-stdio transport is ever added — that
  is the change that would make it real.
- **An 8.x client.** Not an upgrade, a re-migration. See `CLAUDE.md`.
- **`listChanged: false`.** Hardcoded by `McpServer`; not reachable through the
  public API, and harmless because the tool list is fixed at startup.

## How to re-measure

The output figures come from driving the built tool functions against
`@elastic/elasticsearch-mock` with generated fixtures: 365 daily indices, 2190
shards, 500 log hits with a realistic message and stack trace. The `tools/list`
figures come from an in-process MCP session over `InMemoryTransport`, summing
`Buffer.byteLength(JSON.stringify(tools))`. Token counts are bytes divided by
four — a rule of thumb, not a tokeniser.

Both harnesses are worth turning into committed scripts as part of Phase 1 item
4, so the next review starts from a re-run rather than a rebuild.
