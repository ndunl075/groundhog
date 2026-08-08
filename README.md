<p align="center">
  <img src="./assets/groundhog-logo.png" alt="Groundhog logo" width="240" />
</p>

# 🦫 Groundhog

**Local RAG over any git repo's issues, PRs, and discussions.** No cloud.

Point it at a repo. It indexes every issue, pull request, and discussion thread into a local SQLite
file, then answers *"has anyone hit this bug before?"* without you leaving the terminal — and
without sending your queries anywhere.

Most RAG tools index the code and ignore the tracker. The tracker is where the answers are.

```
$ groundhog index vercel/next.js
$ groundhog ask "hydration mismatch after upgrading to app router"

#41930  Hydration failed because the initial UI does not match     closed · fixed in #42011
        "…this happens when a Server Component reads Date.now()…"

#43112  App Router: text content does not match server-rendered    closed
        "…same root cause as #41930, the culprit was a browser extension…"
```

## Why not just let the agent read GitHub?

Because reading GitHub is expensive, and searching it doesn't work.

Same question, same three threads, measured on `sindresorhus/execa`:

| | tokens |
|---|---|
| Agent opens the 3 issues via the GitHub API | **7,705** |
| Groundhog's packed evidence | **520** |

**~15× less context for the same answer** — and that is the *generous* comparison, because it
assumes the agent already knew which three issues to open.

It usually doesn't. `gh search issues "kill child processes"` on that repo returns **nothing**:
GitHub matches keywords against titles and bodies, and the thread you want is titled *"Ability to
kill all descendents of the child process"*, with the actual answer eleven comments down. Groundhog
finds it because it indexes every comment, ranks with BM25 (plus optional embeddings), and pushes
threads that were actually *resolved* to the top.

So the agent gets 520 tokens of quotes **plus the issue numbers and URLs**, and pulls a full thread
only when it genuinely needs one — instead of paying 4,077 tokens for a thread up front on the
chance it's relevant. The budget is capped (`--budget`, default 4000), so a search can never blow
out a context window. A raw issue fetch on a 226-comment thread absolutely can.

The index is paid for once. After that, every query costs **zero API calls**, hits no rate limit,
runs in milliseconds, and works offline.

*Reproduce it: `groundhog ask "kill child processes" --limit 3` against
`gh issue view <n> --comments` for the same numbers.*

## Status

v0.1 — everything below works end to end. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

## Install

```
npm i -g groundhog-rag
```

Or clone it:

```
git clone https://github.com/ndunl075/groundhog.git
cd groundhog && npm install && npm run build && npm link
```

Or grab a standalone binary from the
[releases page](https://github.com/ndunl075/groundhog/releases) — no Node install required. The
standalone build does exact-word search; semantic search needs the npm install, because the
embedding runtime ships platform-specific native libraries too large to bundle.

## Use

```
groundhog index <owner/repo>     first full index
groundhog sync                   incremental refresh
groundhog ask "<question>"       ranked evidence from prior threads
groundhog show <number>          full reconstructed thread
groundhog status                 what's indexed, how fresh
groundhog schedule --enable      refresh every index daily (no daemon)
groundhog serve                  MCP server on stdio
```

Set `GITHUB_TOKEN`, or just be logged into `gh` — Groundhog picks the token up automatically.
Unauthenticated works too, at GitHub's 60 req/h.

## As an MCP server

```json
{
  "mcpServers": {
    "groundhog": { "command": "groundhog", "args": ["serve"] }
  }
}
```

Gives your assistant five tools:

| Tool | What the agent uses it for |
|---|---|
| `find_similar` | Paste an error or stack trace — "has anyone hit this?" |
| `search_threads` | Question-shaped search, filtered by kind / state / label / author |
| `get_thread` | Read one thread in full, every comment in order |
| `list_repos` | What's indexed locally, and how fresh |
| `sync_repo` | Refresh — the only one that touches the network |

The server runs as a child process over stdio: no port, no daemon, nothing left running. Results
come back as **evidence, not conclusions** — quotes, state, whether it got fixed, and the link.
Groundhog runs no LLM, because the agent calling it already is one.

## Staying fresh

An index frozen at install time misses exactly the issues you are most likely to hit. So:

```
groundhog schedule --enable --at 07:00
```

That registers an **OS-native scheduled task** — Windows Task Scheduler, launchd, or a systemd user
timer — that runs `groundhog sync --all` once a day at the time you name (default 07:00). A quiet
refresh takes about two seconds and a handful of API calls. Nothing runs in between: there is no
daemon and no resident process.

If the schedule has not run — laptop was off, say — `ask` and `status` tell you how old the index is
rather than letting stale results look authoritative:

```
Index last synced 5 days ago — newer threads are missing. Run: groundhog sync owner/repo
```

The MCP tools report it too, and specifically on a *zero-result* search, since "nobody has reported
this" is the conclusion a stale index gets wrong in the direction that matters.

| | |
|---|---|
| `groundhog schedule` | show current state |
| `groundhog schedule --enable --at HH:MM` | enable, or change the time |
| `groundhog schedule --disable` | remove it |

## Why it's light

No daemon, no file watcher, no resident process — zero CPU when idle. Freshness is a ~2 s job the OS
scheduler runs once a day, then exits.

Search is SQLite FTS5, which is plenty on its own because bug reports quote each other's exact error
strings. Semantic search is **optional**: `groundhog embed --enable` downloads a 23 MB int8 MiniLM
that runs on CPU, loaded lazily and only when a repo actually has vectors. Nothing is ever sent to
an inference API, because there isn't one.

## Privacy and security

Your queries never leave the machine — `groundhog ask` makes no network calls at all. The only
outbound requests are to the forge API, to fetch threads. No telemetry, no update pings.

**Where your token can go.** Fetch requests carry your GitHub token, so the destination is
allowlisted rather than merely sanitized — `github.com` only, by default. A repo ref can arrive as
an MCP tool argument, which may have originated in an issue body or a web page, so
`groundhog sync evil.example.com/a/b` must not be able to post your credentials to a stranger.
GitHub Enterprise users opt their own host in:

```
GROUNDHOG_ALLOWED_HOSTS=ghe.mycorp.com
```

**Where your data goes.** Owner and repo names become path segments under the data directory, so
they are validated against a strict charset; `../..` is rejected rather than followed. Search
filters and query text reach SQLite only as bound parameters, never as SQL text.

**What's on disk.** Indexed threads are stored unencrypted in your data directory. If you index a
private repo, its contents sit in a plain SQLite file — treat it like a local clone of the repo.

Production dependencies audit clean. Run `npm audit` yourself.

## Developing

```
npm test            # 97 tests, no network needed
npm run typecheck
npm run build       # tsc -> dist/
npm run build:exe   # single-file binary -> build/
```

Tests run straight off the TypeScript source via Node's type stripping, so there's no build step in
the edit-test loop.

## Brand assets

The reusable logo and favicon files live in [`assets/`](./assets/):

- `groundhog-logo.png` — transparent 1024px master for documentation and product UI
- `favicon.ico`, `favicon-16.png`, and `favicon-32.png` — browser icons
- `apple-touch-icon.png` — 180px Apple touch icon
- `icon-192.png` and `icon-512.png` — app and PWA icon sizes

## License

MIT
