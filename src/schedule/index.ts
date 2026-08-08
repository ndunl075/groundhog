import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

const run = promisify(execFile);

export const TASK_NAME = "GroundhogSync";

/** Early enough to be fresh before the workday, late enough that laptops are on. */
export const DEFAULT_TIME = "07:00";
const LAUNCHD_LABEL = "dev.groundhog.sync";
const SYSTEMD_UNIT = "groundhog-sync";

export interface ScheduleOptions {
  /** 24-hour local time, "HH:MM". */
  at?: string;
}

export interface ScheduleStatus {
  installed: boolean;
  /** How the schedule is registered on this OS, for the user to verify by hand. */
  mechanism: string;
  detail?: string;
}

/**
 * Installs an OS-native scheduled task that runs `groundhog sync --all` once a
 * day.
 *
 * Deliberately not a daemon: Groundhog should cost nothing when you are not
 * using it, and a resident process to run a two-second job once a day is a bad
 * trade. The OS already has a scheduler, and it survives reboots.
 */
export async function installSchedule(opts: ScheduleOptions = {}): Promise<ScheduleStatus> {
  const at = normalizeTime(opts.at ?? DEFAULT_TIME);
  const [hour, minute] = at.split(":") as [string, string];
  const command = syncCommand();

  switch (process.platform) {
    case "win32":
      return installWindows(command, at);
    case "darwin":
      return installLaunchd(command, Number(hour), Number(minute));
    default:
      return installSystemd(command, at);
  }
}

export async function removeSchedule(): Promise<ScheduleStatus> {
  switch (process.platform) {
    case "win32":
      await quiet(["schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]]);
      return { installed: false, mechanism: "Windows Task Scheduler" };
    case "darwin": {
      const plist = launchdPath();
      await quiet(["launchctl", ["unload", "-w", plist]]);
      rmSync(plist, { force: true });
      return { installed: false, mechanism: "launchd" };
    }
    default: {
      await quiet(["systemctl", ["--user", "disable", "--now", `${SYSTEMD_UNIT}.timer`]]);
      rmSync(systemdPath("timer"), { force: true });
      rmSync(systemdPath("service"), { force: true });
      await quiet(["systemctl", ["--user", "daemon-reload"]]);
      return { installed: false, mechanism: "systemd user timer" };
    }
  }
}

export async function scheduleStatus(): Promise<ScheduleStatus> {
  switch (process.platform) {
    case "win32": {
      const result = await quiet(["schtasks", ["/Query", "/TN", TASK_NAME]]);
      return {
        installed: result.ok,
        mechanism: "Windows Task Scheduler",
        ...(result.ok ? { detail: `task "${TASK_NAME}"` } : {}),
      };
    }
    case "darwin":
      return {
        installed: existsSync(launchdPath()),
        mechanism: "launchd",
        detail: launchdPath(),
      };
    default:
      return {
        installed: existsSync(systemdPath("timer")),
        mechanism: "systemd user timer",
        detail: systemdPath("timer"),
      };
  }
}

/**
 * How to invoke this same Groundhog again later.
 *
 * Resolved from the running process rather than by looking for `groundhog` on
 * PATH: the scheduler runs in a different environment, where a shim installed
 * by npm link or nvm may not resolve.
 */
export function syncCommand(): { exe: string; args: string[] } {
  const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
  if (sea?.isSea?.()) {
    return { exe: process.execPath, args: ["sync", "--all"] };
  }

  const script = process.argv[1];
  if (!script) {
    throw new Error("Cannot determine how Groundhog was launched, so it cannot be scheduled.");
  }
  return { exe: process.execPath, args: [script, "sync", "--all"] };
}

// ---- platforms -------------------------------------------------------------

async function installWindows(
  command: { exe: string; args: string[] },
  at: string,
): Promise<ScheduleStatus> {
  // schtasks takes the whole invocation as one /TR string, so the inner paths
  // carry their own quotes.
  const tr = [command.exe, ...command.args]
    .map((part) => (part.includes(" ") ? `"${part}"` : part))
    .join(" ");

  await must(
    ["schtasks", ["/Create", "/TN", TASK_NAME, "/TR", tr, "/SC", "DAILY", "/ST", at, "/F"]],
    "Windows Task Scheduler refused the task",
  );
  return { installed: true, mechanism: "Windows Task Scheduler", detail: `task "${TASK_NAME}" at ${at}` };
}

async function installLaunchd(
  command: { exe: string; args: string[] },
  hour: number,
  minute: number,
): Promise<ScheduleStatus> {
  const path = launchdPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });

  const args = [command.exe, ...command.args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");

  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`,
  );

  await quiet(["launchctl", ["unload", "-w", path]]); // ignore "not loaded"
  await must(["launchctl", ["load", "-w", path]], "launchctl refused the job");
  return { installed: true, mechanism: "launchd", detail: path };
}

async function installSystemd(
  command: { exe: string; args: string[] },
  at: string,
): Promise<ScheduleStatus> {
  const dir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });

  const exec = [command.exe, ...command.args].map(shellQuote).join(" ");
  writeFileSync(
    systemdPath("service"),
    `[Unit]\nDescription=Groundhog incremental sync\n\n[Service]\nType=oneshot\nExecStart=${exec}\n`,
  );
  writeFileSync(
    systemdPath("timer"),
    `[Unit]\nDescription=Groundhog daily sync\n\n[Timer]\nOnCalendar=*-*-* ${at}:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  );

  await must(["systemctl", ["--user", "daemon-reload"]], "systemd is not available for your user");
  await must(
    ["systemctl", ["--user", "enable", "--now", `${SYSTEMD_UNIT}.timer`]],
    "systemd refused the timer",
  );
  return { installed: true, mechanism: "systemd user timer", detail: systemdPath("timer") };
}

// ---- helpers ---------------------------------------------------------------

function launchdPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function systemdPath(kind: "service" | "timer"): string {
  return join(homedir(), ".config", "systemd", "user", `${SYSTEMD_UNIT}.${kind}`);
}

export function normalizeTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`--at expects a 24-hour time like 09:00, got "${value}"`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`"${value}" is not a valid time of day`);

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shellQuote(value: string): string {
  return /[^\w@%+=:,./-]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}

async function quiet(
  cmd: [string, string[]],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(cmd[0], cmd[1], { windowsHide: true });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
  }
}

async function must(cmd: [string, string[]], context: string): Promise<void> {
  const result = await quiet(cmd);
  if (!result.ok) {
    throw new Error(`${context}: ${(result.stderr || result.stdout).trim() || "unknown error"}`);
  }
}
