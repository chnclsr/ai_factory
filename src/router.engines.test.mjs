import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const router = path.join(root, 'router.mjs');

test('OpenCode free and configured Claude models retain named sessions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mock = path.join(dir, 'mock.mjs');
  const preload = path.join(dir, 'preload.mjs');
  const callsFile = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(mock, `
import fs from 'node:fs';
const [engine, command] = process.argv.slice(2);
const promptFile = command.match(engine === 'opencode' ? /--file "([^"]+)"/ : /< "([^"]+)"/)[1];
const task = fs.readFileSync(promptFile, 'utf8');
fs.appendFileSync(process.env.AI_FACTORY_FAKE_CALLS, JSON.stringify({ engine, command, task }) + '\\n');
process.stdout.write(engine === 'opencode'
  ? JSON.stringify({ type: 'text', sessionID: 'ses_Test123', part: { text: 'MOCK_OK' } }) + '\\n'
  : JSON.stringify({ type: 'result', session_id: '123e4567-e89b-42d3-a456-426614174000', result: 'MOCK_OK' }) + '\\n');
`);
  fs.writeFileSync(preload, `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const childProcess = createRequire(import.meta.url)('node:child_process');
const realSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (typeof command === 'string' && /^(opencode run|claude -p)\\b/.test(command)) {
    const engine = command.startsWith('opencode') ? 'opencode' : 'claude';
    return realSpawn(process.execPath, [process.env.AI_FACTORY_MOCK, engine, command], { ...options, shell: false });
  }
  return realSpawn(command, args, options);
};
syncBuiltinESMExports();
`);
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`.trim(),
    AI_FACTORY_MOCK: mock,
    AI_FACTORY_FAKE_CALLS: callsFile,
    AI_FACTORY_DATA_DIR: path.join(dir, 'state')
  };
  const run = (...args) => spawnSync(process.execPath, [router, '--no-fallback', ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 });

  let result = run('--engine', 'opencode', '--model', 'deepseek-v4.1-flash-free', '--name', 'free', '--task', 'first free turn');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = run('--resume', 'free', '--model', 'mimo-v2.6-flash-free', '--task', 'second free turn');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = run('--engine', 'claude', '--model', 'haiku-5.5', '--name', 'cheap', '--task', 'first cheap turn');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = run('--resume', 'cheap', '--model', 'sonnet-5.5', '--task', 'second cheap turn');
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 4, result.stdout + result.stderr);
  assert.deepEqual(calls.map(call => call.task.trim()), ['first free turn', 'second free turn', 'first cheap turn', 'second cheap turn']);
  assert.match(calls[1].command, /--model opencode\/mimo-v2\.6-flash-free/);
  assert.match(calls[1].command, /--session ses_Test123/);
  assert.match(calls[3].command, /--model claude-sonnet-5-5/);
  assert.match(calls[3].command, /--fallback-model claude-sonnet-5-5/);
  assert.match(calls[3].command, /--resume 123e4567-e89b-42d3-a456-426614174000/);

  const sessions = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'session_registry.json'), 'utf8')).sessions;
  assert.equal(sessions.free.sessionId, 'ses_Test123');
  assert.equal(sessions.cheap.sessionId, '123e4567-e89b-42d3-a456-426614174000');

  result = run('--task', 'Use OpenCode for this task');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = run('--task', 'Use Claude for this task');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const routedCalls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.match(routedCalls[4].command, /--model opencode\/deepseek-v4\.1-flash-free/);
  assert.match(routedCalls[5].command, /--model claude-haiku-5-5/);

  result = run('--engine', 'claude', '--model', 'opus-5.5', '--name', 'opus', '--task', 'first opus turn');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = run('--resume', 'opus', '--model', 'claude-opus-5-5', '--task', 'second opus turn');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = run('--task', 'Use Claude Opus 5.5 for this task');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = run('--task', 'Use Opus 5.5 for this task');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const opusCalls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse).slice(6);
  assert.equal(opusCalls.length, 4);
  for (const call of opusCalls) {
    assert.match(call.command, /--model claude-opus-5-5/);
    assert.match(call.command, /--fallback-model claude-opus-5-5/);
  }
  assert.match(opusCalls[1].command, /--resume 123e4567-e89b-42d3-a456-426614174000/);

  assert.notEqual(run('--engine', 'opencode', '--model', 'opencode/gpt-6-sol', '--task', 'blocked').status, 0);
  assert.notEqual(run('--engine', 'claude', '--model', 'claude-opus-5', '--task', 'blocked').status, 0);
  assert.notEqual(run('--engine', 'claude', '--model', 'claude-fable-5-1', '--task', 'blocked').status, 0);

  const config = JSON.parse(fs.readFileSync(path.join(root, 'router_config.json'), 'utf8'));
  env.AI_FACTORY_CONFIG = path.join(dir, 'over-budget.json');
  for (const [input, output] of [[4.01, 20], [4, 20.01]]) {
    Object.assign(config.engines.claude.models['opus-5.5'], { cost_input_per_m: input, cost_output_per_m: output });
    fs.writeFileSync(env.AI_FACTORY_CONFIG, JSON.stringify(config));
    result = run('--engine', 'claude', '--model', 'opus-5.5', '--task', 'blocked');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceeds the configured cost ceiling/);
  }
  assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 10);
});

test('Default routing walks the free chain and named models are honoured', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-chain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mock = path.join(dir, 'mock.mjs');
  const preload = path.join(dir, 'preload.mjs');
  const callsFile = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(mock, `
import fs from 'node:fs';
const [engine, command] = process.argv.slice(2);
const model = (command.match(/--model (\\S+)/) || command.match(/ -m (\\S+)/))[1];
fs.appendFileSync(process.env.AI_FACTORY_FAKE_CALLS, JSON.stringify({ engine, model }) + '\\n');
if ((process.env.AI_FACTORY_FAIL || '').split(',').includes(model)) {
  process.stderr.write('429 rate limit\\n');
  process.exit(1);
}
process.stdout.write(engine === 'opencode'
  ? JSON.stringify({ type: 'text', sessionID: 'ses_Chain1', part: { text: 'MOCK_OK' } }) + '\\n'
  : 'MOCK_OK\\n');
`);
  fs.writeFileSync(preload, `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const childProcess = createRequire(import.meta.url)('node:child_process');
const realSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const engine = typeof command === 'string' && (command.match(/^(opencode|muse|codex|claude)\\b/) || [])[1];
  if (engine) return realSpawn(process.execPath, [process.env.AI_FACTORY_MOCK, engine, command], { ...options, shell: false });
  return realSpawn(command, args, options);
};
syncBuiltinESMExports();
`);
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`.trim(),
    AI_FACTORY_MOCK: mock,
    AI_FACTORY_FAKE_CALLS: callsFile,
    AI_FACTORY_DATA_DIR: path.join(dir, 'state')
  };
  const calls = () => fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const run = (fail, ...args) => {
    fs.rmSync(callsFile, { force: true });
    fs.rmSync(path.join(dir, 'state'), { recursive: true, force: true });
    return spawnSync(process.execPath, [router, ...args],
      { cwd: root, env: { ...env, AI_FACTORY_FAIL: fail }, encoding: 'utf8', timeout: 30000 });
  };

  let result = run('', '--task', 'Fix the failing test');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(calls().map(c => c.model), ['opencode/deepseek-v4.1-flash-free']);

  result = run('opencode/deepseek-v4.1-flash-free,opencode/mimo-v2.6-flash-free,opencode/glm-5.3-flash-free', '--task', 'Fix it');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(calls().map(c => c.model), ['opencode/deepseek-v4.1-flash-free', 'opencode/mimo-v2.6-flash-free',
    'opencode/glm-5.3-flash-free', 'muse-spark-1.3-contributor']);
  assert.match(result.stdout, /succeed_with: muse-spark-1\.3-contributor/);

  result = run('opencode/deepseek-v4.1-flash-free,opencode/mimo-v2.6-flash-free,opencode/glm-5.3-flash-free,muse-spark-1.3-contributor', '--task', 'Fix it');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(calls().at(-1).model, 'gpt-6-luna');

  result = run('', '--task', 'Bunu GLM ile yap');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(calls().map(c => c.model), ['opencode/glm-5.3-flash-free']);

  result = run('gpt-5.6-terra', '--task', 'terra ile incele');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(calls().map(c => c.model).slice(0, 2), ['gpt-5.6-terra', 'opencode/deepseek-v4.1-flash-free']);

  result = run('', '--model', 'nemotron', '--task', 'any');
  assert.deepEqual(calls().map(c => c.model), ['opencode/nemotron-3-ultra-free']);

  result = run('claude-sonnet-5-5', '--task', 'Use sonnet 5.5 here');
  assert.deepEqual(calls().map(c => c.model), ['claude-sonnet-5-5']);
  assert.match(result.stdout, /handoff_to_gemini/);

  result = run('', '--task', 'Solve the metadata issue');
  assert.deepEqual(calls().map(c => c.model), ['opencode/deepseek-v4.1-flash-free']);

  for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'sol']) {
    assert.notEqual(run('', '--engine', 'codex', '--model', model, '--task', 'blocked').status, 0);
  }
  assert.equal(calls().length, 0);
});

test('Claude reasoning effort scales with task complexity and explicit overrides', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-effort-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mock = path.join(dir, 'mock.mjs');
  const preload = path.join(dir, 'preload.mjs');
  const callsFile = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(mock, `
import fs from 'node:fs';
const command = process.argv[3];
fs.appendFileSync(process.env.AI_FACTORY_FAKE_CALLS, command + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: '123e4567-e89b-42d3-a456-426614174000', result: 'MOCK_OK' }) + '\\n');
`);
  fs.writeFileSync(preload, `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const childProcess = createRequire(import.meta.url)('node:child_process');
const realSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (typeof command === 'string' && /^claude -p\\b/.test(command)) {
    return realSpawn(process.execPath, [process.env.AI_FACTORY_MOCK, 'claude', command], { ...options, shell: false });
  }
  return realSpawn(command, args, options);
};
syncBuiltinESMExports();
`);
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`.trim(),
    AI_FACTORY_MOCK: mock,
    AI_FACTORY_FAKE_CALLS: callsFile,
    AI_FACTORY_DATA_DIR: path.join(dir, 'state')
  };
  const run = (...args) => {
    fs.rmSync(callsFile, { force: true });
    return spawnSync(process.execPath, [router, '--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', ...args],
      { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  };
  const lastCmd = () => fs.readFileSync(callsFile, 'utf8').trim();

  let result = run('--task', 'Reply with exactly: PONG');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(lastCmd(), / --effort medium\b/);

  result = run('--task', 'Review this architecture and refactor it');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(lastCmd(), / --effort high\b/);

  result = run('--task', 'This is routine, but use max effort anyway');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(lastCmd(), / --effort max\b/);

  result = run('--reasoning-effort', 'xhigh', '--task', 'Reply with exactly: PONG');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(lastCmd(), / --effort xhigh\b/);

  assert.notEqual(run('--reasoning-effort', 'ultra', '--task', 'blocked').status, 0);
});
