#!/usr/bin/env node
// Turns the experiment's JSON results into Markdown tables.
//
//   node scripts/standalone/report.mjs cell --tool <tool>
//     Merges dist-standalone/results/{build,smoke,measure}-*.json for one tool
//     on this machine into results/cell-<tool>-<os>.json and writes a summary
//     to $GITHUB_STEP_SUMMARY (stdout outside Actions).
//   node scripts/standalone/report.mjs aggregate <dir>
//     Merges every cell-*.json under <dir> into one table, written to
//     <dir>/summary.md, <dir>/summary.json and $GITHUB_STEP_SUMMARY.
//   node scripts/standalone/report.mjs verdict --tool <tool>
//     Exits 1 when that cell's build, measurement or a smoke step failed.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { osLabel, readJson, resultsDir, writeJson, writeStepSummary } from './lib.mjs';

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: { tool: { type: 'string' } },
});
const [command, dirArg] = positionals;

const mib = (bytes) => (bytes == null ? '–' : `${(bytes / 1048576).toFixed(1)} MiB`);
const ms = (value) => (value == null ? '–' : `${Math.round(value)} ms`);
/** One line of text, cut to `max` characters. */
const short = (text, max = 160) => {
  const flat = String(text ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
const esc = (text) => short(text, Infinity).replace(/\|/g, '\\|');
const table = (headers, rows) =>
  [
    `| ${headers.map(esc).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(esc).join(' | ')} |`),
  ].join('\n');
const mark = (step) => (step.pass ? 'pass' : step.informational ? 'no' : 'FAIL');

function cellFile(tool, os) {
  return path.join(resultsDir, `cell-${tool}-${os}.json`);
}

function buildCell(tool) {
  const os = osLabel();
  const build = readJson(path.join(resultsDir, `build-${tool}.json`)) ?? { ok: false, error: 'no build result' };
  const measure = readJson(path.join(resultsDir, `measure-${tool}.json`)) ?? null;
  const smokes = fs.existsSync(resultsDir)
    ? fs
        .readdirSync(resultsDir)
        .filter((name) => name.startsWith('smoke-') && name.endsWith('.json'))
        .map((name) => readJson(path.join(resultsDir, name)))
        .filter((smoke) => smoke && smoke.tool === tool)
        .sort((a, b) => a.label.localeCompare(b.label))
    : [];
  const ok =
    Boolean(build.ok) &&
    Boolean(measure?.ok) &&
    smokes.length > 0 &&
    smokes.every((smoke) => smoke.ok);
  return { tool, os, runner: measure?.runner ?? build.runner ?? null, ok, build, measure, smokes };
}

function versionsText(build) {
  return Object.entries(build.versions ?? {})
    .map(([name, version]) => `${name} ${String(version).replace(/^v/, '')}`)
    .join(', ');
}

function cellMarkdown(cell) {
  const { tool, os, build, measure, smokes } = cell;
  const lines = [`### ${tool} on ${os}${cell.runner?.image ? ` (${cell.runner.image})` : ''}`, ''];
  lines.push(
    build.ok
      ? `Build: ok in ${(build.durationMs / 1000).toFixed(1)} s (${versionsText(build)})`
      : `Build: **FAILED**: ${short(build.error, 600)}`
  );
  if (measure?.size) {
    const node = measure.baseline?.nodeExecutable;
    lines.push(
      '',
      `Size: ${mib(measure.size.raw)} raw, ${mib(measure.size.gzip)} gzip -9` +
        (node ? ` (the node executable alone: ${mib(node.raw)} raw, ${mib(node.gzip)} gzip -9)` : '') +
        (build.bundleBytes ? `; bundled JS: ${mib(build.bundleBytes)}` : '')
    );
  }
  if (measure?.timing) {
    lines.push(
      '',
      table(
        [`Startup, median of ${measure.runs} after ${measure.warmup} warmups`, tool, `node bin/openspec.js (${measure.baseline?.node ?? ''})`],
        Object.entries(measure.timing).map(([label, t]) => [
          `\`${label}\``,
          t.binary.failures ? `${ms(t.binary.median)}, ${t.binary.failures} failed runs: ${short(t.binary.lastError, 120)}` : `${ms(t.binary.median)} (first run ${ms(t.binary.firstRunMs)})`,
          t.node.failures ? `${ms(t.node.median)}, ${t.node.failures} failed runs` : ms(t.node.median),
        ])
      )
    );
  } else if (measure?.skipped) {
    lines.push('', `Measurements skipped: ${measure.skipped}`);
  }
  if (measure?.signing) {
    lines.push(
      '',
      `Signature: ${measure.signing.binary?.summary ?? '–'} (node executable: ${measure.signing.node?.summary ?? '–'})`
    );
    if (build.codesignBeforeAdhoc) lines.push('', `Before ad-hoc signing: ${short(build.codesignBeforeAdhoc, 300)}`);
  }
  for (const smoke of smokes) {
    lines.push('', `#### Smoke: ${smoke.label}${Object.keys(smoke.env ?? {}).length ? ` (${Object.entries(smoke.env).map(([k, v]) => `${k}=${v}`).join(' ')})` : ''}`);
    if (smoke.skipped) {
      lines.push('', `Skipped: ${smoke.skipped}`);
      continue;
    }
    lines.push(
      '',
      `${smoke.passed}/${smoke.total} passed`,
      '',
      table(
        ['Step', 'Result', 'Detail or error', 'Node build'],
        smoke.steps.map((step) => [
          step.title,
          mark(step),
          step.pass ? short(step.detail ?? '') : short(step.error, 400),
          step.reference ? (step.reference.pass ? 'pass' : `FAIL: ${short(step.reference.error, 120)}`) : '',
        ])
      )
    );
  }
  return lines.join('\n');
}

function findCells(dir) {
  const cells = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^cell-.*\.json$/.test(entry.name)) {
        const cell = readJson(full);
        if (cell) cells.push(cell);
      }
    }
  };
  walk(dir);
  const osOrder = (os) => ['linux', 'macos', 'windows'].findIndex((name) => os.startsWith(name));
  return cells.sort((a, b) => osOrder(a.os) - osOrder(b.os) || a.os.localeCompare(b.os) || a.tool.localeCompare(b.tool));
}

function aggregateMarkdown(cells) {
  const lines = ['## Standalone binaries: all cells', ''];
  const versions = new Map();
  for (const cell of cells) {
    for (const [name, version] of Object.entries(cell.build?.versions ?? {})) {
      versions.set(`${name} ${String(version).replace(/^v/, '')}`, true);
    }
  }
  lines.push(
    `Tools: ${[...versions.keys()].join(', ') || '–'}. Each cell also timed \`node bin/openspec.js\` on the same runner. ` +
      'Startup is the median wall time of 20 runs after 3 warmups, including process spawn.',
    ''
  );

  const rows = [];
  for (const cell of cells) {
    const t = cell.measure?.timing ?? {};
    const pair = (label) =>
      t[label] ? `${ms(t[label].binary.median)} / ${ms(t[label].node.median)}` : '–';
    const variants = cell.smokes.length > 0 ? cell.smokes : [null];
    variants.forEach((smoke, index) => {
      const primary = index === 0 || smoke?.label === cell.tool;
      const failed = smoke?.steps?.filter((s) => !s.pass && !s.informational).map((s) => s.title.replace(/^openspec /, '')) ?? [];
      const onDisk = smoke?.steps?.find((s) => s.id === 'templates-on-disk');
      rows.push([
        cell.os,
        smoke?.label ?? cell.tool,
        cell.build?.ok ? 'ok' : `FAILED: ${short(cell.build?.error, 80)}`,
        primary && cell.measure?.size ? `${mib(cell.measure.size.raw)} / ${mib(cell.measure.size.gzip)}` : primary ? '–' : 'same binary',
        primary ? pair('--version') : '',
        primary ? pair('list --json') : '',
        smoke ? (smoke.skipped ? 'skipped' : `${smoke.passed}/${smoke.total}`) : '–',
        failed.length ? failed.join('; ') : smoke && !smoke.skipped ? 'none' : '–',
        onDisk ? (onDisk.pass ? 'yes' : `no (${short(onDisk.detail ?? onDisk.error, 40)})`) : '–',
        primary ? cell.measure?.signing?.binary?.summary ?? '–' : '',
      ]);
    });
  }
  lines.push(
    table(
      ['OS', 'Tool', 'Build', 'Size raw / gzip -9', '`--version` binary / node', '`list --json` binary / node', 'Smoke passed', 'Failed steps', 'Template paths on disk', 'Signature'],
      rows
    )
  );

  // Every smoke step by cell.
  const columns = [];
  for (const cell of cells) for (const smoke of cell.smokes) if (!smoke.skipped) columns.push({ cell, smoke });
  if (columns.length > 0) {
    const stepIds = [];
    const titles = new Map();
    for (const { smoke } of columns) {
      for (const step of smoke.steps) {
        if (!titles.has(step.id)) {
          stepIds.push(step.id);
          titles.set(step.id, step.title);
        }
      }
    }
    lines.push(
      '',
      '### Smoke steps',
      '',
      table(
        ['Step', ...columns.map(({ cell, smoke }) => `${cell.os.split('-')[0]} ${smoke.label}`)],
        stepIds.map((id) => [
          titles.get(id),
          ...columns.map(({ smoke }) => {
            const step = smoke.steps.find((s) => s.id === id);
            return step ? mark(step) : '–';
          }),
        ])
      )
    );
  }

  const failures = [];
  for (const cell of cells) {
    if (!cell.build?.ok) failures.push(`- **${cell.os} ${cell.tool}**: build: ${short(cell.build?.error, 800)}`);
    for (const smoke of cell.smokes) {
      if (smoke.skipped) failures.push(`- **${cell.os} ${smoke.label}**: smoke skipped: ${short(smoke.skipped)}`);
      for (const step of smoke.steps ?? []) {
        if (!step.pass) {
          failures.push(`- **${cell.os} ${smoke.label}** \`${step.title}\`${step.informational ? ' (informational)' : ''}: ${short(step.error, 600)}`);
        }
      }
    }
    for (const [label, t] of Object.entries(cell.measure?.timing ?? {})) {
      if (t.binary.failures) failures.push(`- **${cell.os} ${cell.tool}** timing \`${label}\`: ${t.binary.failures} failed runs: ${short(t.binary.lastError, 400)}`);
    }
  }
  lines.push('', '### Failures and differences', '', failures.length ? failures.join('\n') : 'None.');
  return lines.join('\n');
}

if (command === 'cell') {
  if (!opts.tool) throw new Error('cell needs --tool');
  const cell = buildCell(opts.tool);
  writeJson(cellFile(cell.tool, cell.os), cell);
  writeStepSummary(cellMarkdown(cell));
} else if (command === 'aggregate') {
  const dir = path.resolve(dirArg ?? resultsDir);
  fs.mkdirSync(dir, { recursive: true });
  const cells = findCells(dir);
  const markdown = aggregateMarkdown(cells);
  fs.writeFileSync(path.join(dir, 'summary.md'), `${markdown}\n`);
  writeJson(path.join(dir, 'summary.json'), { generatedAt: new Date().toISOString(), cells });
  writeStepSummary(markdown);
} else if (command === 'verdict') {
  if (!opts.tool) throw new Error('verdict needs --tool');
  const cell = readJson(cellFile(opts.tool, osLabel())) ?? buildCell(opts.tool);
  if (!cell.ok) {
    console.error(`${opts.tool} on ${osLabel()}: failed (see the step summary and the uploaded results)`);
    process.exit(1);
  }
  console.log(`${opts.tool} on ${osLabel()}: ok`);
} else {
  console.error('Usage: node scripts/standalone/report.mjs <cell --tool <tool>|aggregate <dir>|verdict --tool <tool>>');
  process.exit(2);
}
