#!/usr/bin/env node
// Builds one standalone OpenSpec executable for the standalone-binaries
// experiment (#2055, #1989). Run `pnpm build` first.
//
//   node scripts/standalone/build.mjs bun        # bun >= 1.4 on PATH
//   node scripts/standalone/build.mjs deno       # deno >= 2.1 on PATH
//   node scripts/standalone/build.mjs node-sea   # Node >= 25.5 (--build-sea), bun on PATH to bundle
//   node scripts/standalone/build.mjs manifest   # only the built-in schema manifest
//
// Writes dist-standalone/<tool>/openspec[.exe] and
// dist-standalone/results/build-<tool>.json (commands, versions, error).
//
// How each build ships the built-in schemas (schemas/):
// - bun: `--asset ./schemas` embeds the tree under import.meta.dir.
//   entry-bun.mjs registers that directory and the manifest's schema names
//   with src/core/artifact-graph/builtin-schemas.ts.
// - deno: `--include schemas`. Deno's virtual file system keeps the package
//   layout and can list directories, so bin/openspec.js runs unchanged. Deno
//   embeds the whole node_modules tree, so CI installs production
//   dependencies only before this step; a local run embeds dev dependencies too.
// - node-sea: the files become sea-config `assets`. entry-sea.mjs copies them
//   out with sea.getAsset() into a per-user cache directory and registers it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  binaryPath,
  excerpt,
  outRoot,
  packageVersion,
  repoRoot,
  resultsDir,
  runnerInfo,
  TOOLS,
  writeJson,
} from './lib.mjs';

const manifestPath = path.join(outRoot, 'builtin-schemas.json');

/** Path relative to the repo root with forward slashes, for readable commands. */
const rel = (file) => path.relative(repoRoot, file).split(path.sep).join('/');

/**
 * The build-time manifest of the built-in schemas: their names (what the
 * resolver would otherwise get by listing schemas/), every file as a
 * schemas/-relative path, and a content hash that keys the SEA's unpacked copy.
 */
function writeManifest() {
  const schemasDir = path.join(repoRoot, 'schemas');
  const byName = (a, b) => a.name.localeCompare(b.name);
  const names = fs
    .readdirSync(schemasDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(schemasDir, entry.name, 'schema.yaml')))
    .sort(byName)
    .map((entry) => entry.name);

  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      const relPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      else if (entry.isFile()) files.push(relPath);
    }
  };
  for (const name of names) walk(path.join(schemasDir, name), name);

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(path.join(schemasDir, ...file.split('/'))));
    hash.update('\0');
  }
  const manifest = { version: packageVersion(), names, files, hash: hash.digest('hex') };
  writeJson(manifestPath, manifest);
  return manifest;
}

function main() {
  const tool = process.argv[2];
  if (tool === 'manifest') {
    console.log(`Wrote ${rel(manifestPath)}: ${JSON.stringify(writeManifest())}`);
    return;
  }
  if (!TOOLS.includes(tool)) {
    console.error(`Usage: node scripts/standalone/build.mjs <${TOOLS.join('|')}|manifest>`);
    process.exit(2);
  }

  const output = binaryPath(tool);
  const record = {
    tool,
    ok: false,
    error: null,
    binary: rel(output),
    bytes: null,
    durationMs: null,
    versions: { node: process.version },
    commands: [],
    runner: runnerInfo(),
  };

  const exec = (file, args) => {
    console.log(`$ ${[path.basename(file), ...args].join(' ')}`);
    const result = spawnSync(file, args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    const failed = Boolean(result.error) || result.status !== 0;
    record.commands.push({
      command: [path.basename(file), ...args].join(' '),
      status: result.status,
      ...(failed ? { output: excerpt(`${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`, 3000) } : {}),
    });
    if (failed) {
      throw new Error(
        `${path.basename(file)} ${args[0]} failed: ${excerpt(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`, 1500)}`
      );
    }
    return result.stdout ?? '';
  };
  const version = (file, args) => {
    const result = spawnSync(file, args, { encoding: 'utf-8', windowsHide: true });
    return result.error ? `unavailable (${result.error.message})` : (result.stdout || result.stderr).trim().split('\n')[0];
  };

  const started = Date.now();
  try {
    if (!fs.existsSync(path.join(repoRoot, 'dist', 'cli', 'index.js'))) {
      throw new Error('dist/ is missing: run `pnpm build` first');
    }
    fs.rmSync(path.dirname(output), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const manifest = writeManifest();
    record.schemas = { names: manifest.names, files: manifest.files.length, hash: manifest.hash };

    if (tool === 'bun') {
      record.versions.bun = version('bun', ['--version']);
      exec('bun', [
        'build',
        '--compile',
        'scripts/standalone/entry-bun.mjs',
        '--asset',
        './schemas',
        // A compiled Bun binary otherwise loads .env and bunfig.toml from the
        // working directory, which the Node CLI never does.
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        '--outfile',
        rel(output),
      ]);
    } else if (tool === 'deno') {
      record.versions.deno = version('deno', ['--version']);
      // --no-check: the entry is compiled JS. Type-checking it would need
      // @types/node, which the production-only install leaves out.
      exec('deno', [
        'compile',
        '--no-check',
        '--allow-all',
        '--include',
        'schemas',
        '--output',
        rel(output),
        'bin/openspec.js',
      ]);
    } else {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 25 || (major === 25 && minor < 5)) {
        throw new Error(`node --build-sea needs Node >= 25.5; this is ${process.version}`);
      }
      record.versions.bun = version('bun', ['--version']);
      const dir = path.dirname(output);
      const bundle = path.join(dir, 'openspec.mjs');
      exec('bun', ['build', 'scripts/standalone/entry-sea.mjs', '--target=node', '--format=esm', '--outfile', rel(bundle)]);
      record.bundleBytes = fs.statSync(bundle).size;
      record.nodeExecutableBytes = fs.statSync(process.execPath).size;

      const configPath = path.join(dir, 'sea-config.json');
      writeJson(configPath, {
        main: bundle,
        mainFormat: 'module',
        output,
        disableExperimentalSEAWarning: true,
        assets: Object.fromEntries(
          manifest.files.map((file) => [`schemas/${file}`, path.join(repoRoot, 'schemas', ...file.split('/'))])
        ),
      });
      exec(process.execPath, ['--build-sea', rel(configPath)]);

      if (process.platform === 'darwin') {
        // Injecting the blob invalidates the Node.js signature, and Apple
        // Silicon refuses to start an unsigned or invalidly signed binary.
        const before = spawnSync('codesign', ['-dv', output], { encoding: 'utf-8' });
        record.codesignBeforeAdhoc = excerpt(`${before.stderr}${before.stdout}`, 800);
        exec('codesign', ['--force', '--sign', '-', rel(output)]);
      }
    }

    if (!fs.existsSync(output)) {
      throw new Error(`build finished but ${rel(output)} does not exist`);
    }
    record.bytes = fs.statSync(output).size;
    record.ok = true;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    console.error(`\nBuild failed: ${record.error}`);
    process.exitCode = 1;
  } finally {
    record.durationMs = Date.now() - started;
    writeJson(path.join(resultsDir, `build-${tool}.json`), record);
  }
}

main();
