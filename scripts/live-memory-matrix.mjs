#!/usr/bin/env node
// Live memory canary over real engine CLIs. Runs only with AI_FACTORY_LIVE=1.
//
// For every configured model (or the ones named with --only engine/model,...):
//   1. tell:   a new session gives the model a random code word
//   2. recall: a different session in the same project asks for it; the reply must contain
//              "<word>-OK" (the suffix is never written anywhere, so a CLI echoing its prompt
//              cannot pass by accident)
// Once per engine:
//   3. isolation: the same question from another project must not mention the word
//
// Memory and router state live in a temporary data dir; nothing touches .runtime/memory.git.
// Results go to .runtime/memory-matrix.json. A model whose CLI is missing or out of quota is
// reported as "skip", never silently dropped.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER = path.join(ROOT, 'router.mjs');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'router_config.json'), 'utf8'));
const OUT = path.join(ROOT, '.runtime', 'memory-matrix.json');

if (process.env.AI_FACTORY_LIVE !== '1') {
  console.error('Set AI_FACTORY_LIVE=1 to run real engine CLIs.');
  process.exit(2);
}

const onlyArg = process.argv.find(a => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',').filter(Boolean) : null;
const ENGINES = ['vibe', 'opencode', 'muse', 'codex', 'claude'];
const targets = ENGINES.flatMap(engine => Object.keys(CONFIG.engines[engine]?.models || {}).map(model => ({ engine, model })))
  .filter(t => !only || only.includes(t.engine) || only.includes(`${t.engine}/${t.model}`));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-live-'));
const dataDir = path.join(work, 'state');
const env = { ...process.env, AI_FACTORY_DATA_DIR: dataDir };
delete env.AI_FACTORY_ROUTER_DEPTH;
delete env.AI_FACTORY_SESSION_ID;

function project(name) {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.ai-factory.toml'), `project = "${name}"\n`);
  return dir;
}

function runRouter(args) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [ROUTER, ...args], { env, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, out, err, ms: Date.now() - started }));
  });
}

function classify(result) {
  const text = (result.out + '\n' + result.err).toLowerCase();
  if (/is not recognized|command not found|enoent/.test(text)) return 'skip: CLI missing';
  if (/429|rate limit|quota|usage limit|insufficient|credit/.test(text)) return 'skip: quota or rate limit';
  if (/unauthorized|not logged in|login required|authenticate/.test(text)) return 'skip: not signed in';
  return null;
}

function tail(result) {
  return (result.out + '\n' + result.err).split('\n').filter(l => l.trim()).slice(-6).join(' | ').slice(0, 600);
}

// Answer from the prompt only; with no memory the honest reply is UNKNOWN, not a file search.
const ASK = 'An earlier session in this project recorded a code word. Do not search files or run tools. ' +
  'Reply with that code word immediately followed by -OK and nothing else; if you do not know it, reply exactly: UNKNOWN';

function modelFlags({ engine, model }) {
  return engine === 'muse' ? ['--engine', 'muse'] : ['--engine', engine, '--model', model];
}

async function canary(target) {
  const word = `PELICAN${crypto.randomInt(1000, 9999)}`;
  const dir = project(`live-${target.engine}-${target.model}`.replace(/[^a-z0-9.-]+/gi, '-').toLowerCase());
  const flags = [...modelFlags(target), '--no-fallback', '--cwd', dir];
  const tell = await runRouter([...flags, '--session', 'tell', '--task',
    `Remember this project code word for a later session: ${word}. Reply with exactly one word: noted`]);
  const row = { ...target, word, tell_ms: tell.ms };
  if (tell.code !== 0) {
    row.result = classify(tell) || 'fail: tell call failed';
    row.detail = tail(tell);
    return row;
  }
  const recall = await runRouter([...flags, '--session', 'recall', '--task',
    ASK]);
  row.recall_ms = recall.ms;
  if (recall.code !== 0) {
    row.result = classify(recall) || 'fail: recall call failed';
    row.detail = tail(recall);
    return row;
  }
  const answered = recall.out.includes(`${word}-OK`);
  row.result = answered ? 'pass' : 'fail: word not recalled';
  if (!answered) row.detail = tail(recall);
  row.memory_warnings = (recall.err.match(/\[AI Factory Memory\][^\n]*/g) || []).slice(0, 3);
  return row;
}

async function isolation(engine, rows) {
  const done = rows.find(r => r.engine === engine && r.result === 'pass');
  if (!done) return { engine, result: 'skip: no passing model to compare' };
  const dir = project(`live-isolation-${engine}`);
  const result = await runRouter([...modelFlags(done), '--no-fallback', '--cwd', dir, '--session', 'other', '--task',
    ASK]);
  // A failed call is still evidence: what matters is that the other project's word never shows up.
  const leaked = result.out.includes(done.word);
  return { engine, model: done.model, exit: result.code, result: leaked ? 'fail: word leaked across projects' : 'pass',
    detail: leaked || result.code !== 0 ? tail(result) : undefined };
}

const startedAt = new Date().toISOString();
const rows = [];
// Engines run in parallel; models of one engine run one after another to stay under rate limits.
await Promise.all(ENGINES.map(async engine => {
  for (const target of targets.filter(t => t.engine === engine)) {
    const row = await canary(target);
    rows.push(row);
    console.log(`${row.result.padEnd(32)} ${engine}/${target.model}${row.detail ? '  — ' + row.detail.slice(0, 200) : ''}`);
  }
}));
const isolationRows = [];
await Promise.all(ENGINES.filter(e => targets.some(t => t.engine === e)).map(async engine => {
  const row = await isolation(engine, rows);
  isolationRows.push(row);
  console.log(`isolation ${engine}: ${row.result}`);
}));

const report = { startedAt, finishedAt: new Date().toISOString(), workDir: work, canary: rows, isolation: isolationRows };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
const failed = [...rows, ...isolationRows].filter(r => r.result.startsWith('fail'));
console.log(`\n${rows.filter(r => r.result === 'pass').length}/${rows.length} models recalled; ${failed.length} failure(s). Report: ${OUT}`);
process.exit(failed.length ? 1 : 0);
