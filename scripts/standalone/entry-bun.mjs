// Entry point for `bun build --compile` (see build.mjs); Bun only.
//
// `--asset ./schemas` embeds the built-in schemas under import.meta.dir
// (/$bunfs/root/schemas, or B:\~BUN\root\schemas on Windows). Bun can read
// those paths and, since 1.4, list them; the resolver gets the directory and
// the build-time list of names, so it never has to list it.
//
// OPENSPEC_STANDALONE_SCHEMAS=extract copies them to a per-user cache
// directory first, as the SEA build does, so the resolver sees real files.
// The experiment runs the smoke tests both ways.
import fs from 'node:fs';
import path from 'node:path';
import manifest from '../../dist-standalone/builtin-schemas.json' with { type: 'json' };
import { registerBuiltinSchemas } from '../../dist/core/artifact-graph/builtin-schemas.js';
import { extractBuiltinSchemas, runCli, warnIfMissing } from './runtime.mjs';

const embedded = path.join(import.meta.dir, 'schemas');
let dir = embedded;
if (process.env.OPENSPEC_STANDALONE_SCHEMAS === 'extract') {
  try {
    dir = extractBuiltinSchemas(manifest, (file) => fs.readFileSync(path.join(embedded, ...file.split('/'))));
  } catch (error) {
    console.error(`openspec (standalone): could not unpack the built-in schemas: ${error.message}`);
  }
}
warnIfMissing(dir, manifest);
registerBuiltinSchemas({ dir, names: manifest.names });
// No top-level await, so the entry can also be bundled as CommonJS.
runCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
