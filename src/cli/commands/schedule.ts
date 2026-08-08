import {
  installSchedule,
  removeSchedule,
  scheduleStatus,
  syncCommand,
} from "../../schedule/index.ts";
import { listIndexedRepos } from "../../store/paths.ts";
import { bold, dim, green, out, yellow } from "../output.ts";

export interface ScheduleArgs {
  enable?: boolean;
  disable?: boolean;
  at?: string | undefined;
}

/** `groundhog schedule --enable` — keep every index fresh without a daemon. */
export async function scheduleCommand(args: ScheduleArgs): Promise<void> {
  if (args.disable) {
    const status = await removeSchedule();
    out(`Automatic sync disabled (${status.mechanism}).`);
    return;
  }

  if (!args.enable) {
    const status = await scheduleStatus();
    out(
      status.installed
        ? `${green("enabled")} · ${status.mechanism}${status.detail ? ` · ${status.detail}` : ""}`
        : `${yellow("disabled")} · run ${bold("groundhog schedule --enable")} to sync daily`,
    );
    return;
  }

  const status = await installSchedule(args.at ? { at: args.at } : {});
  const repos = listIndexedRepos().length;
  const { exe, args: cmdArgs } = syncCommand();

  out(`${green("Automatic sync enabled")} · ${status.mechanism}`);
  if (status.detail) out(dim(`  ${status.detail}`));
  out(dim(`  runs: ${[exe, ...cmdArgs].join(" ")}`));
  out(
    dim(
      `  refreshes ${repos} indexed repo${repos === 1 ? "" : "s"} daily, ~2s each; nothing runs in between`,
    ),
  );
}
