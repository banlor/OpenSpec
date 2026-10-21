// Glue shared by the standalone entries (entry-bun.mjs, entry-sea.mjs). It is
// bundled into those executables only; the npm package never loads it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Runs the CLI once. src/cli/index.ts also runs it by itself when it is the
 * process entry point (`node dist/cli/index.js`), which it detects by comparing
 * process.argv[1] with its own module path. Inside a bundle that path is the
 * bundle's, and it can equal argv[1]: Bun puts the bundle's virtual path
 * there, and a SEA's ESM main is the executable itself. Blanking argv[1] while
 * the CLI module loads keeps that check from parsing the arguments twice.
 */
export async function runCli() {
  const argv = [...process.argv];
  process.argv[1] = '';
  let cli;
  try {
    cli = await import('../../dist/cli/index.js');
  } finally {
    process.argv[1] = argv[1];
  }
  cli.runCli(argv);
}

/** Per-user cache root. XDG_CACHE_HOME wins when set, as OpenSpec's other XDG variables do. */
function cacheRoot() {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  return path.join(os.homedir(), '.cache');
}

/**
 * Copies the built-in schemas to a per-user cache directory and returns it, for
 * builds whose embedded files the resolver cannot read in place (a Node SEA
 * only exposes them through sea.getAsset()). The directory is keyed by version
 * and content hash and moved into place complete, so later runs reuse it after
 * a single existsSync().
 *
 * @param manifest build-time manifest written by build.mjs
 * @param readFile returns the contents of a schemas/-relative path
 */
export function extractBuiltinSchemas(manifest, readFile) {
  const dir = path.join(
    cacheRoot(),
    'openspec',
    'builtin-schemas',
    `${manifest.version}-${manifest.hash.slice(0, 16)}`
  );
  if (fs.existsSync(dir)) return dir;

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(`${dir}.tmp-`);
  for (const file of manifest.files) {
    const target = path.join(staging, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readFile(file));
  }
  try {
    fs.renameSync(staging, dir);
    return dir;
  } catch {
    // Another run moved its copy in first, or the rename was refused (on
    // Windows a virus scanner can still hold the new files). Use whichever
    // complete copy exists; a leftover staging copy is retried next run.
    if (fs.existsSync(dir)) {
      fs.rmSync(staging, { recursive: true, force: true });
      return dir;
    }
    return staging;
  }
}

/** Says so on stderr when the registered directory lacks a schema, instead of failing later with "not found". */
export function warnIfMissing(dir, manifest) {
  const missing = manifest.names.filter((name) => !fs.existsSync(path.join(dir, name, 'schema.yaml')));
  if (missing.length > 0) {
    console.error(`openspec (standalone): built-in schema(s) ${missing.join(', ')} not found under ${dir}`);
  }
}
