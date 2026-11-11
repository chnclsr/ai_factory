import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readCommit, readRef, writeBlob, writeTree, hashObject, compareAndSwapRef } from './gitobj.mjs';
import { commitProject, snapshotProject, writePage, uuidv7, parseFrontMatter } from './store.mjs';
import { projectRef } from './project.mjs';
import { sanitizeText } from './sanitize.mjs';
import { tempDir, fsck } from './test-helpers.mjs';

const here = import.meta.dirname;

test('objects match git hash-object and the repo passes git fsck --strict', t => {
  const repo = path.join(tempDir(t, 'mem-obj-'), 'memory.git');
  commitProject(repo, 'demo', { subject: 'first', trailers: { Session: 's1', Kind: 'turn' } }, view => {
    view.write('project.json', JSON.stringify({ key: 'demo' }));
    view.write('sessions/s1.jsonl', '{"n":1}\n');
    view.write('dir with space/ü.txt', 'unicode name');
  });
  const expected = spawnSync('git', ['hash-object', '--stdin'], { input: 'hello\n', encoding: 'utf8' }).stdout.trim();
  assert.equal(hashObject('blob', 'hello\n').sha, expected);
  assert.equal(writeBlob(repo, 'hello\n'), expected);
  // Tree entry order must follow git: "a.b" sorts before the directory "a" (compared as "a/").
  const tree = writeTree(repo, [
    { mode: '40000', name: 'a', sha: snapshotProject(repo, 'demo').tree },
    { mode: '100644', name: 'a.b', sha: expected },
    { mode: '100644', name: 'a-b', sha: expected }
  ]);
  const listed = spawnSync('git', ['--git-dir', repo, 'ls-tree', tree], { encoding: 'utf8' }).stdout;
  assert.deepEqual(listed.trim().split('\n').map(line => line.split('\t')[1]), ['a-b', 'a.b', 'a']);
  const result = fsck(repo);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const log = spawnSync('git', ['--git-dir', repo, 'log', '--format=%an <%ae>|%(trailers:key=Seq,valueonly)', projectRef('demo')], { encoding: 'utf8' });
  assert.equal(log.stdout.trim(), 'ai-factory <ai-factory@localhost>|1');
  assert.equal(snapshotProject(repo, 'demo').read('dir with space/ü.txt'), 'unicode name');
});

test('4 processes x 50 commits form one gapless linear chain', async t => {
  const dir = tempDir(t, 'mem-race-');
  const repo = path.join(dir, 'memory.git');
  const worker = path.join(dir, 'worker.mjs');
  fs.writeFileSync(worker, `
import { commitProject } from ${JSON.stringify(pathToFileURL(path.join(here, 'store.mjs')).href)};
const [repo, id] = process.argv.slice(2);
for (let i = 0; i < 50; i++) {
  commitProject(repo, 'race', { subject: 'w' + id + ' ' + i, trailers: { Session: 'w' + id, Kind: 'turn' } }, view => {
    view.appendLine('sessions/w' + id + '.jsonl', JSON.stringify({ n: i + 1 }));
  });
}
`);
  const runs = [0, 1, 2, 3].map(id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, repo, String(id)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => code === 0 ? resolve() : reject(new Error(err)));
  }));
  await Promise.all(runs);
  const seqs = [];
  let sha = readRef(repo, projectRef('race'));
  while (sha) {
    const commit = readCommit(repo, sha);
    assert.ok(commit.parents.length <= 1);
    seqs.push(commit.seq);
    sha = commit.parents[0];
  }
  assert.deepEqual(seqs.reverse(), Array.from({ length: 200 }, (_, i) => i + 1));
  const snapshot = snapshotProject(repo, 'race');
  for (const id of [0, 1, 2, 3]) {
    assert.equal(snapshot.read(`sessions/w${id}.jsonl`).trim().split('\n').length, 50);
  }
  const result = fsck(repo);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('compare-and-swap refuses a stale old value', t => {
  const repo = path.join(tempDir(t, 'mem-cas-'), 'memory.git');
  const first = commitProject(repo, 'cas', { subject: 'a' }, view => view.write('a', '1'));
  commitProject(repo, 'cas', { subject: 'b' }, view => view.write('a', '2'));
  assert.equal(compareAndSwapRef(repo, projectRef('cas'), first.sha, first.sha), false);
  assert.notEqual(readRef(repo, projectRef('cas')), first.sha);
  assert.equal(fs.existsSync(path.join(repo, 'refs', 'heads', 'p', 'cas.lock')), false);
});

test('two page edits from the same base keep both versions', t => {
  const repo = path.join(tempDir(t, 'mem-page-'), 'memory.git');
  writePage(repo, 'pages', { slug: 'decisions', body: 'v1 body' });
  const base = snapshotProject(repo, 'pages').blobSha('pages/decisions.md');
  const a = writePage(repo, 'pages', { slug: 'decisions', body: 'edit from A', base, session: 'A' });
  const b = writePage(repo, 'pages', { slug: 'decisions', body: 'edit from B', base, session: 'B' });
  assert.equal(a.result.conflict, false);
  assert.equal(b.result.conflict, true);
  const snap = snapshotProject(repo, 'pages');
  const latest = parseFrontMatter(snap.read('pages/decisions.md'));
  assert.equal(latest.body, 'edit from B');
  assert.equal(latest.meta.version, '3');
  assert.ok(latest.meta.conflict_with);
  assert.equal(parseFrontMatter(snap.read('pages/decisions.v2.md')).body, 'edit from A');
  assert.equal(fsck(repo).status, 0);
});

test('sanitizer masks credentials before they reach the store', t => {
  const repo = path.join(tempDir(t, 'mem-san-'), 'memory.git');
  const secrets = [
    'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    '1234567890:AAH-abcdefghijklmnopqrstuvwxyz01234',
    'Authorization: Bearer abc.def.ghijklmnop',
    'OPENAI_API_KEY=supersecretvalue123'
  ];
  commitProject(repo, 'san', { subject: 'secret ' + secrets[0] }, view => view.write('x.txt', secrets.join('\n')));
  const stored = snapshotProject(repo, 'san').read('x.txt');
  for (const fragment of ['AAAAAAAAAAAAAAAA', 'abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz01234', 'ghijklmnop', 'supersecretvalue123']) {
    assert.ok(!stored.includes(fragment), fragment);
  }
  assert.match(stored, /OPENAI_API_KEY=\*\*\*/);
  const message = readCommit(repo, readRef(repo, projectRef('san'))).message;
  assert.ok(!message.includes('AAAAAAAAAAAAAAAA'));
  assert.equal(sanitizeText('x'.repeat(10), { maxBytes: 4 }), 'xxxx\n[truncated]');
});

test('uuidv7 is time ordered and well formed', () => {
  const a = uuidv7(1000);
  const b = uuidv7(2000);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a < b);
});
