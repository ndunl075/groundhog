# Groundhog — Architecture

Local RAG over a git repo's **issues, pull requests, and discussions**. Point it at a repo, it
indexes every thread into a local SQLite file, and answers "has anyone hit this before?" from your
terminal or from any MCP client. Nothing you search leaves your machine.

## 1. Design constraints

| Constraint | Consequence |
|---|---|
| No cloud inference | Retrieval is lexical + local embeddings. No API keys, no telemetry. Only network call is to the forge API to *fetch* threads. |
| Must not slow the PC down | No daemon, no watcher, no resident process. Work happens only during an explicit `index`/`sync`, or a ~2s daily job the *OS* scheduler runs. Idle cost of the MCP server ≈ one blocked stdio read. |
| Scoped to the tracker, not the code | Documents are threads (issue/PR/discussion + comments + reviews), never source files. Ranking signals are tracker-native: state, labels, linked commits, resolution. |
| Cloneable *and* shippable as one file | Pure-TS core, one native dependency, packaged both as an npm bin and a Node SEA `.exe`. |

## 2. Stack

- **Node 22 + TypeScript**, ESM. Node 22 is the floor (`node:test`, SEA, stable worker APIs).
- **better-sqlite3** — synchronous, in-process, FTS5 compiled in. The only native dependency.
- **@huggingface/transformers** (transformers.js) — *optional*, lazy-installed. Runs
  `all-MiniLM-L6-v2` (int8, ~23 MB) on CPU via ONNX Runtime for embeddings.
- No vector database. No LangChain. No server framework.

Without the optional embedding model Groundhog still works — it degrades to BM25-only, which is
already strong on issue trackers because bug reports repeat each other's *exact* error strings.

## 3. Data flow

```
forge API ──► ingest ──► normalize ──► SQLite (threads, messages)
                                          │
                                          ├─► chunk ──► fts5 index        (always)
                                          └─► chunk ──► embed ──► vectors (optional)

query ──► BM25 ─┐
                ├─► RRF fuse ──► thread rollup ──► context pack ──► CLI / MCP tool result
       ──► kNN ─┘
```

## 4. Modules

```
src/
  store/        schema.ts  migrate.ts  db.ts        SQLite open, PRAGMAs, migrations
  ingest/       github.ts  types.ts    sync.ts      forge adapters + incremental cursor
  index/        chunk.ts   embed.ts    build.ts     chunking, in-process embedding
  search/       bm25.ts    vector.ts   fuse.ts      retrieval + RRF + rollup
  pack/         context.ts                          evidence formatting, token budget
  cli/          index.ts   commands/                the `groundhog` binary
  mcp/          server.ts  tools.ts                 stdio MCP server
  schedule/     index.ts                             OS-native daily sync task
  freshness.ts                                       index age + staleness notices
```

Dependency direction is strictly downward: `mcp` and `cli` both depend on `search`/`ingest`; nothing
below depends on them. That is what makes the MCP server a thin shell.

## 5. Storage

One database per repo: `<data-dir>/repos/<host>/<owner>/<name>/index.db`.

- Windows `%LOCALAPPDATA%\groundhog` · macOS `~/Library/Application Support/groundhog` ·
  Linux `$XDG_DATA_HOME/groundhog`
- WAL mode, `synchronous=NORMAL`, 64 MB page cache, `mmap_size=256MB`.

### Schema

```sql
thread(id, number, kind, title, body, state, author, labels, created_at, updated_at,
       closed_at, merged, url, resolution_ref)      -- kind: issue|pr|discussion
message(id, thread_id, kind, author, body, created_at, url)
                                                    -- kind: comment|review|review_comment
chunk(id, thread_id, message_id, ord, text, token_est)
chunk_fts(text)                                     -- FTS5, external-content, porter unicode61
vector(chunk_id, dim, data BLOB)                    -- float32; absent when embeddings are off
meta(key, value)                                    -- schema version, sync cursor, model id
```

`chunk_fts` is external-content over `chunk`, kept in sync by triggers — the text is stored once.

### Vectors

Vectors live in a `BLOB` column, loaded once into a single contiguous `Float32Array` at first query
and cached for the process lifetime. A repo with 20 k chunks × 384 dims = **31 MB** — brute-force
cosine over that is ~15 ms. An ANN index would add a dependency and a build step to save nothing at
this scale, so there isn't one. Above ~250 k chunks the loader falls back to streaming scan.

## 6. Ingestion

GitHub via **GraphQL** (v4), one paginated query per thread kind, 25 threads per page, 40 comments
fetched inline; longer threads are backfilled over REST from page 1 and merged by node id, since
the two APIs return the same comments under the same ids and `message.id` is a primary key. Auth resolves in order:
`GITHUB_TOKEN` → `gh auth token` → unauthenticated (60 req/h, enough to try it on a small repo).

**Incremental sync.** `meta.sync_cursor` stores the max `updated_at` seen per kind. `sync` requests
threads ordered by `UPDATED_AT DESC` and stops at the first page whose oldest node predates the
cursor. A daily sync on a busy repo is a handful of requests; only touched threads are re-chunked
and re-embedded.

Rate limits are handled by reading `X-RateLimit-Remaining` and sleeping to reset rather than
retrying blindly. Ingestion is resumable — the cursor advances only after a page commits.

The `Forge` interface (`listThreads`, `listMessages`, `cursorFor`) is the seam for GitLab/Gitea
later. GitHub is the only implementation at v1.

## 7. Chunking

Threads are not prose, and splitting them like prose destroys them. Rules:

1. **Head chunk** = title + issue body, to 1 200 tokens; a longer body overflows into follow-on
   chunks rather than being dropped. Always retrievable alone — most "has anyone hit this"
   matches are body-to-body.
2. **Message chunks** = consecutive comments packed to ~800 tokens, never splitting a comment
   across chunks unless it exceeds the budget alone.
3. **Code fences are kept whole** where possible. Stack traces are the highest-signal text in a
   tracker; a trace cut in half matches nothing.
4. Bot noise (`[bot]` authors, CI status dumps, `codecov` tables) is dropped at chunk time, not at
   ingest — the raw thread stays intact so the rule can change without a re-fetch.

Every chunk carries `thread_id`, so retrieval always rolls back up to a whole thread.

## 8. Retrieval

Two independent recall paths, fused:

- **BM25** over `chunk_fts`. The query is sanitized for FTS5 syntax and issue-style tokens
  (`#1234`, `ENOENT`, `at Object.<anonymous>`) are preserved as phrases.
- **Vector kNN** — cosine over the cached matrix, top 50.

Fused with **Reciprocal Rank Fusion** (`k=60`), which needs no score calibration between the two
scales. Then **thread rollup**: chunks collapse to their thread, a thread scores as its best chunk
plus a damped sum of the rest, so a thread that matches in five places outranks a one-line fluke.

Tracker-native boosts applied after fusion:

| Signal | Effect | Why |
|---|---|---|
| `state = closed` + linked commit/PR | ×1.15 | A resolved thread is the answer, not just an echo. |
| Exact error-string / traceback match | ×1.3 | Strongest duplicate signal there is. |
| Recency | mild decay over 24 mo | Old threads still matter; stale ones shouldn't win ties. |
| `kind = pr` when query looks like "why was X changed" | ×1.1 | Intent routing. |

Filters (`state`, `label`, `kind`, `author`, `since`) are pushed into SQL before ranking.

## 9. Context packing

Results return as **evidence, not prose**. Groundhog runs no LLM — the caller (your MCP client, or
your eyes) is the model. Each hit yields: thread number, title, state, resolution, the matched
excerpt with the query terms in context, and the URL. A token budget (default 4 000) fills
breadth-first across threads before depth within one, so five relevant issues beat one issue quoted
at length.

## 10. Interfaces

### CLI

```
groundhog index <owner/repo>     first full index
groundhog sync [repo]            incremental; --all for every indexed repo
groundhog ask "<question>"       search, print ranked evidence
groundhog show <number>          full reconstructed thread
groundhog status                 repos, thread counts, last sync, db size
groundhog serve                  start the MCP server on stdio
groundhog embed --enable         download the model, backfill vectors
groundhog schedule --enable      register a daily OS-level sync task
```

### MCP server

stdio transport, registered in any MCP client with
`{"command":"groundhog","args":["serve"]}`.

| Tool | Purpose |
|---|---|
| `search_threads` | Hybrid search. Args: `query`, `repo?`, `kind?`, `state?`, `label?`, `limit?` |
| `get_thread` | Full thread by number, comments in order |
| `find_similar` | Paste an error or description, get prior threads that match it |
| `sync_repo` | Incremental refresh |
| `list_repos` | What's indexed, with freshness |

Read-only except `sync_repo`. The server holds one open DB handle per repo, opened lazily and
closed after idle.

## 11. Performance budget

Targets on a mid-range laptop, measured against a 5 000-thread repo:

| Operation | Target |
|---|---|
| Cold full index, BM25 only | < 90 s (API-bound) |
| Embedding backfill, 20 k chunks | < 6 min (~18 chunks/s measured) |
| Incremental sync, quiet repo | ~2 s, a handful of API calls |
| Incremental sync, quiet day | < 3 s |
| Query, BM25 only | < 20 ms |
| Query, hybrid, warm | < 60 ms |
| MCP server RSS, idle | < 60 MB |
| MCP server RSS, embeddings loaded | < 300 MB |

Embedding runs in-process, in batches. ONNX Runtime executes inference on its own native thread
pool, so the event loop stays free without a worker thread — which also keeps the single-file `.exe`
build simple, since spawning workers out of a SEA is not. The model is loaded lazily and only when a
repo actually has vectors, so a Groundhog that never enabled embeddings never pays the ~150 MB.

No file watchers, no timers, no resident process — Groundhog uses zero CPU when you aren't asking it
something.

**Freshness** is handled by the OS scheduler rather than a daemon: `groundhog schedule --enable`
registers a Task Scheduler entry, launchd agent, or systemd user timer that runs `sync --all` daily.
A two-second job once a day does not justify a resident process, and the OS scheduler already
survives reboots. Whenever the schedule has not kept up, staleness is surfaced at every point
results are shown — CLI and MCP alike — because a tracker answer is only as good as its last sync,
and `no matches` is the conclusion a stale index gets wrong in the direction that matters.

## 12. Distribution

- **Clone / npm** — `npm i -g groundhog-rag`, `better-sqlite3` builds from prebuilt binaries.
  This is the full build: lexical *and* semantic search.
- **`.exe`** — Node SEA, ~85 MB, no Node install required. esbuild bundles the CLI to one CJS file;
  the `better-sqlite3` `.node` binary rides along as a SEA asset and is unpacked to the data dir on
  first run. Because SEA's `require` resolves built-ins only, the addon is loaded through
  `createRequire` and handed to better-sqlite3 as an *object* rather than a path.

  The executable is **lexical-only**. ONNX Runtime ships its own native libraries per platform, and
  bundling them would multiply the binary size for a feature that is opt-in even in the full build.
- GitHub Actions tests on Linux/macOS/Windows and builds the three executables on tag.

## 13. Privacy and security

Fetched thread content, embeddings, and queries live only in the local SQLite file. There is no
analytics, no crash reporting, no update ping. The single outbound destination is the forge API you
pointed it at, and `groundhog ask` never touches the network at all.

Two boundaries are enforced rather than assumed, because a repo ref is attacker-reachable — it can
arrive as an MCP tool argument that originated in an issue body or a web page:

| Boundary | Enforcement |
|---|---|
| Owner/name become filesystem paths | Strict charset; `.`, `..` and separators rejected at parse time, so a ref cannot escape the data dir. |
| Fetches carry the GitHub token | Destination host allowlisted to `github.com`; others need an explicit `GROUNDHOG_ALLOWED_HOSTS`. Checked in the forge constructor, before any request path exists. |
| Filters and query text reach SQLite | Bound parameters only. FTS5 input is emitted as quoted phrases, which is both the escape and the identifier-matching mechanism. |

Indexes are stored unencrypted: a private repo's threads sit in a plain SQLite file, and should be
treated like a local clone of that repo.

## 14. Build order

1. Scaffold, TS config, license, this document
2. Store — schema, migrations, PRAGMAs
3. Ingest — GitHub GraphQL adapter, incremental cursor
4. Chunker
5. BM25 search over FTS5
6. Embeddings + vector kNN + RRF fusion
7. Context packing + ranking boosts
8. CLI
9. MCP server
10. Packaging + CI

Each step ships as its own commit and is usable on its own — after step 5 Groundhog is already a
working local issue search engine.
