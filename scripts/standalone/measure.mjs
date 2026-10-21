#!/usr/bin/env node
// Measures a standalone OpenSpec executable next to the plain Node build on
// the same machine:
// - size of the executable, raw and gzip -9;
// - startup time of `--version` and `list --json` (run in the repo root):
//   median of --runs runs after --warmup warmups, alternating the executable
//   and `node bin/openspec.js` so both see the same machine conditions;
// - code signing state (codesign -dv on macOS, Get-AuthenticodeSignature on
//   Windows). Nothing is signed here.
//
//   node scripts/standalone/measure.mjs --tool <bun|deno|node-sea> [--bin <executable|node>]
//       [--runs 20] [--warmup 3] [--out <file>]
//
// --bin defaults to the tool's build output, dist-standalone/<tool>/openspec.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import zlib from 'node:zlib';
import {
  binaryPath,
  cliCommand,
  excerpt,
  failureText,
  isolatedEnv,
  makeTempDir,
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
    runs: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '3' },
    out: { type: 'string' },
  },
});
if (!opts.bin && opts.tool) opts.bin = binaryPath(opts.tool);
if (!opts.bin) {
  console.error('Usage: node scripts/standalone/measure.mjs --tool <bun|deno|node-sea> [--bin <executable|node>] [--runs 20] [--warmup 3] [--out <file>]');
  process.exit(2);
}
const tool = opts.tool ?? (opts.bin === 'node' ? 'node' : path.basename(path.dirname(path.resolve(opts.bin))));
const runs = Number(opts.runs);
const warmup = Number(opts.warmup);
const outFile = opts.out ?? path.join(resultsDir, `measure-${tool}.json`);

function sizeOf(file) {
  const data = fs.readFileSync(file);
  return { raw: data.length, gzip: zlib.gzipSync(data, { level: 9 }).length };
}

function stats(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const round = (n) => Math.round(n * 10) / 10;
  return {
    median: round(median),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((sum, n) => sum + n, 0) / sorted.length),
    n: sorted.length,
  };
}

/**
 * Times `args` for each subject, alternating subjects run by run. A subject
 * whose first run fails is not run again, so a binary that hangs costs one
 * timeout rather than one per run.
 */
function timeCommand(subjects, args) {
  const series = subjects.map(() => ({ samples: [], firstRunMs: null, failures: 0, lastError: null }));
  for (let i = 0; i < warmup + runs; i++) {
    subjects.forEach((subject, index) => {
      const entry = series[index];
      if (i > 0 && entry.firstRunFailed) return;
      const result = run(subject.cmd, args, { cwd: repoRoot, env: subject.env, timeout: 60_000 });
      if (i === 0) entry.firstRunMs = Math.round(result.ms * 10) / 10;
      if (result.error || result.status !== 0) {
        entry.failures += 1;
        entry.lastError = failureText(result);
        if (i === 0) entry.firstRunFailed = true;
      } else if (i >= warmup) {
        entry.samples.push(result.ms);
      }
    });
  }
  return Object.fromEntries(
    subjects.map((subject, index) => {
      const { samples, ...rest } = series[index];
      return [subject.name, { ...stats(samples), ...rest }];
    })
  );
}

function signing(file) {
  if (process.platform === 'darwin') {
    const display = spawnSync('codesign', ['-dv', '--verbose=2', file], { encoding: 'utf-8' });
    const verify = spawnSync('codesign', ['--verify', '--strict', file], { encoding: 'utf-8' });
    const text = `${display.stderr}${display.stdout}`;
    const signature = /^Signature=(.*)$/m.exec(text)?.[1];
    const authority = /^Authority=(.*)$/m.exec(text)?.[1];
    const runtime = /flags=.*runtime/.test(text);
    let summary;
    if (/not signed at all/.test(text)) summary = 'not signed';
    else if (signature === 'adhoc') summary = 'ad-hoc signed';
    else if (authority) summary = `signed: ${authority}`;
    else summary = excerpt(text, 120) || 'unknown';
    return {
      method: 'codesign -dv',
      summary: `${summary}${runtime ? ', hardened runtime' : ''}; verify: ${verify.status === 0 ? 'valid' : 'invalid'}`,
      output: excerpt(text, 1200),
      verify: verify.status === 0 ? 'valid' : excerpt(`${verify.stderr}${verify.stdout}`, 400),
    };
  }
  if (process.platform === 'win32') {
    const script =
      '$s = Get-AuthenticodeSignature -LiteralPath $env:OPENSPEC_SIGNATURE_TARGET; ' +
      '[pscustomobject]@{ Status = [string]$s.Status; StatusMessage = $s.StatusMessage; ' +
      'Signer = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress';
    const env = { ...process.env, OPENSPEC_SIGNATURE_TARGET: file };
    let result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8', env });
    if (result.error) {
      result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8', env });
    }
    try {
      const parsed = JSON.parse(result.stdout);
      return {
        method: 'Get-AuthenticodeSignature',
        summary: `${parsed.Status}${parsed.Signer ? `: ${parsed.Signer}` : ''}`,
        output: excerpt(parsed.StatusMessage, 400),
      };
    } catch {
      return { method: 'Get-AuthenticodeSignature', summary: 'unknown', output: failureText(result) };
    }
  }
  return { method: null, summary: 'n/a (Linux executables carry no OS signature)', output: null };
}

const report = {
  tool,
  bin: opts.bin === 'node' ? 'node bin/openspec.js' : path.relative(repoRoot, path.resolve(opts.bin)),
  runner: runnerInfo(),
  runs,
  warmup,
  ok: false,
  skipped: null,
};

if (opts.bin !== 'node' && !fs.existsSync(opts.bin)) {
  report.skipped = `binary not found: ${opts.bin} (did the build fail?)`;
} else {
  const work = makeTempDir('openspec-measure-');
  const subjects = [
    { name: 'binary', cmd: cliCommand(opts.bin), env: isolatedEnv(path.join(work, 'binary')) },
    { name: 'node', cmd: cliCommand('node'), env: isolatedEnv(path.join(work, 'node')) },
  ];
  report.size = opts.bin === 'node' ? null : sizeOf(opts.bin);
  report.baseline = {
    command: 'node bin/openspec.js',
    node: process.version,
    nodeExecutable: { path: process.execPath, ...sizeOf(process.execPath) },
  };
  report.timing = {};
  for (const args of [['--version'], ['list', '--json']]) {
    const label = args.join(' ');
    console.log(`Timing \`${label}\`: ${warmup} warmup + ${runs} runs each...`);
    report.timing[label] = timeCommand(subjects, args);
  }
  report.signing = {
    binary: opts.bin === 'node' ? null : signing(path.resolve(opts.bin)),
    node: signing(process.execPath),
  };
  report.ok = Object.values(report.timing).every((t) => t.binary.failures === 0 && t.node.failures === 0);
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle; the runner is discarded anyway.
  }
}

writeJson(outFile, report);
console.log(JSON.stringify({ size: report.size, timing: report.timing, signing: report.signing, skipped: report.skipped }, null, 2));
console.log(`Report: ${path.relative(repoRoot, outFile)}`);
