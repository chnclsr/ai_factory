import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const router = path.join(root, 'router.mjs');

test('OpenCode free and Claude low-cost models retain named sessions', t => {
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

  assert.notEqual(run('--engine', 'opencode', '--model', 'opencode/gpt-6-sol', '--task', 'blocked').status, 0);
  assert.notEqual(run('--engine', 'claude', '--model', 'claude-opus-5', '--task', 'blocked').status, 0);
  assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 6);
});
