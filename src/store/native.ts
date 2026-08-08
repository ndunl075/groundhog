import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.ts";

const ASSET_NAME = "better_sqlite3.node";

let resolved: string | null | undefined;

/**
 * A `.node` binary cannot be bundled into JavaScript, so the single-file build
 * carries it as a SEA asset and unpacks it next to the indexes on first run.
 *
 * The addon is then loaded here and handed to better-sqlite3 as an object
 * rather than a path: inside a SEA, `require` resolves built-in modules only,
 * so better-sqlite3's own path-based load would fail.
 *
 * Returns undefined outside a SEA, where normal module resolution works.
 */
export function nativeBinding(): object | undefined {
  const file = unpackedBindingPath();
  if (!file) return undefined;

  const module = process.getBuiltinModule?.("node:module") as
    | { createRequire(path: string): (id: string) => unknown }
    | undefined;
  if (!module) return undefined;

  return module.createRequire(process.execPath)(file) as object;
}

function unpackedBindingPath(): string | undefined {
  if (resolved !== undefined) return resolved ?? undefined;

  const sea = loadSeaApi();
  if (!sea?.isSea()) {
    resolved = null;
    return undefined;
  }

  let asset: ArrayBuffer;
  try {
    asset = sea.getAsset(ASSET_NAME);
  } catch {
    // Built without the asset; let better-sqlite3 fail with its own message.
    resolved = null;
    return undefined;
  }

  // Versioned directory: a Groundhog upgrade must not reuse a stale binary.
  const dir = join(dataDir(), "native", `${process.versions["modules"]}-${process.platform}-${process.arch}`);
  const file = join(dir, ASSET_NAME);

  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    // Write-then-rename so a killed first run cannot leave a half-written binary
    // that every later run would try to load.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, Buffer.from(asset));
    renameSync(temp, file);
  }

  resolved = file;
  return file;
}

interface SeaApi {
  isSea(): boolean;
  getAsset(name: string): ArrayBuffer;
}

function loadSeaApi(): SeaApi | null {
  // Not a static import: `node:sea` only exists in newer Node, and the bundler
  // must not treat it as a hard dependency. getBuiltinModule works identically
  // in ESM and in the CJS bundle the .exe is built from, unlike require().
  try {
    return (process.getBuiltinModule?.("node:sea") as SeaApi | undefined) ?? null;
  } catch {
    return null;
  }
}
