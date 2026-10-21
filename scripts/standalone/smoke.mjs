#!/usr/bin/env node
// Smoke-tests a standalone OpenSpec executable against the plain Node build.
//
//   node scripts/standalone/smoke.mjs --tool <bun|deno|node-sea> [--bin <executable|node>]
//       [--label <name>] [--env KEY=VALUE]... [--out <file>] [--keep]
//
// --bin defaults to the tool's build output, dist-standalone/<tool>/openspec.
// `--bin node` tests `node bin/openspec.js` itself, which checks this script.
// Each step runs twice: with the executable under test and with
// `node bin/openspec.js` as the reference, each in its own fresh git repo and
// with its own empty HOME and XDG directories. A step passes when the
// executable's run is valid on its own and, where it says so, matches the
// reference. "templates paths exist on disk" is informational: builds that
// read schemas from a virtual file system print paths only they can open, and
// that is reported without failing the run. The report lands in
// dist-standalone/results/smoke-<label>.json; the exit code is 1 on failure.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  binaryPath,
  cliCommand,
  excerpt,
  failureText,
  isolatedEnv,
  makeTempDir,
  packageVersion,
  repoRoot,
  resultsDir,
  run,
  runnerInfo,
  writeJson,
} from './lib.mjs';

const { values: opts } = parseArgs({
  options: {
    bin: { type: 'string' },
    tool: { type: 'string' },
    label: { type: 'string' },
    env: { type: 'string', multiple: true, default: [] },
    out: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
if (!opts.bin && opts.tool) opts.bin = binaryPath(opts.tool);
if (!opts.bin) {
  console.error('Usage: node scripts/standalone/smoke.mjs --tool <bun|deno|node-sea> [--bin <executable|node>] [--label <name>] [--env KEY=VALUE]... [--out <file>] [--keep]');
  process.exit(2);
}
const tool = opts.tool ?? (opts.bin === 'node' ? 'node' : path.basename(path.dirname(path.resolve(opts.bin))));
const label = opts.label ?? tool;
const extraEnv = Object.fromEntries(
  opts.env.map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), pair.slice(at + 1)];
  })
);
const outFile = opts.out ?? path.join(resultsDir, `smoke-${label}.json`);
const version = packageVersion();

const report = {
  label,
  tool,
  bin: opts.bin === 'node' ? 'node bin/openspec.js' : path.relative(repoRoot, path.resolve(opts.bin)),
  env: extraEnv,
  version,
  runner: runnerInfo(),
  startedAt: new Date().toISOString(),
  ok: false,
  skipped: null,
  passed: 0,
  total: 0,
  steps: [],
};

function finish() {
  report.passed = report.steps.filter((s) => s.pass).length;
  report.total = report.steps.length;
  report.ok = !report.skipped && report.total > 0 && report.steps.every((s) => s.pass || s.informational);
  writeJson(outFile, report);
  console.log(`\nSmoke ${label}: ${report.skipped ?? `${report.passed}/${report.total} passed`}`);
  for (const s of report.steps) {
    const mark = s.pass ? 'pass' : s.informational ? 'note' : 'FAIL';
    console.log(`  ${mark}  ${s.title}${s.pass ? '' : `: ${s.error}`}`);
  }
  console.log(`Report: ${path.relative(repoRoot, outFile)}`);
  process.exitCode = report.ok ? 0 : 1;
}

if (opts.bin !== 'node' && !fs.existsSync(opts.bin)) {
  report.skipped = `binary not found: ${opts.bin} (did the build fail?)`;
  finish();
  process.exit();
}

const work = makeTempDir('openspec-smoke-');
const sides = {
  target: {
    cmd: cliCommand(opts.bin),
    env: isolatedEnv(path.join(work, 'target-env'), extraEnv),
    repo: path.join(work, 'target', 'project'),
  },
  reference: {
    cmd: cliCommand('node'),
    env: isolatedEnv(path.join(work, 'reference-env')),
    repo: path.join(work, 'reference', 'project'),
  },
};

const parseJson = (text) => {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: `stdout is not JSON (${error.message}): ${excerpt(text, 200)}` };
  }
};

/** The messages a failed `--json` command reports in its status array, if any. */
const statusMessages = (json) =>
  Array.isArray(json?.status) && json.status.length > 0
    ? excerpt(json.status.map((s) => s.message ?? s.code).join('; '))
    : null;

/**
 * Runs `openspec <args>` on both sides. A side fails when the command fails
 * (a non-zero exit unless `anyExit`), prints no JSON where JSON is expected,
 * or `valid({ result, json, side })` returns an error string. Then
 * `compare(target, reference)` checks parity and returns an error string or null.
 */
function commandStep(id, args, { cwd = (side) => side.repo, json = false, anyExit = false, valid, compare, detail } = {}) {
  const runSide = (side) => {
    const result = run(side.cmd, args, { cwd: cwd(side), env: side.env, timeout: 60_000 });
    const parsed = json ? parseJson(result.stdout) : {};
    let error = null;
    if (result.error || result.signal) error = failureText(result);
    else if (result.status !== 0 && !anyExit) error = statusMessages(parsed.value) ?? failureText(result);
    else if (json && parsed.error) error = parsed.error;
    else if (valid) error = valid({ result, json: parsed.value, side });
    return { result, json: parsed.value, error };
  };
  const target = runSide(sides.target);
  const reference = runSide(sides.reference);
  let error = target.error;
  if (!error && compare && !reference.error) error = compare(target, reference);
  report.steps.push({
    id,
    title: `openspec ${args.join(' ')}`,
    pass: !error,
    error,
    detail: detail ? detail(target) : null,
    exitCode: target.result.status,
    ms: Math.round(target.result.ms),
    reference: { pass: !reference.error, exitCode: reference.result.status, error: reference.error },
  });
  return target;
}

/** A check that runs no command. An informational step is reported but does not fail the run. */
function customStep(id, title, fn, { informational = false } = {}) {
  try {
    const { error = null, detail = null } = fn();
    report.steps.push({ id, title, pass: !error, error, detail, ...(informational ? { informational } : {}) });
  } catch (error) {
    report.steps.push({ id, title, pass: false, error: `smoke script error: ${error.message}`, detail: null });
  }
}

/** Recursive comparison of two trees, skipping .git: `diff -r`, or a JS walk when diff is missing. */
function diffTrees(a, b) {
  const result = spawnSync('diff', ['-r', '-x', '.git', a, b], { encoding: 'utf-8', windowsHide: true });
  if (!result.error && (result.status === 0 || result.status === 1)) {
    return { identical: result.status === 0, method: 'diff -r', output: excerpt(result.stdout, 1500) };
  }
  const list = (root) => {
    const files = new Map();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.set(path.relative(root, full), fs.readFileSync(full));
      }
    };
    walk(root);
    return files;
  };
  const left = list(a);
  const right = list(b);
  const lines = [];
  for (const [file, content] of left) {
    if (!right.has(file)) lines.push(`Only in reference: ${file}`);
    else if (!content.equals(right.get(file))) lines.push(`Differs: ${file}`);
  }
  for (const file of right.keys()) if (!left.has(file)) lines.push(`Only in binary: ${file}`);
  return { identical: lines.length === 0, method: 'js walk (diff unavailable)', output: excerpt(lines.join('\n'), 1500) };
}

const exists = (...segments) => fs.existsSync(path.join(...segments));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  commandStep('version', ['--version'], {
    cwd: () => work,
    valid: ({ result }) =>
      result.stdout.trim() === version ? null : `printed "${excerpt(result.stdout, 80)}", expected ${version}`,
    detail: (t) => excerpt(t.result.stdout, 40),
  });

  for (const side of Object.values(sides)) {
    fs.mkdirSync(side.repo, { recursive: true });
    const git = spawnSync('git', ['init', '-q'], { cwd: side.repo, env: side.env, encoding: 'utf-8' });
    if (git.error || git.status !== 0) throw new Error(`git init failed: ${git.error?.message ?? git.stderr}`);
  }

  commandStep('init', ['init', '--tools', 'claude'], {
    valid: ({ side }) => (exists(side.repo, 'openspec', 'config.yaml') ? null : 'openspec/config.yaml was not created'),
  });

  customStep('init-diff', 'init tree identical to the Node build (diff -r)', () => {
    const diff = diffTrees(sides.reference.repo, sides.target.repo);
    return { error: diff.identical ? null : `trees differ:\n${diff.output}`, detail: diff.method };
  });

  commandStep('new-change', ['new', 'change', 'demo'], {
    valid: ({ side }) => (exists(side.repo, 'openspec', 'changes', 'demo') ? null : 'openspec/changes/demo was not created'),
  });

  commandStep('status', ['status', '--change', 'demo', '--json'], {
    json: true,
    valid: ({ json }) => (json?.changeName === 'demo' ? null : 'JSON has no changeName "demo"'),
  });

  commandStep('instructions', ['instructions', 'proposal', '--change', 'demo', '--json'], {
    json: true,
    valid: ({ json }) => (typeof json?.template === 'string' && json.template.length > 0 ? null : 'JSON has no template text'),
    compare: (t, ref) =>
      t.json.template === ref.json.template && t.json.instruction === ref.json.instruction
        ? null
        : 'template or instruction text differs from the Node build',
    detail: (t) => (t.json?.template ? `template: ${t.json.template.length} chars` : null),
  });

  commandStep('schemas', ['schemas', '--json'], {
    json: true,
    valid: ({ json }) => (Array.isArray(json) && json.some((s) => s.name === 'spec-driven') ? null : 'spec-driven is not listed'),
    compare: (t, ref) => (sameJson(t.json, ref.json) ? null : `differs from the Node build: ${excerpt(JSON.stringify(t.json), 300)}`),
    detail: (t) => (Array.isArray(t.json) ? t.json.map((s) => `${s.name} (${s.source})`).join(', ') : null),
  });

  commandStep('list', ['list', '--json'], {
    json: true,
    valid: ({ json }) =>
      Array.isArray(json?.changes) && json.changes.some((c) => c.name === 'demo') ? null : 'change "demo" is not listed',
  });

  const templates = commandStep('templates', ['templates', '--json'], {
    json: true,
    valid: ({ json }) => (json && typeof json === 'object' && json.proposal?.path ? null : 'JSON has no proposal template path'),
    compare: (t, ref) =>
      sameJson(Object.keys(t.json).sort(), Object.keys(ref.json).sort()) ? null : 'artifact list differs from the Node build',
    detail: (t) => (t.json?.proposal?.path ? `proposal: ${t.json.proposal.path}` : null),
  });

  customStep('templates-on-disk', 'templates --json paths exist on disk', () => {
    if (!templates.json || typeof templates.json !== 'object') return { error: 'no templates JSON to check' };
    const entries = Object.values(templates.json).map((info) => [info?.path, Boolean(info?.path && fs.existsSync(info.path))]);
    const missing = entries.filter(([, found]) => !found);
    return {
      error: missing.length ? `${missing.length}/${entries.length} missing on disk, e.g. ${missing[0][0]}` : null,
      detail: `${entries.length - missing.length}/${entries.length} exist`,
    };
  }, { informational: true });

  // The repo's own changes include some that do not validate, so a non-zero
  // exit is expected: the step checks the report matches the Node build's.
  commandStep('validate', ['validate', '--all', '--json'], {
    cwd: () => repoRoot,
    json: true,
    anyExit: true,
    valid: ({ result, json }) => (json?.summary?.totals ? null : statusMessages(json) ?? failureText(result)),
    compare: (t, ref) =>
      sameJson(t.json.summary.totals, ref.json.summary.totals) && t.result.status === ref.result.status
        ? null
        : `differs from the Node build: totals ${JSON.stringify(t.json.summary.totals)} exit ${t.result.status}, Node: totals ${JSON.stringify(ref.json.summary.totals)} exit ${ref.result.status}`,
    detail: (t) => (t.json?.summary?.totals ? `totals ${JSON.stringify(t.json.summary.totals)}, exit ${t.result.status}` : null),
  });

  customStep('final-diff', 'project tree after all steps identical to the Node build', () => {
    const diff = diffTrees(sides.reference.repo, sides.target.repo);
    return { error: diff.identical ? null : `trees differ:\n${diff.output}`, detail: diff.method };
  });
} catch (error) {
  report.steps.push({ id: 'setup', title: 'smoke setup', pass: false, error: error.message, detail: null });
} finally {
  if (!opts.keep) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle; the runner is discarded anyway.
    }
  } else {
    report.workDir = work;
  }
  finish();
}
