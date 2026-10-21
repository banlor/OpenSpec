// Entry point for the Node single executable application (see build.mjs):
// bundled with `bun build --target=node --format=esm`, then embedded with
// `node --build-sea` ("mainFormat": "module").
//
// A SEA exposes its assets only through node:sea, so the built-in schemas are
// copied out with sea.getAsset() into a per-user cache directory, which is
// registered as the built-in schema directory. Outside a SEA (running this
// file with plain Node) nothing is registered and the package layout is used.
import manifest from '../../dist-standalone/builtin-schemas.json' with { type: 'json' };
import { registerBuiltinSchemas } from '../../dist/core/artifact-graph/builtin-schemas.js';
import { extractBuiltinSchemas, runCli, warnIfMissing } from './runtime.mjs';

// getBuiltinModule, not an import: the bundler never has to resolve node:sea.
const sea = process.getBuiltinModule('node:sea');
if (sea.isSea()) {
  try {
    const dir = extractBuiltinSchemas(manifest, (file) => new Uint8Array(sea.getAsset(`schemas/${file}`)));
    warnIfMissing(dir, manifest);
    registerBuiltinSchemas({ dir, names: manifest.names });
  } catch (error) {
    console.error(`openspec (standalone): could not unpack the built-in schemas: ${error.message}`);
  }
}
// No top-level await, so the entry can also be bundled as CommonJS.
runCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
