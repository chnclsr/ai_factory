import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, FAKE_SESSION_IDS } from './router-harness.mjs';
import { snapshotProject } from './store.mjs';
import { listSessions, readMeta, readTurns } from './session.mjs';
import { resolveProject, UNSCOPED_PROJECT } from './project.mjs';

function mkdirs(base, ...names) {
  return names.map(name => { const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true }); return dir; });
}

test('a legacy session_registry.json migrates and --resume finds the same engine sessions', t => {
  const h = makeHarness(t);
  const [work, elsewhere] = mkdirs(h.dir, 'legacy work', 'elsewhere');
  fs.mkdirSync(h.dataDir, { recursive: true });
  const registryFile = path.join(h.dataDir, 'session_registry.json');
  // Exactly what the pre-memory router wrote (see src/router.mjs registry write).
  fs.writeFileSync(registryFile, JSON.stringify({ sessions: {
    old: { engine: 'claude', model: 'claude-haiku-5-5', sessionId: '123e4567-e89b-42d3-a456-426614174000', cwd: work, updated_at: '2026-10-01T10:00:00.000Z' },
    free: { engine: 'opencode', model: 'opencode/deepseek-v4.1-flash-free', sessionId: 'ses_Old1', cwd: work, updated_at: '2026-10-02T10:00:00.000Z' },
    nocwd: { engine: 'codex', model: 'gpt-6-luna', sessionId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', updated_at: '2026-10-03T10:00:00.000Z' }
  } }, null, 2));

  let result = h.run(['--resume', 'old', '--cwd', work, '--task', 'continue the old claude session please']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(h.lastCall().command, /--resume 123e4567-e89b-42d3-a456-426614174000/);
  assert.equal(h.lastCall().engine, 'claude');
  assert.equal(fs.existsSync(registryFile), false);
  assert.ok(fs.existsSync(registryFile + '.migrated'));
  assert.match(result.stderr, /legacy session "nocwd" had no cwd .*_unscoped.*memory session adopt "nocwd"/);

  result = h.run(['--resume', 'free', '--cwd', work, '--model', 'mimo-v2.6-flash-free', '--task', 'second turn of the free session']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(h.lastCall().command, /--session ses_Old1/);
  assert.match(h.lastCall().command, /--model opencode\/mimo-v2\.6-flash-free/);

  result = h.run(['--resume', 'nocwd', '--cwd', elsewhere, '--task', 'resume the codex one from anywhere']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(h.lastCall().command, /codex exec resume 0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f/);

  const snap = snapshotProject(h.repo, resolveProject({ cwd: work }).key);
  const meta = readMeta(snap, 'legacy-old');
  assert.equal(meta.alias, 'old');
  assert.equal(meta.migrated_from, 'session_registry.json');
  assert.equal(readTurns(snap, 'legacy-old').length, 1);
  assert.ok(readMeta(snapshotProject(h.repo, UNSCOPED_PROJECT), 'legacy-nocwd'));

  const adopt = h.run(['memory', 'session', 'adopt', 'nocwd', '--cwd', elsewhere]);
  assert.equal(adopt.status, 0, adopt.stdout + adopt.stderr);
  assert.ok(readMeta(snapshotProject(h.repo, resolveProject({ cwd: elsewhere }).key), 'legacy-nocwd'));
  assert.equal(readMeta(snapshotProject(h.repo, UNSCOPED_PROJECT), 'legacy-nocwd'), null);

  assert.notEqual(h.run(['--resume', 'missing', '--cwd', work, '--task', 'nothing to resume here']).status, 0);
});

test('the same alias in two projects names two different sessions', t => {
  const h = makeHarness(t);
  const [a, b] = mkdirs(h.dir, 'project-a', 'project-b');
  assert.equal(h.run(['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--name', 'dup', '--cwd', a, '--task', 'first turn in project a']).status, 0);
  assert.equal(h.run(['--engine', 'vibe', '--no-fallback', '--name', 'dup', '--cwd', b, '--task', 'first turn in project b']).status, 0);
  let result = h.run(['--resume', 'dup', '--cwd', a, '--no-fallback', '--task', 'second turn in a']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(h.lastCall().command, new RegExp(`--resume ${FAKE_SESSION_IDS.claude}`));
  result = h.run(['--resume', 'dup', '--cwd', b, '--no-fallback', '--task', 'second turn in b']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(h.lastCall().engine, 'vibe');
  assert.match(h.lastCall().command, new RegExp(`--resume ${FAKE_SESSION_IDS.vibe}`));
  const sidA = listSessions(snapshotProject(h.repo, resolveProject({ cwd: a }).key))[0].sid;
  const sidB = listSessions(snapshotProject(h.repo, resolveProject({ cwd: b }).key))[0].sid;
  assert.notEqual(sidA, sidB);
});

test('session id precedence: --session, then AI_FACTORY_SESSION_ID, then a new UUIDv7', t => {
  const h = makeHarness(t);
  const [work] = mkdirs(h.dir, 'ids');
  const key = resolveProject({ cwd: work }).key;
  const claude = ['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--cwd', work];
  h.run([...claude, '--task', 'one'], { extraEnv: { AI_FACTORY_SESSION_ID: 'from-hook' } });
  h.run([...claude, '--session', 'from-flag', '--task', 'two'], { extraEnv: { AI_FACTORY_SESSION_ID: 'from-hook' } });
  h.run([...claude, '--task', 'three']);
  h.run([...claude, '--session', '../bad id', '--task', 'four']);
  const sids = listSessions(snapshotProject(h.repo, key)).map(s => s.sid).sort();
  assert.equal(sids.length, 4);
  assert.ok(sids.includes('from-hook'));
  assert.ok(sids.includes('from-flag'));
  assert.equal(sids.filter(s => /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(s)).length, 2);
});

test('resuming with another engine keeps one memory session and both engine sessions', t => {
  const h = makeHarness(t);
  const [work] = mkdirs(h.dir, 'switch');
  assert.equal(h.run(['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--name', 'sw', '--cwd', work, '--task', 'claude starts the work']).status, 0);
  let result = h.run(['--resume', 'sw', '--engine', 'codex', '--no-fallback', '--cwd', work, '--task', 'codex continues the work']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(h.lastCall().engine, 'codex');
  assert.doesNotMatch(h.lastCall().command, /exec resume/);
  result = h.run(['--resume', 'sw', '--engine', 'claude', '--no-fallback', '--cwd', work, '--task', 'claude picks it back up']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(h.lastCall().command, new RegExp(`--resume ${FAKE_SESSION_IDS.claude}`));
  const snap = snapshotProject(h.repo, resolveProject({ cwd: work }).key);
  const sessions = listSessions(snap);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].engine_sessions, { claude: FAKE_SESSION_IDS.claude, codex: FAKE_SESSION_IDS.codex });
  assert.deepEqual(readTurns(snap, sessions[0].sid).map(turn => turn.engine), ['claude', 'codex', 'claude']);
});

test('A13: --scope dir sees only its subdirectory; mine stays out of project search', t => {
  const h = makeHarness(t);
  const [root] = mkdirs(h.dir, 'scoped');
  fs.writeFileSync(path.join(root, '.ai-factory.toml'), 'project = "scoped"\n');
  const [sub, other] = mkdirs(root, 'pkg/api', 'pkg/web');
  const claude = ['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback'];
  assert.equal(h.run([...claude, '--cwd', sub, '--task', 'alpha change in the api package']).status, 0);
  assert.equal(h.run([...claude, '--cwd', other, '--task', 'alpha change in the web package']).status, 0);
  assert.equal(h.run(['memory', 'note', 'add', 'alpha decision for api', '--cwd', sub]).status, 0);
  const personal = h.run(['memory', 'note', 'add', 'beta personal preference', '--scope', 'mine', '--cwd', sub]);
  assert.equal(personal.status, 0, personal.stderr);

  const dirHits = h.run(['memory', 'search', 'alpha', '--scope', 'dir', '--cwd', sub]).stdout.trim().split('\n');
  assert.equal(dirHits.length, 2, dirHits.join('\n'));
  assert.ok(dirHits.every(line => /api/.test(line)), dirHits.join('\n'));
  const repoHits = h.run(['memory', 'search', 'alpha', '--cwd', sub]).stdout.trim().split('\n');
  assert.equal(repoHits.length, 3, repoHits.join('\n'));

  assert.match(h.run(['memory', 'search', 'beta', '--scope', 'mine', '--cwd', sub]).stdout, /beta personal preference/);
  assert.match(h.run(['memory', 'search', 'beta', '--cwd', sub]).stdout, /\(no matches\)/);
  assert.match(h.run(['memory', 'search', 'beta', '--scope', 'dir', '--cwd', sub]).stdout, /\(no matches\)/);
});

test('plain-text replies drop the CLI\'s own status lines, JSON replies are unaffected', async () => {
  const { extractResponseText } = await import('./session.mjs');
  const muse = 'muse: workspace root: C:\work (explicit)\nmuse: Agent delegation: auto unavailable: workspace is untrusted.\nHERON1144-OK';
  assert.equal(extractResponseText(muse, 'muse'), 'HERON1144-OK');
  assert.equal(extractResponseText(muse, 'MUSE'), 'HERON1144-OK');
  assert.equal(extractResponseText(muse), muse, 'without an engine nothing is dropped');
  assert.equal(extractResponseText('vibe: said hi\nnoted', 'muse'), 'vibe: said hi\nnoted', 'only the engine\'s own prefix');
  const json = '{"type":"result","result":"muse: keep this"}';
  assert.equal(extractResponseText(json, 'muse'), 'muse: keep this');
});
