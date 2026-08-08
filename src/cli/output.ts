/** ANSI helpers. Colour is opt-out via NO_COLOR and off whenever stdout is piped. */

const enabled =
  process.stdout.isTTY === true &&
  !process.env["NO_COLOR"] &&
  process.env["TERM"] !== "dumb";

function wrap(open: number, close: number) {
  return (text: string): string =>
    enabled ? `[${open}m${text}[${close}m` : text;
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);

export function stateColor(state: string): (text: string) => string {
  if (state === "open") return green;
  if (state === "merged") return magenta;
  return dim;
}

/** Rewrites one line in place on a TTY; stays silent when piped. */
export function progress(line: string): void {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`\r[2K${line}`);
}

export function endProgress(): void {
  if (process.stderr.isTTY) process.stderr.write("\r[2K");
}

export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function info(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function fail(message: string): never {
  process.stderr.write(`${red("error")} ${message}\n`);
  process.exit(1);
}

export function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function humanAge(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
