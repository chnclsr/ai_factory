import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

function runFixture(t, mode, watchdog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-watchdog-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const config = JSON.parse(fs.readFileSync(path.join(root, 'router_config.json')));
  config.watchdog = { initial_timeout_ms: 50, idle_timeout_ms: 50,
    cpu_still_limit_ms: 100, max_execution_time_ms: 1500, check_interval_ms: 25, ...watchdog };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'mock.mjs'), `
const mode = process.env.WATCHDOG_TEST_MODE;
if (mode === 'heartbeat') setInterval(() => console.log('{}'), 20);
if (mode === 'idle') console.log('{}');
setTimeout(() => {
  console.log(JSON.stringify({type:'result',result:'MOCK_OK'}));
  process.exit(0);
}, mode === 'active' ? 400 : 1200);
`);
  const preload = path.join(dir, 'preload.mjs');
  fs.writeFileSync(preload, `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const cp = createRequire(import.meta.url)('node:child_process');
const spawn = cp.spawn, exec = cp.execSync;
let cpu = 0, childPid;
cp.spawn = (command, args, options) => {
  if (typeof command !== 'string' || !command.startsWith('claude -p')) return spawn(command,args,options);
  const child = spawn(process.execPath, [process.env.WATCHDOG_TEST_CHILD], {...options,shell:false});
  childPid = child.pid;
  return child;
};
cp.execSync = (command, options) => {
  if (/Get-CimInstance/.test(command)) return Buffer.from(JSON.stringify([{ProcessId:childPid,ParentProcessId:process.pid}]));
  if (/^ps -eo/.test(command)) return Buffer.from(childPid + ' ' + process.pid);
  if (/TotalProcessorTime|^ps -p/.test(command)) {
    if (process.env.WATCHDOG_TEST_MODE === 'active') cpu += 10;
    return Buffer.from(process.platform === 'win32' ? String(cpu) : '00:' + cpu);
  }
  return exec(command,options);
};
syncBuiltinESMExports();
`);
  return spawnSync(process.execPath, [path.join(root, 'router.mjs'), '--engine', 'claude',
    '--model', 'haiku-5.5', '--no-fallback', '--task', 'local watchdog fixture'], {
    encoding: 'utf8', timeout: 5000, cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      AI_FACTORY_CONFIG: path.join(dir, 'config.json'), AI_FACTORY_DATA_DIR: path.join(dir, 'state'),
      WATCHDOG_TEST_MODE: mode, WATCHDOG_TEST_CHILD: path.join(dir, 'mock.mjs') }
  });
}

test('router enforces the hard deadline even while the engine keeps producing output', t => {
  const result = runFixture(t, 'heartbeat', { initial_timeout_ms: 5000, idle_timeout_ms: 5000, max_execution_time_ms: 200 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /hard_timeout/);
  assert.doesNotMatch(result.stdout, /MOCK_OK/);
});

for (const mode of ['silent', 'idle']) test(`router stops a live but stalled ${mode} engine`, t => {
  const result = runFixture(t, mode);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /zombie_tree/);
  assert.doesNotMatch(result.stdout, /MOCK_OK/);
});

test('router lets a silent engine finish while its CPU is progressing', t => {
  const result = runFixture(t, 'active');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /MOCK_OK/);
  assert.doesNotMatch(result.stderr, /\[AI-FACTORY-WATCHDOG\].*(?:hard_timeout|zombie_tree)/);
});

test('router starts its watchdog and checks status while the engine is running', t => {
  const result = runFixture(t, 'active', {
    initial_timeout_ms: 1000, idle_timeout_ms: 1000,
    status_checkpoints_ms: [50, 100, 150], status_repeat_ms: 50
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /\[AI-FACTORY-WATCHDOG\] started: claude PID/);
  assert.ok((result.stderr.match(/\[AI-FACTORY-WATCHDOG\] status: claude process_alive=true/g) || []).length >= 4,
    result.stderr);
});
