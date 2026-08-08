import { Store } from "../../store/db.ts";
import { renderThread } from "../../pack/context.ts";
import type { ThreadKind } from "../../types.ts";
import { resolveRepo } from "../repo.ts";
import { out } from "../output.ts";

export interface ShowArgs {
  number: number;
  repo?: string | undefined;
  kind?: ThreadKind | undefined;
  json?: boolean;
}

/** `groundhog show <number>` — the full thread, reconstructed offline. */
export function showCommand(args: ShowArgs): void {
  const repo = resolveRepo(args.repo);
  const store = Store.open(repo, { readonly: true });

  try {
    const thread = store.getThreadByNumber(args.number, args.kind);
    if (!thread) {
      throw new Error(
        `#${args.number} is not in the index for ${repo.owner}/${repo.name}. Try: groundhog sync`,
      );
    }

    if (args.json) {
      out(JSON.stringify({ ...thread, messages: store.getMessages(thread.id) }, null, 2));
      return;
    }
    out(renderThread(store, thread));
  } finally {
    store.close();
  }
}
