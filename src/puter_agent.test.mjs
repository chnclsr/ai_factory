import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runPuterAgent, executeTool, localBridgeUrl } from './puter_agent.mjs';

async function fixture(t, respond) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-factory-puter-'));
  const cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = { path: req.url, headers: req.headers, body: JSON.parse(raw) };
    requests.push(request);
    const reply = respond(request, requests.length);
    res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body || { choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dir, cwd: await fs.realpath(cwd), requests, bridgeUrl: `http://127.0.0.1:${server.address().port}`,
    sessionsDir: path.join(dir, 'sessions') };
}

test('native Puter agent writes, reads, finishes, and resumes through the local bridge', async t => {
  const f = await fixture(t, (_request, count) => {
    if (count === 1) return { tool_calls: [{ name: 'write_file', arguments: { path: 'src/hello.mjs', content: 'export const hello = 42;\n' } }] };
    if (count === 2) return { tool_calls: [{ name: 'read_file', arguments: { path: 'src/hello.mjs' } }] };
    return { final: count === 3 ? 'Project created' : 'Follow-up complete' };
  });
  const first = await runPuterAgent({ ...f, task: 'Create the project', model: 'deepseek-flash' });
  assert.equal(first.text, 'Project created');
  assert.equal(await fs.readFile(path.join(f.cwd, 'src/hello.mjs'), 'utf8'), 'export const hello = 42;\n');
  assert.match(f.requests[2].body.messages.at(-1).content, /export const hello = 42/);
  const resumed = await runPuterAgent({ ...f, task: 'Review it', model: 'deepseek-pro', resumeSessionId: first.sessionId });
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(resumed.text, 'Follow-up complete');
  assert.equal(f.requests.at(-1).body.model, 'deepseek-pro');
  assert.equal(f.requests.at(-1).body.messages[1].content, 'Create the project');
  for (const request of f.requests) {
    assert.equal(request.path, '/v1/chat/completions');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['x-api-key'], undefined);
  }
});

test('file tools reject traversal, private files, symlink escapes, and commands by default', async t => {
  const f = await fixture(t, () => ({ final: 'Unused' }));
  await fs.writeFile(path.join(f.dir, 'outside.txt'), 'secret');
  await fs.writeFile(path.join(f.cwd, '.env'), 'secret');
  for (const requested of ['../outside.txt', '.env']) {
    await assert.rejects(executeTool(f.cwd, { name: 'read_file', arguments: { path: requested } }));
  }
  await fs.symlink(f.dir, path.join(f.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(executeTool(f.cwd, { name: 'read_file', arguments: { path: 'escape/outside.txt' } }), /Symlink escapes/);
  await assert.rejects(executeTool(f.cwd, { name: 'run_command', arguments: { argv: [process.execPath, '--version'] } }), /disabled/);
  assert.equal(await fs.readFile(path.join(f.dir, 'outside.txt'), 'utf8'), 'secret');
});

test('Puter transport rejects external endpoints and propagates authentication errors', async t => {
  for (const url of ['https://api.deepseek.com', 'http://example.com', 'http://127.0.0.1/x', 'http://key@localhost']) {
    assert.throws(() => localBridgeUrl(url), /loopback/);
  }
  const f = await fixture(t, () => ({ status: 401, body: { error: { message: 'Puter sign-in required' } } }));
  await assert.rejects(runPuterAgent({ ...f, task: 'Hello', model: 'deepseek-flash' }), /HTTP 401.*sign-in required/);
  assert.equal(f.requests.length, 1);
});

test('malformed model responses have a bounded repair attempt and never execute as commands', async t => {
  const f = await fixture(t, () => ({ body: { choices: [{ message: { content: 'not agent JSON' } }] } }));
  await assert.rejects(runPuterAgent({ ...f, task: 'Hello', model: 'deepseek-flash' }), /required agent JSON/);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(await fs.readdir(f.cwd), []);
});

test('explicitly enabled commands use argv, workspace cwd, and a scrubbed environment', async t => {
  const f = await fixture(t, () => ({ final: 'Unused' }));
  const previous = process.env.PUTER_TEST_API_KEY;
  process.env.PUTER_TEST_API_KEY = 'do-not-forward';
  t.after(() => { if (previous === undefined) delete process.env.PUTER_TEST_API_KEY; else process.env.PUTER_TEST_API_KEY = previous; });
  const result = await executeTool(f.cwd, { name: 'run_command', arguments: {
    argv: [process.execPath, '-e', 'console.log(JSON.stringify({ cwd: process.cwd(), hasKey: Boolean(process.env.PUTER_TEST_API_KEY) }))']
  } }, { allowCommands: true });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.output), { cwd: f.cwd, hasKey: false });
});
