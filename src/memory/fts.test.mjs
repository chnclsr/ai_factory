import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './test-helpers.mjs';
import { commitProject, writePage } from './store.mjs';
import { openIndex, closeIndex, syncRef, indexStats, ftsQuery, stmt } from './fts.mjs';
import { searchWithInfo, search, terms } from './search.mjs';
import { buildPack } from './pack.mjs';
import { projectRef } from './project.mjs';
import { writeEvalProject, recallAt } from './eval-fixture.mjs';

const childProcess = createRequire(import.meta.url)('node:child_process');

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

function setup(t) {
  const dir = tempDir(t, 'mem-fts-');
  const repo = path.join(dir, 'memory.git');
  const file = path.join(dir, 'memory-index.sqlite');
  t.after(() => closeIndex(file));
  return { dir, repo, file };
}

function addTurn(repo, project, sid, n, task, { cwd = '', seq } = {}) {
  return commitProject(repo, project, { subject: `turn ${n}`, trailers: { Session: sid, Kind: 'turn' } }, view => {
    view.appendLine(`sessions/${sid}.jsonl`, JSON.stringify({ kind: 'turn', n, seq: seq ?? view.seq, ts: new Date().toISOString(),
      engine: 'claude', model: 'haiku', ok: true, task, response_head: `done: ${task}`, cwd, files: [{ path: 'a.txt', status: 'M', add: 1, del: 0 }] }));
    view.write(`sessions/${sid}.meta.json`, JSON.stringify({ sid, updated: new Date().toISOString() }));
  });
}

test('sync is incremental: an unchanged ref costs nothing and an appended turn adds one row', t => {
  const { repo, file } = setup(t);
  addTurn(repo, 'demo', 's1', 1, 'configure the watchdog idle timeout');
  writePage(repo, 'demo', { slug: 'design', body: 'The fallback chain starts with vibe and ends with gemini.' });
  const idx = openIndex(file);
  const first = syncRef(idx, repo, projectRef('demo'));
  assert.equal(first.changed, true);
  assert.equal(indexStats(idx).docs, 2);
  const firstRowId = stmt(idx, "SELECT id FROM docs WHERE doc_id = 's1#1'").get().id;

  assert.equal(syncRef(idx, repo, projectRef('demo')).changed, false);

  addTurn(repo, 'demo', 's1', 2, 'raise the quota warning threshold');
  const second = syncRef(idx, repo, projectRef('demo'));
  assert.equal(second.files, 1, 'only the session log changed');
  assert.equal(indexStats(idx).docs, 3);
  assert.equal(stmt(idx, "SELECT id FROM docs WHERE doc_id = 's1#1'").get().id, firstRowId, 'the unchanged turn keeps its row');

  // A page edit replaces its document; the superseded version file is not indexed.
  writePage(repo, 'demo', { slug: 'design', body: 'The fallback chain now skips codex.', base: 'stale-base-sha' });
  syncRef(idx, repo, projectRef('demo'));
  assert.equal(indexStats(idx).docs, 3);
  const hits = search(repo, { projectKey: 'demo', query: 'fallback chain codex', index: { file } });
  assert.equal(hits[0].id, 'pages/design.md');
  assert.match(hits[0].text, /skips codex/);
});

test('the index is derived: a deleted or corrupt file is rebuilt or bypassed, never trusted', t => {
  const { repo, file } = setup(t);
  addTurn(repo, 'demo', 's1', 1, 'rotate the telegram bot token monthly');
  const before = search(repo, { projectKey: 'demo', query: 'telegram rotation', index: { file } }).map(i => i.id);
  closeIndex(file);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  assert.deepEqual(search(repo, { projectKey: 'demo', query: 'telegram rotation', index: { file } }).map(i => i.id), before);

  closeIndex(file);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  fs.writeFileSync(file, 'this is not a sqlite database at all, just garbage bytes '.repeat(100));
  const errors = [];
  const result = searchWithInfo(repo, { projectKey: 'demo', query: 'telegram token', index: { file }, onError: e => errors.push(e) });
  assert.equal(result.backend, 'scan');
  assert.equal(errors.length, 1);
  assert.deepEqual(result.items.map(i => i.id), ['s1#1']);
});

test('FTS matching folds diacritics, matches suffixed forms by prefix and cannot be steered by query syntax', t => {
  const { repo, file } = setup(t);
  writePage(repo, 'demo', { slug: 'tr', body: 'Dosyaları yükleme sırasında şifreleme açık kalmalı.' });
  writePage(repo, 'demo', { slug: 'en', body: 'Uploads must keep encryption enabled.' });
  const ids = q => search(repo, { projectKey: 'demo', query: q, index: { file } }).map(i => i.id);
  assert.deepEqual(ids('dosya yukleme'), ['pages/tr.md'], 'prefix and diacritic folding');
  assert.deepEqual(ids('encrypting uploads'), ['pages/en.md'], 'porter stemming');
  assert.equal(ftsQuery(terms('a" OR body:* NEAR(x')), '"body"* OR "near"*');
  assert.doesNotThrow(() => ids('"unbalanced (quote AND OR NOT *'));
});

test('scopes: dir keeps to a subdirectory, mine reads only the personal ref, projects stay isolated, --global spans projects', t => {
  const { dir, repo, file } = setup(t);
  const sub = path.join(dir, 'work', 'api');
  addTurn(repo, 'alpha', 's1', 1, 'migrate the billing schema to v2', { cwd: sub });
  addTurn(repo, 'alpha', 's1', 2, 'billing dashboard colours', { cwd: path.join(dir, 'work', 'web') });
  addTurn(repo, 'beta', 's9', 1, 'billing export for beta only');
  writePage(repo, 'alpha', { slug: 'mine-note', body: 'I prefer billing reports on Fridays', scope: 'mine' });
  const run = opts => search(repo, { query: 'billing', index: { file }, ...opts }).map(i => `${i.project}:${i.id}`);

  assert.deepEqual(run({ projectKey: 'alpha', scope: 'dir', cwd: sub }), ['alpha:s1#1']);
  assert.deepEqual(run({ projectKey: 'alpha', scope: 'mine' }), ['personal:pages/mine-note.md']);
  assert.deepEqual(run({ projectKey: 'alpha' }).sort(), ['alpha:s1#1', 'alpha:s1#2']);
  assert.ok(!run({ projectKey: 'beta' }).some(id => id.startsWith('alpha:')));
  const global = run({ projectKey: 'alpha', global: true });
  assert.deepEqual(global.sort(), ['alpha:s1#1', 'alpha:s1#2', 'beta:s9#1']);
  assert.ok(!global.some(id => id.startsWith('personal:')), '--global never includes the personal ref');
  assert.throws(() => search(repo, { projectKey: 'alpha', query: 'x', scope: 'mine', global: true }), /--global/);
  // The scan fallback agrees on the same questions.
  assert.deepEqual(search(repo, { projectKey: 'alpha', query: 'billing', global: true }).map(i => `${i.project}:${i.id}`).sort(), global.sort());
});

test('index search and index-backed packs spawn no process', t => {
  const { repo, file } = setup(t);
  for (let i = 1; i <= 5; i++) addTurn(repo, 'demo', `s${i}`, 1, `investigate the router fallback ordering case ${i}`);
  const searched = countSpawns(() => search(repo, { projectKey: 'demo', query: 'router fallback ordering', index: { file } }));
  assert.equal(searched.count, 0);
  assert.equal(searched.value.length, 5);
  const packed = countSpawns(() => buildPack({ repoDir: repo, project: { key: 'demo' }, sid: 's1', cwd: '', scope: 'repo', indexFile: file,
    task: 'continue the router fallback ordering investigation', engine: 'vibe', model: 'x', routerConfig: {}, budget: 1200 }));
  assert.equal(packed.count, 0);
  assert.match(packed.value.text, /other session turn/);
  assert.doesNotMatch(packed.value.text, /other session turn[^\n]*case 1\b/, 'the current session is L1, never L2');
  assert.ok(packed.value.injected.filter(s => s.kind === 'turn').length <= 5);
});

test('6D: recall@5 on the lexical canary set is at least 0.95', t => {
  const { repo, file } = setup(t);
  const cases = writeEvalProject(repo, 'eval', { distractors: 400, sets: ['lexical'] });
  const rank = query => search(repo, { projectKey: 'eval', query, index: { file }, limit: 5 }).map(i => i.id);
  const result = recallAt(cases, rank);
  assert.ok(result.recall >= 0.95, JSON.stringify(result, null, 1));
});
