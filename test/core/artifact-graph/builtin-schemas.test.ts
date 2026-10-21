import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerBuiltinSchemas } from '../../../src/core/artifact-graph/builtin-schemas.js';
import {
  getPackageSchemasDir,
  getSchemaDir,
  listSchemas,
  listSchemasWithInfo,
  resolveSchema,
} from '../../../src/core/artifact-graph/resolver.js';
import { loadTemplate } from '../../../src/core/artifact-graph/instruction-loader.js';

// Standalone executables embed schemas/ somewhere the resolver cannot find
// from its own location, and some cannot list it, so their entry point
// registers the directory and the build-time list of names.
describe('artifact-graph/builtin-schemas registration', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let packageDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-builtin-schemas-'));
    originalEnv = { ...process.env };
    // An empty user schema directory, so only built-in schemas are found.
    process.env.XDG_DATA_HOME = path.join(tempDir, 'data');
    packageDir = getPackageSchemasDir();
  });

  afterEach(() => {
    registerBuiltinSchemas(undefined);
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves from the registered directory and lists only the registered names', () => {
    const embedded = path.join(tempDir, 'embedded');
    fs.cpSync(path.join(packageDir, 'spec-driven'), path.join(embedded, 'spec-driven'), {
      recursive: true,
    });
    // Listing the directory would surface this one; the build-time list does not.
    fs.mkdirSync(path.join(embedded, 'unlisted'));
    fs.writeFileSync(
      path.join(embedded, 'unlisted', 'schema.yaml'),
      'name: unlisted\nversion: 1\nartifacts: []\n'
    );

    registerBuiltinSchemas({ dir: embedded, names: ['spec-driven'] });

    expect(getPackageSchemasDir()).toBe(embedded);
    expect(getSchemaDir('spec-driven')).toBe(path.join(embedded, 'spec-driven'));
    expect(resolveSchema('spec-driven').name).toBe('spec-driven');
    expect(listSchemas()).toEqual(['spec-driven']);
    expect(listSchemasWithInfo().map((s) => [s.name, s.source])).toEqual([['spec-driven', 'package']]);
    expect(loadTemplate('spec-driven', 'proposal.md')).toBe(
      fs.readFileSync(path.join(embedded, 'spec-driven', 'templates', 'proposal.md'), 'utf-8')
    );
  });

  it('skips a registered name whose schema.yaml is missing', () => {
    const embedded = path.join(tempDir, 'embedded');
    fs.mkdirSync(embedded);

    registerBuiltinSchemas({ dir: embedded, names: ['spec-driven'] });

    expect(listSchemas()).toEqual([]);
    expect(getSchemaDir('spec-driven')).toBeNull();
  });

  it('lists the package schemas/ directory when nothing is registered', () => {
    expect(getPackageSchemasDir()).toBe(packageDir);
    expect(listSchemas()).toContain('spec-driven');
    expect(getSchemaDir('spec-driven')).toBe(path.join(packageDir, 'spec-driven'));
  });
});
