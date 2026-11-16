#!/usr/bin/env node
// Memory eval harness (docs/memory-harness-plan.md section 4).
//
//   node scripts/memory-eval.mjs                      layer 1: deterministic, fake engines, no LLM
//   node scripts/memory-eval.mjs --only followup,KESTREL   run scenarios whose id or category matches
//   node scripts/memory-eval.mjs --save-baseline      store this run as src/memory/eval/baseline.json
//   node scripts/memory-eval.mjs --set conversation_tokens=0   override memory settings for this run
//   node scripts/memory-eval.mjs --json               print the report as JSON
//   node scripts/memory-eval.mjs --sweep conversation_tokens=0,400,800,1600,2400
//                                                     layer 1 once per value (threshold sweep)
//   AI_FACTORY_LIVE=1 node scripts/memory-eval.mjs --live [--engines vibe,muse,claude] [--runs 1]
//                                                     layer 2: real engines answer, a judge grades
//   AI_FACTORY_LIVE=1 node scripts/memory-eval.mjs --live --replay
//                                                     layer 3: exported real sessions (see --export)
//   node scripts/memory-eval.mjs --export <project> <session> [--name <file>]
//                                                     copy a real session from .runtime/memory.git
//                                                     into .runtime/memory-eval/replays (never committed)
//
// Every run writes a report to .runtime/memory-eval/. Layer 1 exits 1 when a scenario regresses
// against the stored baseline.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runSuite, summarise, compareToBaseline } from '../src/memory/eval/runner.mjs';
import { scenarios } from '../src/memory/eval/scenarios.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, '.runtime', 'memory-eval');
const BASELINE = path.join(ROOT, 'src', 'memory', 'eval', 'baseline.json');

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const value = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function gitVersion() {
  try { return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

function overrides() {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--set') continue;
    const [key, raw] = String(argv[i + 1] || '').split('=');
    if (key) out[key] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return out;
}

function select(all) {
  const only = value('--only');
  if (!only) return all;
  const wanted = only.split(',').map(s => s.trim()).filter(Boolean);
  return all.filter(s => wanted.some(w => s.id.includes(w) || s.category === w));
}

function writeReport(kind, report) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

function printTable(results) {
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    const detail = r.error || [r.missing?.length ? `missing ${r.missing.join(',')}` : '', r.leaked?.length ? `leaked ${r.leaked.join(',')}` : '',
      ...(r.checks || [])].filter(Boolean).join('; ');
    console.log(`${status}  ${r.gate ? '*' : ' '} ${r.id.padEnd(30)} ${String(r.category).padEnd(24)} ${String(r.blockTokens ?? '-').padStart(5)}/${String(r.budget ?? '-').padEnd(5)} ${detail}`);
  }
}

async function layerOne() {
  const set = select(scenarios());
  const settings = overrides();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-eval-'));
  const started = Date.now();
  let results;
  try {
    results = await runSuite(set, { dir, concurrency: Number(value('--concurrency')) || 6,
      mutateConfig: cfg => { cfg.memory = { ...cfg.memory, ...settings }; } });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  }
  const report = { layer: 1, version: gitVersion(), date: new Date().toISOString(), settings, ms: Date.now() - started,
    summary: summarise(results), results };
  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  report.comparison = baseline ? compareToBaseline(results, baseline) : null;
  const file = writeReport('layer1', report);
  if (flag('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    printTable(results);
    const s = report.summary;
    console.log(`\n${s.passed}/${s.scenarios} passed, coverage ${s.coverage}, gated coverage ${s.gatedCoverage}, over budget ${s.overBudget}, ${report.ms} ms`);
    if (report.comparison) {
      console.log(`vs baseline ${baseline.version}: ${report.comparison.improvements.length} improved, ${report.comparison.regressions.length} regressed`);
      for (const r of report.comparison.regressions) console.log(`  REGRESSION ${r.id}: ${r.before} -> ${r.after}`);
    }
    console.log(`report: ${file}`);
  }
  if (flag('--save-baseline')) {
    fs.writeFileSync(BASELINE, JSON.stringify({ version: report.version, date: report.date, summary: report.summary,
      results: results.map(r => ({ id: r.id, category: r.category, gate: r.gate, pass: r.pass, coverage: r.coverage })) }, null, 2) + '\n');
    console.log(`baseline saved: ${BASELINE}`);
  }
  return report.comparison?.regressions.length ? 1 : 0;
}

// --sweep conversation_tokens=400,800,1600: layer 1 once per value, to find where coverage drops.
// Sweeping conversation_tokens also removes per-model overrides so every engine gets the value.
async function sweep(spec) {
  const [key, list] = spec.split('=');
  const values = String(list || '').split(',').map(Number).filter(Number.isFinite);
  if (!key || !values.length) { console.error('Usage: --sweep <setting>=<v1>,<v2>,...'); return 1; }
  const set = select(scenarios());
  console.log(`${key.padStart(20)}  passed  coverage  gated  avg block tokens`);
  for (const v of values) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-sweep-'));
    try {
      const results = await runSuite(set, { dir, concurrency: 6, mutateConfig: cfg => {
        cfg.memory = { ...cfg.memory, [key]: v };
        if (key === 'conversation_tokens') for (const e of Object.values(cfg.engines)) for (const m of Object.values(e.models || {})) delete m.memory_conversation_tokens;
      } });
      const s = summarise(results);
      const avg = Math.round(results.reduce((n, r) => n + (r.blockTokens || 0), 0) / Math.max(1, results.length));
      console.log(`${String(v).padStart(20)}  ${`${s.passed}/${s.scenarios}`.padStart(6)}  ${String(s.coverage).padStart(8)}  ${String(s.gatedCoverage).padStart(5)}  ${String(avg).padStart(16)}`);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    }
  }
  return 0;
}

async function main() {
  if (value('--sweep')) return sweep(value('--sweep'));
  if (flag('--export')) {
    const { exportSession } = await import('../src/memory/eval/live.mjs');
    const i = argv.indexOf('--export');
    const file = exportSession({ project: argv[i + 1], session: argv[i + 2], name: value('--name') });
    console.log(`exported: ${file}`);
    return 0;
  }
  if (flag('--live')) {
    const { runLive } = await import('../src/memory/eval/live.mjs');
    const report = await runLive({
      scenarios: flag('--replay') ? null : select(scenarios()), replay: flag('--replay'),
      engines: (value('--engines') || 'vibe,muse,claude').split(','), runs: Number(value('--runs')) || 1,
      judge: value('--judge'), settings: overrides(), log: line => console.log(line)
    });
    report.version = gitVersion();
    console.log(`report: ${writeReport('live', report)}`);
    return 0;
  }
  return layerOne();
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(1); });
