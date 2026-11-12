import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, memoryBlock, FAKE_SESSION_IDS, configuredModels } from './router-harness.mjs';
import { initFixtureRepo, commitAll } from './test-helpers.mjs';
import { estimateTokens, buildPrompt, budgetFor } from './pack.mjs';
import { snapshotProject } from './store.mjs';
import { listSessions, readTurns } from './session.mjs';
import { resolveProject } from './project.mjs';

function workDir(h, name) {
  const dir = path.join(h.dir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function note(h, cwd, text, slug) {
  const result = h.run(['memory', 'note', 'add', text, '--cwd', cwd, ...(slug ? ['--slug', slug] : [])]);
  assert.equal(result.status, 0, result.stderr);
}

const ROUTER_CONFIG = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'router_config.json'), 'utf8'));

test('buildPrompt puts the pack first and leaves the task untouched', () => {
  assert.equal(buildPrompt('task text', { text: '' }), 'task text');
  assert.equal(buildPrompt('task text', null), 'task text');
  assert.equal(buildPrompt('task text', { text: '<retrieved-memory untrusted="true">x</retrieved-memory>' }),
    '<retrieved-memory untrusted="true">x</retrieved-memory>\n\ntask text');
  assert.equal(budgetFor(ROUTER_CONFIG, 'claude', 'claude-haiku-5-5'), 2000);
  assert.equal(budgetFor(ROUTER_CONFIG, 'opencode', 'opencode/deepseek-v4.1-flash-free'), 800);
  assert.equal(budgetFor(ROUTER_CONFIG, 'muse', 'muse-spark-1.3-contributor'), 800);
});

test('A1: every engine gets the block through its own task channel and within its budget', t => {
  const h = makeHarness(t);
  const cwd = workDir(h, 'channels');
  for (let i = 0; i < 6; i++) note(h, cwd, `parser decision ${i}: the tokenizer keeps quoted strings intact ${'detail '.repeat(60)}`);
  const cases = [
    ['vibe', ['--engine', 'vibe'], /--prompt-file "/, 'zai-glm-5-3-flash'],
    ['opencode', ['--engine', 'opencode', '--model', 'deepseek-v4.1-flash-free'], /--file "/, 'opencode/deepseek-v4.1-flash-free'],
    ['muse', ['--engine', 'muse'], /--prompt-file "/, 'muse-spark-1.3-contributor'],
    ['codex', ['--engine', 'codex'], / - < "/, 'gpt-6-luna'],
    ['claude', ['--engine', 'claude', '--model', 'haiku-5.5'], / < "/, 'claude-haiku-5-5']
  ];
  for (const [engine, flags, channel, model] of cases) {
    const task = `Fix the parser so the tokenizer handles quoted strings (${engine})`;
    const result = h.run([...flags, '--no-fallback', '--cwd', cwd, '--task', task]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const call = h.lastCall();
    assert.equal(call.engine, engine);
    assert.match(call.command, channel);
    const block = memoryBlock(call.prompt);
    assert.ok(block, `${engine} got no memory block`);
    assert.ok(call.prompt.endsWith('\n\n' + task), `${engine}: task must follow the block unchanged`);
    assert.match(block, /parser decision/);
    const budget = budgetFor(ROUTER_CONFIG, engine, model);
    assert.ok(estimateTokens(block) <= budget, `${engine}: ${estimateTokens(block)} tokens > ${budget}`);
  }
});

test('A2 + A5: a resumed engine session gets only the delta, and nothing when nothing changed', t => {
  const h = makeHarness(t);
  const cwd = workDir(h, 'delta');
  const claude = ['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--cwd', cwd];
  assert.equal(h.run([...claude, '--name', 'd', '--task', 'Write the parser module for the config format']).status, 0);
  const key = resolveProject({ cwd }).key;
  const meta = listSessions(snapshotProject(h.repo, key))[0];
  assert.equal(meta.engine_sessions.claude, FAKE_SESSION_IDS.claude);
  assert.equal(meta.last_injected_seq[`claude:${FAKE_SESSION_IDS.claude}`], 1);

  assert.equal(h.run(['--resume', 'd', '--cwd', cwd, '--task', 'Now add tests for the parser module please']).status, 0);
  assert.match(h.lastCall().command, /--resume 1111/);
  assert.equal(memoryBlock(h.lastCall().prompt), null, 'nothing changed since this engine session last ran');

  note(h, cwd, 'parser module must reject tabs in keys');
  assert.equal(h.run(['--resume', 'd', '--cwd', cwd, '--task', 'Handle the parser edge cases we agreed on']).status, 0);
  const block = memoryBlock(h.lastCall().prompt);
  assert.ok(block);
  assert.match(block, /reject tabs in keys/);
  assert.doesNotMatch(block, /turn 1 \(/);
  assert.doesNotMatch(block, /Write the parser module/);
});

test('the execution report has a memory line that says what was injected and saved', t => {
  const h = makeHarness(t);
  const cwd = workDir(h, 'report');
  const claude = ['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--cwd', cwd];
  const key = resolveProject({ cwd }).key;

  let result = h.run([...claude, '--name', 'r', '--task', 'Write the parser module for the config format']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^memory: project=${key}, session=r, injected=none \\(project memory is empty\\), saved=turn 1$`, 'm'));

  result = h.run([...claude, '--name', 'r', '--task', 'ok']);
  assert.match(result.stdout, /^memory: .*injected=none \(task too short\), saved=turn 2$/m);

  note(h, cwd, 'parser module must reject tabs in keys');
  result = h.run([...claude, '--name', 'r', '--task', 'Handle the parser edge cases we agreed on']);
  assert.match(result.stdout, /^memory: .*injected=.*1 note\(s\).* \(~\d+\/\d+ tokens\), saved=turn 3$/m);
});

test('A3: after a failure the next engine in the chain gets the earlier error in L0', t => {
  const h = makeHarness(t);
  const cwd = workDir(h, 'fallback');
  const { chain } = configuredModels();
  const result = h.run(['--cwd', cwd, '--task', 'Fix the failing integration test in the api'], { actions: { fail: [chain[0]] } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [first, second] = h.calls();
  assert.equal(first.model, chain[0]);
  assert.equal(memoryBlock(first.prompt), null);
  assert.equal(second.model, chain[1]);
  const block = memoryBlock(second.prompt);
  assert.ok(block.includes(`earlier attempt in this call failed: vibe-${chain[0]} (Rate-limit`), block);
});

test('A7: switching models in one session hands over the chat turns and per-turn file changes', t => {
  const h = makeHarness(t);
  const repo = initFixtureRepo(path.join(h.dir, 'switch repo'));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'line 1\nline 2\nline 3\nline 4\n');
  commitAll(repo, 'base');
  let result = h.run(['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--name', 'sw', '--cwd', repo,
    '--task', 'Rewrite a.txt so the second line explains the plan'], {
    actions: { writes: { 'a.txt': 'line 1\nthe plan is to rewrite\nextra one\nline 3\nline 4\n' }, response: 'Claude rewrote line 2 of a.txt and added a line.' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  result = h.run(['--resume', 'sw', '--engine', 'codex', '--no-fallback', '--cwd', repo, '--task', 'Review what claude did to a.txt and tidy it'], {
    actions: { writes: { 'b.txt': 'codex notes\n' }, response: 'Codex reviewed a.txt and wrote b.txt.' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const codexBlock = memoryBlock(h.lastCall().prompt);
  assert.ok(codexBlock, 'codex must receive the session history');
  assert.match(codexBlock, /turn 1 \(claude\/claude-haiku-5-5\): Rewrite a\.txt so the second line explains the plan → Claude rewrote line 2 of a\.txt/);
  assert.match(codexBlock, /changed: a\.txt \+2 −1/);

  result = h.run(['--resume', 'sw', '--engine', 'claude', '--no-fallback', '--cwd', repo, '--task', 'Continue: finish the plan text in a.txt'], {
    actions: { response: 'done' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(h.lastCall().command, /--resume 1111/);
  const claudeBlock = memoryBlock(h.lastCall().prompt);
  assert.ok(claudeBlock);
  assert.match(claudeBlock, /turn 2 \(codex\/gpt-6-luna\): Review what claude did/);
  assert.match(claudeBlock, /changed: b\.txt \+1 −0/);
  assert.doesNotMatch(claudeBlock, /turn 1 \(/);

  const snap = snapshotProject(h.repo, resolveProject({ cwd: repo }).key);
  const turns = readTurns(snap, listSessions(snap)[0].sid);
  assert.deepEqual(turns[1].injected.map(i => `${i.kind}:${i.n}`), ['turn:1']);
  assert.match(turns[1].injected[0].hash, /^[0-9a-f]{12}$/);
});

test('A12: short tasks skip injection; long tasks get at most five related items', t => {
  const h = makeHarness(t);
  const cwd = workDir(h, 'gate');
  for (let i = 0; i < 8; i++) note(h, cwd, `deploy rule ${i}: staging must pass before production`, `deploy-${i}`);
  const claude = ['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--cwd', cwd];
  assert.equal(h.run([...claude, '--task', 'deploy staging']).status, 0);
  assert.equal(memoryBlock(h.lastCall().prompt), null);
  assert.equal(h.lastCall().prompt, 'deploy staging');
  assert.equal(h.run([...claude, '--task', 'Prepare the production deploy after staging passes']).status, 0);
  const block = memoryBlock(h.lastCall().prompt);
  assert.equal((block.match(/^- note /gm) || []).length, 5);
});

test('nested router calls (AI_FACTORY_ROUTER_DEPTH > 0) inject nothing', t => {
  const h = makeHarness(t);
  const cwd = workDir(h, 'nested');
  note(h, cwd, 'nested calls should never see memory blocks at all');
  const result = h.run(['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--cwd', cwd, '--task', 'Explain why nested calls should never see memory'],
    { extraEnv: { AI_FACTORY_ROUTER_DEPTH: '1' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(memoryBlock(h.lastCall().prompt), null);
});
