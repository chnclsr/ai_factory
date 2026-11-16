import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHarness, memoryBlock, ROOT } from './router-harness.mjs';
import { parseTranscript, lastExchange, cleanRequest, isRouterCall } from './agy.mjs';
import { snapshotProject } from './store.mjs';
import { readTurns } from './session.mjs';
import { resolveProject } from './project.mjs';

const HOOK = path.join(ROOT, 'plugins', 'ai-factory', 'hooks', 'hook_handler.js');
const CONV = 'ec33ebf9-0cba-4100-8142-c61503f6c587';

function step(index, type, extra = {}) {
  return JSON.stringify({ step_index: index, source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL', type, status: 'DONE', ...extra });
}

function transcript(lines) {
  return lines.join('\n') + '\n';
}

const plainTurn = (request, answer, start = 0) => [
  step(start, 'USER_INPUT', { content: `<USER_REQUEST>\n${request}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>` }),
  step(start + 1, 'PLANNER_RESPONSE', { thinking: 'secret chain of thought THINK-1', tool_calls: [{ name: 'view_file', args: { path: 'a.txt' } }] }),
  step(start + 2, 'GENERIC', { content: 'tool output TOOLOUT-1' }),
  step(start + 3, 'PLANNER_RESPONSE', { content: answer })
];

test('transcript parsing: request without wrapper, final answer, routed turns detected', () => {
  assert.equal(cleanRequest('<USER_REQUEST>\nhello there\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>'), 'hello there');
  assert.equal(cleanRequest('<USER_REQUEST>\n[AI Factory off] Do not use the AI Factory router or any delegation; do the task yourself. Task: tekrar kontrol et\n</USER_REQUEST>'), 'tekrar kontrol et');
  assert.equal(cleanRequest('<USER_REQUEST>plain request mentioning Task: inside</USER_REQUEST>'), 'plain request mentioning Task: inside');
  const steps = parseTranscript(transcript([...plainTurn('first', 'answer one'), ...plainTurn('second question', 'answer two (OWL-9)', 10), 'not json']));
  const last = lastExchange(steps);
  assert.deepEqual([last.step, last.request, last.answer, last.routed], [10, 'second question', 'answer two (OWL-9)', false]);

  assert.equal(isRouterCall({ name: 'run_command', args: { CommandLine: '& "node.exe" "C:/x/router.mjs" --session s --task "do it"' } }), true);
  assert.equal(isRouterCall({ name: 'run_command', args: { CommandLine: 'node "C:/x/router.mjs" memory search billing --cwd .' } }), false);
  // The command the hook hands the agent has --session in front (seen in a real Antigravity run).
  assert.equal(isRouterCall({ name: 'run_command', args: { CommandLine: '& "C:/Program Files/nodejs/node.exe" "C:/x/router.mjs" --session 5b48be91-a5ee-4c71-8e75-10cc17f045de memory search antiuav --cwd "c:\\p"' } }), false);
  assert.equal(isRouterCall({ name: 'run_command', args: { CommandLine: '& "node.exe" "C:/x/router.mjs" --session 5b48be91-a5ee --engine muse --task "x"' } }), true);
  const routed = parseTranscript(transcript([
    step(0, 'USER_INPUT', { content: '<USER_REQUEST>[AI Factory] do it</USER_REQUEST>' }),
    step(1, 'PLANNER_RESPONSE', { tool_calls: [{ name: 'run_command', args: { CommandLine: 'node router.mjs --task "do it"' } }] }),
    step(2, 'PLANNER_RESPONSE', { content: 'The router finished.' })
  ]));
  assert.equal(lastExchange(routed).routed, true);
  assert.equal(lastExchange(parseTranscript(transcript([step(0, 'USER_INPUT', { content: 'q' })]))), null, 'no answer yet');
});

test('record-agy stores the agent turn once, without thinking or tool output, and skips routed turns', t => {
  const h = makeHarness(t);
  const cwd = path.join(h.dir, 'agy');
  fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(h.dir, 'transcript.jsonl');
  fs.writeFileSync(file, transcript(plainTurn('bu repoyu incele', 'Repo incelendi: Rust, tek binary (HERON-5).')));
  const run = () => h.run(['memory', 'record-agy', '--transcript', file, '--session', CONV, '--cwd', cwd, '--model', 'Gemini 3.8 Flash']);

  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /record-agy: recorded \(turn 1\)/);
  assert.match(run().stdout, /record-agy: duplicate/);

  const turns = readTurns(snapshotProject(h.repo, resolveProject({ cwd }).key), CONV);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].engine, 'antigravity');
  assert.equal(turns[0].model, 'Gemini 3.8 Flash');
  assert.equal(turns[0].task, 'bu repoyu incele');
  assert.match(turns[0].response_head, /HERON-5/);
  assert.doesNotMatch(JSON.stringify(turns[0]), /THINK-1|TOOLOUT-1/);

  fs.writeFileSync(file, transcript([...plainTurn('bu repoyu incele', 'Repo incelendi (HERON-5).'),
    step(10, 'USER_INPUT', { content: '<USER_REQUEST>[AI Factory] testleri çalıştır</USER_REQUEST>' }),
    step(11, 'PLANNER_RESPONSE', { tool_calls: [{ name: 'run_command', args: { CommandLine: 'node "C:/r/router.mjs" --task "testleri çalıştır"' } }] }),
    step(12, 'PLANNER_RESPONSE', { content: 'Router ran the tests.' })]));
  assert.match(run().stdout, /record-agy: routed/);

  // The next router call in the same conversation sees the agent's own turn.
  assert.equal(h.run(['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--session', CONV, '--cwd', cwd, '--task', 'what did the review of the repo find?']).status, 0);
  assert.match(memoryBlock(h.lastCall().prompt), /turn 1 \(antigravity\/Gemini 3\.8 Flash\): bu repoyu incele[\s\S]*HERON-5/);
});

function runHook(h, payload) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, AI_FACTORY_DATA_DIR: h.dataDir, AI_FACTORY_CONFIG: h.configFile, AI_FACTORY_ROUTER_DEPTH: '' }
  });
}

test('Stop hook records the agent turn in the background and returns at once', async t => {
  const h = makeHarness(t);
  const cwd = path.join(h.dir, 'stop');
  fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(h.dir, 'transcript.jsonl');
  fs.writeFileSync(file, transcript(plainTurn('analyse the bottleneck', 'The bottleneck is CPU (KESTREL-77).')));
  const base = { conversationId: CONV, workspacePaths: [cwd], transcriptPath: file, modelName: 'gemini-flash' };

  const cancelled = runHook(h, { ...base, terminationReason: 'USER_CANCELED' });
  assert.equal(cancelled.status, 0);
  const started = Date.now();
  const stop = runHook(h, { ...base, terminationReason: 'NO_TOOL_CALL', fullyIdle: true });
  assert.equal(stop.status, 0, stop.stderr);
  assert.ok(Date.now() - started < 10000);
  assert.notEqual(JSON.parse(stop.stdout).decision, 'continue', 'the hook never keeps the agent running');

  let turns = [];
  for (let i = 0; i < 60 && !turns.length; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { turns = readTurns(snapshotProject(h.repo, resolveProject({ cwd }).key), CONV); } catch {}
  }
  assert.equal(turns.length, 1, 'recorded once (the cancelled turn was not)');
  assert.match(turns[0].response_head, /KESTREL-77/);
});

test('SessionStart gets a memory index with the read commands; later invocations do not repeat it', t => {
  const h = makeHarness(t);
  const cwd = path.join(h.dir, 'index');
  fs.mkdirSync(cwd, { recursive: true });
  assert.equal(h.run(['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--session', 'older-chat', '--cwd', cwd, '--task', 'measure the storage needs for 500k series'],
    { actions: { response: 'Storage needs 420 TiB (CONDOR-8).' } }).status, 0);

  const start = runHook(h, { conversationId: CONV, workspacePaths: [cwd] });
  assert.equal(start.status, 0, start.stderr);
  const text = JSON.parse(start.stdout).injectSteps[0].systemMessage.systemMessage;
  assert.match(text, /Project memory: earlier work in this project is recorded/);
  assert.match(text, /memory search <words>/);
  assert.match(text, /memory turn show <n> --session <session>/);
  assert.match(text, /<retrieved-memory untrusted="true" project="[^"]+" kind="index">/);
  assert.match(text, /session older-ch.*\n  - turn 1 \(claude\): measure the storage needs for 500k series → Storage needs 420 TiB \(CONDOR-8\)/);

  const later = runHook(h, { conversationId: CONV, workspacePaths: [cwd], invocationNum: 3, initialNumSteps: 10 });
  assert.doesNotMatch(JSON.parse(later.stdout).injectSteps[0].systemMessage.systemMessage, /kind="index"/);
});

test('the hook command with --session in front still reaches the memory commands', t => {
  const h = makeHarness(t);
  const cwd = path.join(h.dir, 'prefixed');
  fs.mkdirSync(cwd, { recursive: true });
  assert.equal(h.run(['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback', '--session', CONV, '--cwd', cwd, '--task', 'note the deploy rule'],
    { actions: { response: 'Deploys go to staging first (PLOVER-2).' } }).status, 0);
  const shown = h.run(['--session', CONV, 'memory', 'turn', 'show', '1', '--cwd', cwd]);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.match(shown.stdout, /PLOVER-2/);
  const found = h.run(['--session', CONV, 'memory', 'search', 'deploy', 'staging', '--cwd', cwd]);
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /PLOVER-2/);
  assert.equal(h.calls().length, 1, 'no engine ran for the memory commands');
});
