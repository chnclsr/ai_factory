import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

test('Puter router launches the native worker without any CLI on PATH and resumes sessions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-factory-puter-route-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ service: 'ai-factory', authenticated: true })); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ final: 'NATIVE_PUTER_OK' }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const env = { ...process.env, PATH: '', AI_FACTORY_PORT: String(server.address().port), AI_FACTORY_DATA_DIR: path.join(dir, 'state') };
  const router = path.resolve(import.meta.dirname, '../router.mjs');
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [router, '--no-fallback', ...args], { cwd: dir, env, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
  let result = await run(['--engine', 'puter', '--model', 'flash', '--name', 'direct', '--task', 'First turn']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /succeed_with: puter-flash/);
  assert.match(result.output, /puter_agent\.mjs/);
  assert.doesNotMatch(result.output, /dsh|pro-patch/i);
  const registry = JSON.parse(await fs.readFile(path.join(dir, 'state/session_registry.json'), 'utf8'));
  assert.match(registry.sessions.direct.sessionId, /^[0-9a-f-]{36}$/);
  result = await run(['--resume', 'direct', '--task', 'Continue']);
  assert.equal(result.code, 0, result.output);
  assert.equal(requests[1].messages[1].content, 'First turn');
  result = await run(['--engine', 'puter', '--model', 'pro', '--task', 'Pro turn']);
  assert.equal(result.code, 0, result.output);
  assert.equal(requests[2].model, 'deepseek-pro');
  result = await run(['--engine', 'dsh', '--task', 'Removed engine']);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Unknown engine: dsh/);
  assert.equal(requests.length, 3);
});
