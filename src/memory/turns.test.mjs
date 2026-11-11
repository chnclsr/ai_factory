import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHarness, ROOT } from './router-harness.mjs';
import { git, initFixtureRepo, commitAll, fsck, tempDir } from './test-helpers.mjs';
import { snapshotProject } from './store.mjs';
import { listSessions, readTurns } from './session.mjs';
import { resolveProject } from './project.mjs';
import { readRef, readCommit } from './gitobj.mjs';

const CLAUDE = ['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback'];

function sessionTurns(h, cwd) {
  const snap = snapshotProject(h.repo, resolveProject({ cwd }).key);
  const [session] = listSessions(snap);
  return { snap, session, turns: session ? readTurns(snap, session.sid).filter(t => t.kind === 'turn') : [] };
}

test('A8: a turn records only its own changes and leaves the user index alone', t => {
  const h = makeHarness(t);
  const repo = initFixtureRepo(path.join(h.dir, 'proj'));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'd.txt'), 'keep\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  commitAll(repo, 'base');
  // Uncommitted and staged work that exists before the call.
  fs.appendFileSync(path.join(repo, 'a.txt'), 'user edit\n');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
  git(repo, ['add', 'staged.txt']);
  const cachedBefore = git(repo, ['diff', '--cached']).stdout;
  const stageBefore = git(repo, ['ls-files', '-s']).stdout;

  const result = h.run([...CLAUDE, '--cwd', repo, '--task', 'Change d.txt and add a new file'], {
    actions: { writes: { 'd.txt': 'keep\nchanged by claude\n', 'new.txt': 'untracked new\n', 'ignored.log': 'noise\n' } }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const { snap, turns } = sessionTurns(h, repo);
  assert.equal(turns.length, 1);
  const turn = turns[0];
  assert.deepEqual(turn.files.map(f => `${f.status} ${f.path} +${f.add} -${f.del}`).sort(),
    ['A new.txt +1 -0', 'M d.txt +1 -0']);
  const patch = snap.read(turn.patch_ref);
  assert.match(patch, /\+changed by claude/);
  assert.match(patch, /\+untracked new/);
  assert.doesNotMatch(patch, /user edit/);
  assert.doesNotMatch(patch, /ignored\.log/);
  assert.equal(git(repo, ['diff', '--cached']).stdout, cachedBefore);
  assert.equal(git(repo, ['ls-files', '-s']).stdout, stageBefore);
  assert.ok(turn.wt_before && turn.wt_after && turn.wt_before !== turn.wt_after);
  assert.equal(fsck(h.repo).status, 0);
});

test('A9: reverting turn 1 undoes only turn 1', t => {
  const h = makeHarness(t);
  const repo = initFixtureRepo(path.join(h.dir, 'proj two'));
  fs.writeFileSync(path.join(repo, 'x.txt'), 'x0\n');
  fs.writeFileSync(path.join(repo, 'y.txt'), 'y0\n');
  commitAll(repo, 'base');
  const session = ['--session', 'revert-session'];
  assert.equal(h.run([...CLAUDE, ...session, '--cwd', repo, '--task', 'edit x'], { actions: { writes: { 'x.txt': 'x1\n' } } }).status, 0);
  assert.equal(h.run([...CLAUDE, ...session, '--cwd', repo, '--task', 'edit y'], { actions: { writes: { 'y.txt': 'y1\n' } } }).status, 0);

  const refused = h.run(['memory', 'turn', 'revert', '1', '--session', 'revert-session', '--cwd', repo]);
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /M x\.txt/);
  assert.equal(fs.readFileSync(path.join(repo, 'x.txt'), 'utf8'), 'x1\n');

  const diff = h.run(['memory', 'turn', 'diff', '1', '--session', 'revert-session', '--cwd', repo]);
  assert.match(diff.stdout, /-x0\n\+x1/);

  const reverted = h.run(['memory', 'turn', 'revert', '1', '--session', 'revert-session', '--cwd', repo, '--yes']);
  assert.equal(reverted.status, 0, reverted.stdout + reverted.stderr);
  assert.equal(fs.readFileSync(path.join(repo, 'x.txt'), 'utf8'), 'x0\n');
  assert.equal(fs.readFileSync(path.join(repo, 'y.txt'), 'utf8'), 'y1\n');
  const show = h.run(['memory', 'session', 'show', 'revert-session', '--cwd', repo]);
  assert.match(show.stdout, /revert .* of turn 1/);
});

test('A10: outside git, the turn keeps a file list and no patch', t => {
  const h = makeHarness(t);
  const plain = path.join(h.dir, 'plain dir');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'old.txt'), 'old\n');
  fs.writeFileSync(path.join(plain, 'gone.txt'), 'bye\n');
  const result = h.run([...CLAUDE, '--cwd', plain, '--task', 'edit things in a plain folder'], {
    actions: { writes: { 'old.txt': 'old but longer\n', 'fresh/new.txt': 'n\n', 'gone.txt': null } }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { turns } = sessionTurns(h, plain);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].files.map(f => `${f.status} ${f.path}`), ['A fresh/new.txt', 'D gone.txt', 'M old.txt']);
  assert.equal(turns[0].patch_ref, null);
});

test('A4: one router call writes exactly one commit with the expected trailers', t => {
  const h = makeHarness(t);
  const cwd = path.join(h.dir, 'work');
  fs.mkdirSync(cwd);
  const key = resolveProject({ cwd }).key;
  const before = readRef(h.repo, `refs/heads/p/${key}`);
  assert.equal(before, null);
  const result = h.run(['--cwd', cwd, '--session', 'trailer-check', '--task', 'Fix the failing test please'], { actions: { fail: ['zai-glm-5-3-flash'] } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sha = readRef(h.repo, `refs/heads/p/${key}`);
  const commit = readCommit(h.repo, sha);
  assert.equal(commit.parents.length, 0);
  assert.equal(commit.seq, 1);
  assert.deepEqual({ Session: commit.trailers.Session, Engine: commit.trailers.Engine, Kind: commit.trailers.Kind },
    { Session: 'trailer-check', Engine: 'vibe', Kind: 'turn' });
  const { turns } = sessionTurns(h, cwd);
  assert.equal(turns[0].model, 'glm-5-3');
  assert.match(turns[0].attempts[0], /zai-glm-5-3-flash/);
});

test('a broken memory store never blocks the task', t => {
  const h = makeHarness(t);
  fs.mkdirSync(h.dataDir, { recursive: true });
  fs.writeFileSync(h.repo, 'not a directory');
  const cwd = path.join(h.dir, 'work');
  fs.mkdirSync(cwd);
  const result = h.run([...CLAUDE, '--cwd', cwd, '--task', 'Still do the work even if memory is broken']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /succeed_with: claude-claude-haiku-5-5/);
  assert.match(result.stderr, /\[AI Factory Memory\] recordTurn failed/);
});

// The pre-memory router, taken from git history, is the reference for byte-identical behaviour.
const BASELINE_REV = '251b179';

function materializeBaseline(dir) {
  const files = ['router.mjs', 'src/router.mjs', 'src/quota_tracker.mjs', 'src/watchdog.mjs', 'lib/paths.mjs', 'package.json'];
  for (const file of files) {
    const shown = spawnSync('git', ['-C', ROOT, 'show', `${BASELINE_REV}:${file}`], { encoding: 'buffer' });
    if (shown.status !== 0) return null;
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), shown.stdout);
  }
  return path.join(dir, 'router.mjs');
}

function normalize(text, h) {
  return String(text)
    .replaceAll(h.dir, '<DIR>').replaceAll(h.dir.replaceAll('\\', '/'), '<DIR>')
    .replace(/\.(\w+)_prompt_[^"\s]+\.txt/g, '.$1_prompt_<ID>.txt')
    .replace(/PID \d+/g, 'PID <PID>')
    .replace(/--session-id [0-9a-f-]{36}/g, '--session-id <UUID>')
    .replace(/"updated_at": "[^"]+"/g, '"updated_at": "<TS>"');
}

test('memory.enabled=false: output, commands and prompts match the pre-memory router byte for byte', t => {
  const h = makeHarness(t, { config: c => { c.memory.enabled = false; } });
  const baseline = materializeBaseline(path.join(tempDir(t, 'ai-factory-baseline-'), 'tree'));
  if (!baseline) { t.skip(`git history without ${BASELINE_REV}`); return; }
  const work = path.join(h.dir, 'work');
  fs.mkdirSync(work);
  const scenarios = [
    [['--task', 'Fix the failing test in this repository'], {}],
    [['--task', 'Fix it'], { fail: ['zai-glm-5-3-flash', 'glm-5-3', 'opencode/deepseek-v4.1-flash-free'] }],
    [['--engine', 'claude', '--model', 'haiku-5.5', '--name', 'named', '--task', 'first named turn'], {}],
    [['--resume', 'named', '--task', 'second named turn'], {}],
    [['--engine', 'codex', '--task', 'codex task with enough words'], {}],
    [['--engine', 'gemini', '--task', 'hand it back'], {}]
  ];
  const runAll = router => {
    fs.rmSync(h.dataDir, { recursive: true, force: true });
    h.resetCalls();
    const outputs = scenarios.map(([args, actions]) => {
      const r = h.run(['--cwd', work, ...args], { actions, router });
      return { status: r.status, stdout: normalize(r.stdout, h), stderr: normalize(r.stderr, h) };
    });
    const registry = path.join(h.dataDir, 'session_registry.json');
    return {
      outputs,
      calls: h.calls().map(c => ({ ...c, command: normalize(c.command, h), cwd: normalize(c.cwd, h) })),
      registry: fs.existsSync(registry) ? normalize(fs.readFileSync(registry, 'utf8'), h) : null,
      memoryRepo: fs.existsSync(h.repo)
    };
  };
  const expected = runAll(baseline);
  const actual = runAll(undefined);
  assert.equal(actual.memoryRepo, false);
  assert.deepEqual(actual.outputs, expected.outputs);
  assert.deepEqual(actual.calls, expected.calls);
  assert.equal(actual.registry, expected.registry);
  for (const call of actual.calls) assert.doesNotMatch(call.prompt, /retrieved-memory/);
});
