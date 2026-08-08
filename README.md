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

Gives your assistant five tools: `search_threads`, `get_thread`, `find_similar`, `sync_repo`,
`list_repos`.

## Staying fresh

An index frozen at install time misses exactly the issues you are most likely to hit. So:

```
groundhog schedule --enable --at 09:00
```

That registers an **OS-native scheduled task** — Windows Task Scheduler, launchd, or a systemd user
timer — that runs `groundhog sync --all` once a day. A quiet refresh takes about two seconds and a
handful of API calls. Nothing runs in between: there is no daemon and no resident process.

If the schedule has not run — laptop was off, say — `ask` and `status` tell you how old the index is
rather than letting stale results look authoritative. The MCP tools report it too, so an assistant
knows to sync before concluding nobody has reported your bug.

`groundhog schedule` alone shows the current state; `--disable` removes it.

## Why it's light

No daemon, no file watcher, no resident process — zero CPU when idle; freshness is a ~2s job the OS
scheduler runs once a day. Search is SQLite FTS5, which
is plenty on its own because bug reports quote each other's exact error strings. Semantic search is
**optional**: `groundhog embed --enable` downloads a 23 MB int8 MiniLM that runs on CPU, loaded
lazily and only when a repo actually has vectors. Nothing is ever sent to an inference API, because there isn't one.

## Privacy

Your queries never leave the machine — `groundhog ask` makes no network calls at all. The only
outbound requests are to the forge API you pointed it at, to fetch the threads. No telemetry, no
update pings.

## Developing

```
npm test            # 75 tests, no network needed
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
