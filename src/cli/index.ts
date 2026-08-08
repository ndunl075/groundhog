#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { indexCommand } from "./commands/index-repo.ts";
import { syncCommand } from "./commands/sync.ts";
import { askCommand } from "./commands/ask.ts";
import { showCommand } from "./commands/show.ts";
import { statusCommand } from "./commands/status.ts";
import { embedCommand } from "./commands/embed.ts";
import { scheduleCommand } from "./commands/schedule.ts";
import { bold, dim, fail, out } from "./output.ts";
import type { ThreadKind, ThreadState } from "../types.ts";

const VERSION = "0.1.0";

const HELP = `${bold("groundhog")} — local RAG over a repo's issues, PRs, and discussions

${bold("USAGE")}
  groundhog <command> [options]

${bold("COMMANDS")}
  index <owner/repo>     fetch and index a repo's tracker
  sync [owner/repo]      incremental refresh (--all for every indexed repo)
  ask "<question>"       search the index, print ranked evidence
  show <number>          print a full thread
  status                 what is indexed, how fresh, how big
  embed                  enable/disable semantic search
  schedule               keep every index fresh automatically
  serve                  run the MCP server on stdio

${bold("COMMON OPTIONS")}
  --repo <owner/repo>    target a specific repo (default: the repo you're in)
  --json                 machine-readable output
  -h, --help             show help
  -v, --version          show version

${bold("ASK OPTIONS")}
  --limit <n>            results to show (default 8)
  --kind <k>             issue | pr | discussion (repeatable)
  --state <s>            open | closed | merged (repeatable)
  --label <l>            require a label (repeatable)
  --author <login>       thread author
  --since <date>         only threads updated since an ISO date
  --lexical              skip semantic search even when enabled
  --budget <n>           token budget for excerpts (default 4000)

${bold("EXAMPLES")}
  groundhog index vercel/next.js
  groundhog ask "hydration mismatch after upgrading"
  groundhog ask "why was the cache changed" --kind pr --state merged
  groundhog embed --enable
  groundhog schedule --enable --at 09:00
`;

const OPTIONS: NonNullable<ParseArgsConfig["options"]> = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  repo: { type: "string" },
  json: { type: "boolean" },
  limit: { type: "string" },
  budget: { type: "string" },
  kind: { type: "string", multiple: true },
  state: { type: "string", multiple: true },
  label: { type: "string", multiple: true },
  author: { type: "string" },
  since: { type: "string" },
  lexical: { type: "boolean" },
  all: { type: "boolean" },
  full: { type: "boolean" },
  enable: { type: "boolean" },
  disable: { type: "boolean" },
  model: { type: "string" },
  at: { type: "string" },
  embed: { type: "boolean" },
};

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

  const command = positionals[0];

  if (values["version"]) return out(VERSION);
  if (!command || values["help"]) return out(HELP);

  switch (command) {
    case "index":
      return indexCommand({
        repo: positionals[1] ?? asString(values["repo"]),
        limit: asNumber(values["limit"], "--limit"),
        kinds: asKinds(values["kind"]),
        full: true,
        embed: values["embed"] === true,
      });

    case "sync":
      return syncCommand({
        repo: positionals[1] ?? asString(values["repo"]),
        all: values["all"] === true,
        full: values["full"] === true,
      });

    case "ask": {
      const query = positionals.slice(1).join(" ").trim();
      if (!query) fail('ask needs a question, e.g. groundhog ask "why does X fail"');
      return askCommand({
        query,
        repo: asString(values["repo"]),
        limit: asNumber(values["limit"], "--limit"),
        budget: asNumber(values["budget"], "--budget"),
        kind: asKinds(values["kind"]),
        state: asStates(values["state"]),
        label: asStrings(values["label"]),
        author: asString(values["author"]),
        since: asString(values["since"]),
        lexical: values["lexical"] === true,
        json: values["json"] === true,
      });
    }

    case "show": {
      const number = asNumber(positionals[1], "<number>");
      if (number === undefined) fail("show needs a thread number, e.g. groundhog show 1234");
      return showCommand({
        number,
        repo: asString(values["repo"]),
        kind: asKinds(values["kind"])?.[0],
        json: values["json"] === true,
      });
    }

    case "status":
      return statusCommand({ json: values["json"] === true });

    case "embed":
      return embedCommand({
        repo: asString(values["repo"]),
        enable: values["enable"] === true,
        disable: values["disable"] === true,
        model: asString(values["model"]),
      });

    case "schedule":
      return scheduleCommand({
        enable: values["enable"] === true,
        disable: values["disable"] === true,
        at: asString(values["at"]),
      });

    case "serve": {
      // Imported lazily so the MCP SDK never loads for a plain `ask`.
      const { serveCommand } = await import("./commands/serve.ts");
      return serveCommand();
    }

    default:
      fail(`unknown command "${command}". Try: groundhog --help`);
  }
}

// ---- argument coercion -----------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined;
}

function asNumber(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(`${flag} must be a positive number, got "${String(value)}"`);
  return n;
}

const KINDS = new Set<ThreadKind>(["issue", "pr", "discussion"]);
const STATES = new Set<ThreadState>(["open", "closed", "merged"]);

function asKinds(value: unknown): ThreadKind[] | undefined {
  const list = asStrings(value);
  if (!list) return undefined;
  for (const k of list) {
    if (!KINDS.has(k as ThreadKind)) fail(`--kind must be issue, pr, or discussion (got "${k}")`);
  }
  return list as ThreadKind[];
}

function asStates(value: unknown): ThreadState[] | undefined {
  const list = asStrings(value);
  if (!list) return undefined;
  for (const s of list) {
    if (!STATES.has(s as ThreadState)) fail(`--state must be open, closed, or merged (got "${s}")`);
  }
  return list as ThreadState[];
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  if (process.env["GROUNDHOG_DEBUG"] && err instanceof Error) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});

export { main };
