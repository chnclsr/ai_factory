import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from './router-harness.mjs';
import { tempDir, fsck } from './test-helpers.mjs';
import { commitProject, snapshotProject, writePage } from './store.mjs';
import { readRef, readCommit } from './gitobj.mjs';
import { projectRef } from './project.mjs';
import { listSessions, readTurns, readAliases } from './session.mjs';
import { followMoves, renameProject, mergeProjects, describeProjects } from './projects.mjs';
import { search } from './search.mjs';
import { closeIndex } from './fts.mjs';
import { runMemoryCli } from './cli.mjs';

function project(dir, name) {
  const cwd = path.join(dir, name);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, '.ai-factory.toml'), `project = "${name}"\n`);
  return cwd;
}

function seed(repo, key, sid, alias, task) {
  commitProject(repo, key, { subject: 'seed', trailers: { Session: sid, Kind: 'turn' } }, view => {
    view.write('project.json', JSON.stringify({ key }));
    view.appendLine(`sessions/${sid}.jsonl`, JSON.stringify({ kind: 'turn', n: 1, seq: view.seq, engine: 'claude', model: 'm', ok: true, task, response_head: 'ok' }));
    view.write(`sessions/${sid}.meta.json`, JSON.stringify({ sid, alias, updated: new Date().toISOString() }));
    const aliases = JSON.parse(view.read('session-aliases.json') || '{}');
    aliases[alias] = sid;
    view.write('session-aliases.json', JSON.stringify(aliases));
  });
}

function cli(repo, args, { indexFile = null } = {}) {
  let out = '';
  let err = '';
  const io = { out: s => { out += s; }, err: s => { err += s; }, isTTY: false };
  return runMemoryCli(args, { repoDir: repo, indexFile, io }).then(code => ({ code, out, err }));
}

test('rename keeps the history, moves the key and leaves the old key resolving to the new one', t => {
  const dir = tempDir(t, 'mem-proj-');
  const repo = path.join(dir, 'memory.git');
  seed(repo, 'old', 's-old', 'main', 'tune the parser for quoted strings');
  writePage(repo, 'old', { slug: 'decisions', body: 'Parser keeps quotes.' });
  const before = readRef(repo, projectRef('old'));

  renameProject(repo, 'old', 'new');
  assert.equal(fsck(repo).status, 0, fsck(repo).stderr);
  const renamedHead = readCommit(repo, readRef(repo, projectRef('new')));
  assert.deepEqual(renamedHead.parents, [before], 'the new ref continues the old chain');
  assert.equal(renamedHead.trailers.Kind, 'project-rename');
  const moved = snapshotProject(repo, 'old');
  assert.deepEqual(moved.list('').map(e => e.name), ['project.json']);
  assert.equal(readCommit(repo, moved.sha).parents[0], before, 'nothing recorded becomes unreachable');

  assert.equal(followMoves(repo, { key: 'old' }).key, 'new');
  assert.equal(followMoves(repo, { key: 'old' }).movedFrom, 'old');
  assert.equal(followMoves(repo, { key: 'new' }).key, 'new');
  const snapshot = snapshotProject(repo, 'new');
  assert.equal(readAliases(snapshot).main, 's-old');
  assert.deepEqual(JSON.parse(snapshot.read('project.json')).aliases, ['old']);

  assert.throws(() => renameProject(repo, 'old', 'other'), /already moved/);
  seed(repo, 'taken', 's-t', 'x', 'unrelated');
  assert.throws(() => renameProject(repo, 'new', 'taken'), /already exists/);
  assert.equal(readRef(repo, projectRef('new')), snapshot.sha, 'a refused rename changes nothing');
  assert.deepEqual(describeProjects(repo).map(p => [p.key, p.movedTo]), [['new', null], ['old', 'new'], ['taken', null]]);
});

test('merge is lossless: both chains are parents, clashes are kept side by side, and the source then resolves to the target', t => {
  const dir = tempDir(t, 'mem-proj-');
  const repo = path.join(dir, 'memory.git');
  const file = path.join(dir, 'memory-index.sqlite');
  t.after(() => closeIndex(file));
  seed(repo, 'api', 's-api', 'main', 'add pagination to the orders endpoint');
  seed(repo, 'web', 's-web', 'main', 'render the orders table with pagination');
  for (let i = 0; i < 3; i++) seed(repo, 'web', `s-web-${i}`, `w${i}`, `web chore ${i}`);
  writePage(repo, 'api', { slug: 'conventions', body: 'API: snake_case fields.' });
  writePage(repo, 'web', { slug: 'conventions', body: 'Web: camelCase props.' });
  writePage(repo, 'web', { slug: 'conventions', body: 'Web: camelCase props, v2.', base: 'stale' });
  const apiHead = readRef(repo, projectRef('api'));
  const webHead = readRef(repo, projectRef('web'));
  const webSeq = readCommit(repo, webHead).seq;
  assert.equal(search(repo, { projectKey: 'web', query: 'orders pagination', global: true, index: { file } }).length, 2);

  const report = mergeProjects(repo, 'api', 'web');
  assert.equal(fsck(repo).status, 0, fsck(repo).stderr);
  const merge = readCommit(repo, readRef(repo, projectRef('web')));
  assert.deepEqual(merge.parents, [webHead, apiHead]);
  assert.equal(merge.seq, webSeq + 1, 'Seq continues from the longer chain');
  assert.equal(report.aliasRenames.main, 'main@api');
  assert.deepEqual(report.conflicts.map(c => c.sourceCopy), ['pages/conventions.from-api.md']);

  const snapshot = snapshotProject(repo, 'web');
  assert.deepEqual(listSessions(snapshot).map(s => s.sid).sort(), ['s-api', 's-web', 's-web-0', 's-web-1', 's-web-2']);
  assert.equal(readTurns(snapshot, 's-api')[0].task, 'add pagination to the orders endpoint');
  assert.deepEqual(readAliases(snapshot), { main: 's-web', 'main@api': 's-api', w0: 's-web-0', w1: 's-web-1', w2: 's-web-2' });
  assert.match(snapshot.read('pages/conventions.md'), /camelCase props, v2/);
  assert.match(snapshot.read('pages/conventions.from-api.md'), /snake_case/);
  assert.ok(snapshot.read('pages/conventions.v1.md'), 'the target\'s own kept version is untouched');
  assert.equal(followMoves(repo, { key: 'api' }).key, 'web');
  assert.throws(() => mergeProjects(repo, 'api', 'web'), /already moved/);
  assert.throws(() => mergeProjects(repo, 'web', 'web'), /itself/);

  // The index drops the moved ref, so a global search shows each document once, under the target.
  const global = search(repo, { projectKey: 'web', query: 'orders pagination', global: true, index: { file } });
  assert.deepEqual(global.map(i => `${i.project}:${i.id}`).sort(), ['web:s-api#1', 'web:s-web#1']);
  assert.deepEqual(search(repo, { projectKey: 'web', query: 'snake_case', index: { file } }).map(i => i.id), ['pages/conventions.from-api.md']);
});

test('memory project commands: list, and rename/merge only with --yes', async t => {
  const dir = tempDir(t, 'mem-proj-');
  const repo = path.join(dir, 'memory.git');
  seed(repo, 'alpha', 's1', 'a', 'alpha work');
  seed(repo, 'beta', 's2', 'b', 'beta work');
  let r = await cli(repo, ['project', 'rename', 'alpha', 'gamma', '--cwd', dir]);
  assert.equal(r.code, 2);
  assert.equal(followMoves(repo, { key: 'alpha' }).key, 'alpha');
  r = await cli(repo, ['project', 'rename', 'alpha', 'gamma', '--yes', '--cwd', dir]);
  assert.equal(r.code, 0, r.err);
  r = await cli(repo, ['project', 'merge', 'beta', 'gamma', '--yes', '--cwd', dir]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Merged beta into gamma: \d+ file\(s\) added, 0 kept side by side/);
  r = await cli(repo, ['project', 'merge', 'nope', 'gamma', '--yes', '--cwd', dir]);
  assert.equal(r.code, 1);
  assert.match(r.err, /does not exist/);
  r = await cli(repo, ['project', 'list', '--cwd', dir]);
  assert.match(r.out, /^alpha -> gamma$/m);
  assert.match(r.out, /^beta -> gamma$/m);
  assert.match(r.out, /^gamma seq \d+, 2 session\(s\), aliases: alpha, beta$/m);
});

test('router calls follow a renamed project: --resume finds the session and new turns land on the new key', t => {
  const h = makeHarness(t);
  const cwd = project(h.dir, 'before');
  let result = h.run(['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--name', 'work', '--cwd', cwd,
    '--task', 'write the first draft of the changelog entry']);
  assert.equal(result.status, 0, result.stderr);
  result = h.run(['memory', 'project', 'rename', 'before', 'after', '--yes', '--cwd', cwd]);
  assert.equal(result.status, 0, result.stderr);

  // .ai-factory.toml still says "before"; the call resumes the same memory session under "after".
  result = h.run(['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--resume', 'work', '--cwd', cwd,
    '--task', 'tighten the changelog entry wording']);
  assert.equal(result.status, 0, result.stderr);
  const snapshot = snapshotProject(h.repo, 'after');
  const [session] = listSessions(snapshot);
  assert.deepEqual(readTurns(snapshot, session.sid).filter(x => x.kind === 'turn').map(x => x.task),
    ['write the first draft of the changelog entry', 'tighten the changelog entry wording']);
  assert.deepEqual(snapshotProject(h.repo, 'before').list('').map(e => e.name), ['project.json']);
  assert.equal(fsck(h.repo).status, 0);
});

test('boolean flags never swallow the next argument: handoff list --all --cwd <dir> reads that project', async t => {
  const dir = tempDir(t, 'mem-proj-');
  const repo = path.join(dir, 'memory.git');
  const cwd = project(dir, 'flags');
  let r = await cli(repo, ['handoff', 'begin', '--to', 'claude', '--task', 'port the exporter', '--cwd', cwd]);
  assert.equal(r.code, 0, r.err);
  const hid = r.out.match(/handoff: (\S+)/)[1];
  r = await cli(repo, ['handoff', 'list', '--all', '--cwd', cwd]);
  assert.match(r.out, new RegExp(`^${hid} open to=claude`, 'm'));
});
