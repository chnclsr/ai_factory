#!/usr/bin/env node
// Memory layer benchmark. Builds a fixture of 10k events and 1000 pages in a temporary memory repo,
// then measures the write path and (once buildPack exists) the pack-build path.
//
//   node scripts/bench-memory.mjs           print results, exit 1 if a target is missed
//   node scripts/bench-memory.mjs --json    machine-readable output
//
// Targets come from docs/memory-plan.md section 6D.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { commitProject } from '../src/memory/store.mjs';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

const TARGETS = { writeP95Ms: 15, warmPackP95Ms: 10, coldPackP95Ms: 40, readPathGitProcesses: 0, noChangeResumeTokens: 0, recallAt5: 0.95 };
const SESSIONS = 200;
const EVENTS_PER_SESSION = 50;
const PAGES = 1000;

function percentile(samples, q) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

export function p95(samples) {
  return percentile(samples, 0.95);
}

function words(n, seed) {
  const vocab = ['router', 'fallback', 'session', 'engine', 'quota', 'watchdog', 'claude', 'codex', 'vibe', 'muse',
    'opencode', 'refactor', 'test', 'handoff', 'memory', 'commit', 'project', 'index', 'budget', 'token'];
  let out = [];
  for (let i = 0; i < n; i++) out.push(vocab[(seed * 31 + i * 7) % vocab.length]);
  return out.join(' ');
}

// Counts child processes spawned while fn runs; the read path must spawn none.
function countSpawns(fn) {
  let count = 0;
  const originals = {};
  for (const name of ['spawn', 'spawnSync', 'execSync', 'execFileSync', 'execFile', 'exec']) {
    originals[name] = childProcess[name];
    childProcess[name] = (...args) => { count++; return originals[name](...args); };
  }
  syncBuiltinESMExports();
  try { return { value: fn(), count }; } finally {
    Object.assign(childProcess, originals);
    syncBuiltinESMExports();
  }
}

export function buildFixture(repo, project = 'bench') {
  const sessionIds = [];
  commitProject(repo, project, { subject: 'fixture', trailers: { Kind: 'fixture' } }, view => {
    view.write('project.json', JSON.stringify({ key: project }));
    for (let s = 0; s < SESSIONS; s++) {
      const sid = `bench-${String(s).padStart(4, '0')}`;
      sessionIds.push(sid);
      let jsonl = '';
      for (let n = 1; n <= EVENTS_PER_SESSION; n++) {
        jsonl += JSON.stringify({ kind: 'turn', n, seq: 1, ts: new Date(0).toISOString(), engine: 'vibe', model: 'vibe-glm-5.3-flash', ok: true,
          task: words(20, s * 100 + n), response_head: words(120, s + n), files: [{ path: `src/f${n}.mjs`, status: 'M', add: 3, del: 1 }] }) + '\n';
      }
      view.writeRaw(`sessions/${sid}.jsonl`, jsonl);
      view.writeRaw(`sessions/${sid}.meta.json`, JSON.stringify({ sid, updated: new Date(s * 1000).toISOString(), engine_sessions: {}, last_injected_seq: {} }));
    }
    for (let p = 0; p < PAGES; p++) {
      view.writeRaw(`pages/page-${String(p).padStart(4, '0')}.md`, `---\nversion: 1\n---\n# Page ${p}\n${words(200, p)}\n`);
    }
  });
  return sessionIds;
}

// Raw cost of the file operations one commit needs (8 object creates plus the ref lock cycle),
// with no hashing or compression. On hosts with on-access scanning this floor alone can exceed the
// write target; the report prints it so a miss can be attributed.
function measureFsFloor(dir, rounds = 200) {
  const floor = path.join(dir, 'fs-floor');
  fs.mkdirSync(floor, { recursive: true });
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const start = process.hrtime.bigint();
    for (let k = 0; k < 8; k++) fs.writeFileSync(path.join(floor, `o${i}-${k}`), Buffer.alloc(600, i + k), { flag: 'wx' });
    const lock = path.join(floor, `ref${i}.lock`);
    const fd = fs.openSync(lock, 'wx');
    fs.writeSync(fd, 'x'.repeat(41));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(lock, path.join(floor, `ref${i}`));
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { p50Ms: +percentile(samples, 0.5).toFixed(2), p95Ms: +percentile(samples, 0.95).toFixed(2) };
}

// recall@5 on the canary eval set (src/memory/eval-fixture.mjs) with 2000 distractors.
async function evalRecall(dir) {
  const { writeEvalProject, recallAt } = await import('../src/memory/eval-fixture.mjs');
  const { search } = await import('../src/memory/search.mjs');
  const repo = path.join(dir, 'eval.git');
  const file = path.join(dir, 'eval-index.sqlite');
  const cases = writeEvalProject(repo, 'eval', { distractors: 2000 });
  const rank = query => search(repo, { projectKey: 'eval', query, index: { file }, limit: 5 }).map(i => i.id);
  const out = {};
  for (const set of ['lexical', 'inflected']) {
    const { recall, hits, total } = recallAt(cases.filter(c => c.set === set), rank);
    out[set] = { recall, hits, total };
  }
  return out;
}

export async function runBench({ quiet = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-bench-'));
  const repo = path.join(dir, 'memory.git');
  const results = { targets: TARGETS };
  try {
    results.fsFloor = measureFsFloor(dir);
    const sessionIds = buildFixture(repo);
    const writes = [];
    for (let i = 0; i < 200; i++) {
      const sid = sessionIds[(i * 37) % sessionIds.length];
      const start = process.hrtime.bigint();
      commitProject(repo, 'bench', { subject: `turn ${i}`, trailers: { Session: sid, Engine: 'vibe', Kind: 'turn' } }, view => {
        const n = EVENTS_PER_SESSION + i + 1;
        view.appendLine(`sessions/${sid}.jsonl`, JSON.stringify({ n, task: words(20, i), response_head: words(400, i) }));
        view.write(`sessions/${sid}/turns/${n}.response.md`, words(2000, i));
        const meta = JSON.parse(view.read(`sessions/${sid}.meta.json`));
        meta.last_injected_seq[`vibe:${sid}`] = view.seq;
        view.write(`sessions/${sid}.meta.json`, JSON.stringify(meta));
      });
      writes.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    results.write = { samples: writes.length, p50Ms: +percentile(writes, 0.5).toFixed(2), p95Ms: +p95(writes).toFixed(2) };

    let packModule = null;
    try { packModule = await import('../src/memory/pack.mjs'); } catch {}
    // Step 6: the derived index is built once (as the first router call after an upgrade would)
    // and kept in step incrementally; packs then read L2 from it.
    const indexFile = path.join(dir, 'memory-index.sqlite');
    const { openIndex, syncRef, closeIndex } = await import('../src/memory/fts.mjs');
    const idx = openIndex(indexFile);
    if (idx) {
      let start = process.hrtime.bigint();
      syncRef(idx, repo, 'refs/heads/p/bench');
      results.indexBuild = { fullMs: Math.round(Number(process.hrtime.bigint() - start) / 1e6) };
      commitProject(repo, 'bench', { subject: 'one more turn', trailers: { Kind: 'turn' } }, view => {
        view.appendLine(`sessions/${sessionIds[0]}.jsonl`, JSON.stringify({ kind: 'turn', n: 9999, seq: view.seq, task: 'incremental index probe', response_head: 'ok' }));
      });
      start = process.hrtime.bigint();
      syncRef(idx, repo, 'refs/heads/p/bench');
      results.indexBuild.incrementalMs = +(Number(process.hrtime.bigint() - start) / 1e6).toFixed(2);
    }
    if (packModule?.benchPack) {
      const pack = packModule.benchPack({ repo, project: 'bench', sessionIds, countSpawns, dir, indexFile: idx ? indexFile : null });
      Object.assign(results, pack);
      results.packBackend = idx ? 'fts' : 'scan';
    } else {
      results.pack = 'not built yet (step 4)';
    }
    if (idx) {
      closeIndex(indexFile);
      results.recall = await evalRecall(dir);
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }

  const failures = [];
  if (results.write.p95Ms >= TARGETS.writeP95Ms) failures.push(`write p95 ${results.write.p95Ms} ms >= ${TARGETS.writeP95Ms}`);
  if (results.warmPack && results.warmPack.p95Ms >= TARGETS.warmPackP95Ms) failures.push(`warm pack p95 ${results.warmPack.p95Ms} ms >= ${TARGETS.warmPackP95Ms}`);
  if (results.readPathGitProcesses !== undefined && results.readPathGitProcesses > 0) failures.push(`read path spawned ${results.readPathGitProcesses} processes`);
  if (results.noChangeResumeTokens !== undefined && results.noChangeResumeTokens > 0) failures.push(`no-change resume injected ${results.noChangeResumeTokens} tokens`);
  if (results.overBudget) failures.push(`pack exceeded budget ${results.overBudget} times`);
  if (results.recall && results.recall.lexical.recall < TARGETS.recallAt5) failures.push(`recall@5 ${results.recall.lexical.recall} < ${TARGETS.recallAt5}`);
  results.failures = failures;
  if (!quiet) {
    if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
    else {
      console.log(`fs floor     p50 ${results.fsFloor.p50Ms} ms   p95 ${results.fsFloor.p95Ms} ms   (8 creates + lock/rename, no git work)`);
      console.log(`write        p50 ${results.write.p50Ms} ms   p95 ${results.write.p95Ms} ms   (target < ${TARGETS.writeP95Ms})`);
      if (results.coldPack) console.log(`pack cold    p95 ${results.coldPack.p95Ms} ms   (target < ${TARGETS.coldPackP95Ms}, informational)`);
      if (results.warmPack) console.log(`pack warm    p95 ${results.warmPack.p95Ms} ms   (target < ${TARGETS.warmPackP95Ms})`);
      if (results.readPathGitProcesses !== undefined) console.log(`read-path processes spawned: ${results.readPathGitProcesses}`);
      if (results.noChangeResumeTokens !== undefined) console.log(`no-change resume tokens: ${results.noChangeResumeTokens}`);
      if (results.maxTokensOverBudget !== undefined) console.log(`max pack tokens / budget: ${results.maxTokensOverBudget}`);
      if (results.indexBuild) console.log(`index build  full ${results.indexBuild.fullMs} ms   incremental ${results.indexBuild.incrementalMs} ms   (pack L2 backend: ${results.packBackend})`);
      if (results.recall) for (const [set, r] of Object.entries(results.recall)) console.log(`recall@5     ${set.padEnd(10)} ${r.recall} (${r.hits}/${r.total})${set === 'lexical' ? `   (target >= ${TARGETS.recallAt5})` : '   (informational)'}`);
      if (typeof results.pack === 'string') console.log(`pack: ${results.pack}`);
      console.log(failures.length ? 'FAIL\n  ' + failures.join('\n  ') : 'PASS');
    }
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const results = await runBench();
  process.exit(results.failures.length ? 1 : 0);
}
