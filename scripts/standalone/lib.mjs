// Helpers shared by the standalone-binary experiment scripts (build, smoke,
// measure, report). Node built-ins only, so they run on any CI runner with
// nothing but Node installed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const outRoot = path.join(repoRoot, 'dist-standalone');
export const resultsDir = path.join(outRoot, 'results');
export const exeSuffix = process.platform === 'win32' ? '.exe' : '';
export const TOOLS = ['bun', 'deno', 'node-sea'];

export function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).version;
}

/** Where build.mjs puts the executable for a tool. */
export function binaryPath(tool) {
  return path.join(outRoot, tool, `openspec${exeSuffix}`);
}

/**
 * The command that runs a CLI under test: `node` means the plain Node build
 * (`node bin/openspec.js`), anything else is a path to an executable.
 */
export function cliCommand(bin) {
  if (bin === 'node') {
    return { file: process.execPath, args: [path.join(repoRoot, 'bin', 'openspec.js')] };
  }
  return { file: path.resolve(bin), args: [] };
}

/**
 * A throwaway HOME plus XDG config/data/cache directories, so runs neither
 * read nor write the runner's (or a developer's) global OpenSpec state, and
 * the binary and the Node build start from the same empty state.
 */
export function isolatedEnv(root, extra = {}) {
  const dirs = {
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
  for (const dir of new Set(Object.values(dirs))) fs.mkdirSync(dir, { recursive: true });
  return {
    ...process.env,
    ...dirs,
    OPENSPEC_TELEMETRY: '0',
    OPENSPEC_NO_UPDATE_CHECK: '1',
    OPEN_SPEC_INTERACTIVE: '0',
    ...extra,
  };
}

/** Runs a command to completion with stdin closed; never throws. */
export function run(command, args, { cwd, env, timeout = 120_000 } = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command.file, [...command.args, ...args], {
    cwd,
    env,
    input: '',
    encoding: 'utf-8',
    timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? result.error.message : undefined,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

/** First lines of some output, trimmed for a table cell or a JSON report. */
export function excerpt(text, maxChars = 600) {
  const trimmed = String(text ?? '').trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

/** The useful part of a failed run: the error, stderr, or stdout. */
export function failureText(result) {
  if (result.error) return excerpt(result.error);
  if (result.signal) return `killed by ${result.signal}. ${excerpt(result.stderr)}`;
  return excerpt(result.stderr) || excerpt(result.stdout) || `exit code ${result.status}`;
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

export function makeTempDir(prefix) {
  // realpath: macOS hands out /var/... for /private/var/..., which would make
  // otherwise identical paths compare unequal.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Identifies the machine a result came from. */
export function runnerInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    runnerOs: process.env.RUNNER_OS ?? null,
    image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion ?? ''}`.trim() : null,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? null,
    node: process.version,
  };
}

/** Short OS label used in file names and tables. */
export function osLabel(platform = process.platform, arch = process.arch) {
  const name = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform] ?? platform;
  return `${name}-${arch}`;
}

/** Appends Markdown to the GitHub step summary, or prints it outside Actions. */
export function writeStepSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) {
    fs.appendFileSync(file, `${markdown}\n`);
  } else {
    process.stdout.write(`${markdown}\n`);
  }
}
