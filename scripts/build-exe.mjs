#!/usr/bin/env node
/**
 * Builds a single-file `groundhog` executable using Node's SEA support.
 *
 * Three steps, because a .node binary cannot live inside JavaScript:
 *   1. esbuild bundles the CLI into one CommonJS file (SEA requires CJS).
 *   2. better_sqlite3.node rides along as a SEA asset, unpacked on first run
 *      (see src/store/native.ts).
 *   3. postject injects the blob into a copy of the node binary.
 *
 * Semantic search is not included: onnxruntime ships its own native libraries,
 * which would multiply the binary size for a feature that is opt-in anyway.
 * The executable is lexical-only; `npm i -g groundhog-rag` gets you both.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(root, "build");

const isWindows = process.platform === "win32";
const exeName = isWindows ? "groundhog.exe" : "groundhog";
const outFile = join(build, exeName);

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
}

function step(message) {
  process.stdout.write(`\n▸ ${message}\n`);
}

rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });

// ---- 1. bundle -------------------------------------------------------------

step("Bundling CLI");
run(process.execPath, [
  require.resolve("esbuild/bin/esbuild"),
  "src/cli/index.ts",
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=cjs",
  `--outfile=${join(build, "groundhog.cjs")}`,
  // The .node binary is an asset, not a module; `bindings` is only reached
  // when nativeBinding is absent, which never happens inside the SEA.
  "--external:better_sqlite3.node",
  "--external:bindings",
  // Optional and native-heavy: left out on purpose, see the header.
  "--external:@huggingface/transformers",
  "--external:onnxruntime-node",
  "--external:sharp",
  "--log-level=warning",
]);

// ---- 2. SEA blob -----------------------------------------------------------

step("Locating better_sqlite3.node");
const nativeSource = require
  .resolve("better-sqlite3")
  .replace(/lib[\\/]index\.js$/, join("build", "Release", "better_sqlite3.node"));
statSync(nativeSource); // fail loudly if the prebuild is missing
process.stdout.write(`  ${nativeSource}\n`);

writeFileSync(
  join(build, "sea-config.json"),
  JSON.stringify(
    {
      main: join(build, "groundhog.cjs"),
      output: join(build, "sea-prep.blob"),
      disableExperimentalSEAWarning: true,
      assets: { "better_sqlite3.node": nativeSource },
    },
    null,
    2,
  ),
);

step("Generating SEA blob");
run(process.execPath, ["--experimental-sea-config", join(build, "sea-config.json")]);

// ---- 3. inject -------------------------------------------------------------

step("Copying node binary");
copyFileSync(process.execPath, outFile);

if (isWindows) {
  // Signatures do not survive injection; remove ours before postject adds the blob.
  try {
    run("signtool", ["remove", "/s", outFile], { stdio: "ignore" });
  } catch {
    // signtool is absent on most machines and unsigned node needs no removal.
  }
}

step("Injecting blob");
const postjectArgs = [
  outFile,
  "NODE_SEA_BLOB",
  join(build, "sea-prep.blob"),
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
run(process.execPath, [require.resolve("postject/dist/cli.js"), ...postjectArgs]);

if (process.platform === "darwin") {
  step("Re-signing (ad hoc)");
  try {
    run("codesign", ["--sign", "-", outFile]);
  } catch {
    process.stdout.write("  codesign unavailable; the binary may not run on this Mac\n");
  }
}

const size = statSync(outFile).size;
process.stdout.write(
  `\n✓ ${outFile}  (${(size / 1024 / 1024).toFixed(1)} MB)\n` +
    `  Try it:  ${isWindows ? outFile : `./${exeName}`} --help\n`,
);

// Keep the intermediates out of the release artifact.
rmSync(join(build, "sea-prep.blob"), { force: true });
rmSync(join(build, "sea-config.json"), { force: true });
readFileSync(outFile); // final sanity read
