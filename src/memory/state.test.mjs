import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, memoryBlock, ROUTER } from './testing/router-harness.mjs';
import { createMemory } from './index.mjs';
import { extractJson, validateState, renderState, readState } from './state.mjs';
import { snapshotProject } from './store.mjs';
import { resolveProject } from './project.mjs';

function workDir(h, name) {
  const dir = path.join(h.dir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const CLAUDE = ['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback'];

function seed(h, cwd, session, count, firstReply) {
  for (let i = 1; i <= count; i++) {
    const result = h.run([...CLAUDE, '--session', session, '--cwd', cwd, '--task', `step ${i} of the long analysis please`],
      { actions: { response: i === 1 ? firstReply : `Step ${i} done, nothing special.` } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
}

test('extractJson finds the state object among status lines and the execution report', () => {
  const noisy = `[AI Factory] Karar: VIBE\nsome { brace } text\n{"goal":"ship the exporter","items":[{"type":"answer","text":"use }streams{","turns":[2]}]}\n============\n[AI FACTORY EXECUTION REPORT]\npath: gemini --> vibe [OK]\n`;
  const value = extractJson(noisy);
  assert.equal(value.goal, 'ship the exporter');
  assert.equal(value.items[0].text, 'use }streams{');
  assert.equal(extractJson('no json at all'), null);
  assert.equal(extractJson('{"unrelated": 1}'), null);
});

test('validateState drops items that cannot be traced to a real turn and masks secrets', () => {
  const state = validateState({
    goal: '  ship   the exporter  ', next_step: 'run staging',
    items: [
      { type: 'answer', text: 'bottleneck is CPU (KESTREL-41)', turns: [2, 99, 'x', 2] },
      { type: 'decision', text: 'no turn number', turns: [] },
      { type: 'nonsense', text: 'unknown type', turns: [1] },
      { type: 'fact', text: 'token sk-abcdefghijklmnopqrstuvwxyz123456 leaked', turns: [3] },
      { type: 'fact', text: '', turns: [1] }
    ]
  }, { maxTurn: 12, engine: 'vibe', model: 'flash' });
  assert.equal(state.through_turn, 12);
  assert.equal(state.goal, 'ship the exporter');
  assert.deepEqual(state.items.map(i => [i.type, i.turns]), [['answer', [2]], ['fact', [3]]]);
  assert.doesNotMatch(JSON.stringify(state), /sk-abcdefghijklmnopqrstuvwxyz123456/);
  assert.equal(validateState({ items: [] }, { maxTurn: 3 }), null);
  const lines = renderState(state, 1000);
  assert.ok(lines.some(l => /answer: bottleneck is CPU \(KESTREL-41\) \(turn 2\)/.test(l)), lines.join('|'));
});

test('state update writes a state once, refuses an older one, and the block uses it instead of the old turns', t => {
  const h = makeHarness(t, { config: cfg => { cfg.memory.conversation_tokens = 500; for (const m of Object.values(cfg.engines.claude.models)) delete m.memory_conversation_tokens; } });
  const cwd = workDir(h, 'state');
  seed(h, cwd, 'long', 12, 'Analysis. ' + 'Detail. '.repeat(120) + 'Conclusion: the bottleneck is CPU data preparation (KESTREL-41).');

  const summary = JSON.stringify({ goal: 'find the training bottleneck', next_step: 'move augmentation to the GPU',
    items: [{ type: 'answer', text: 'bottleneck is CPU data preparation, not NVMe (KESTREL-41)', turns: [1] },
      { type: 'tried_failed', text: 'raising the disk queue depth did not help', turns: [4, 5] }] });
  const update = h.run(['memory', 'state', 'update', '--session', 'long', '--cwd', cwd, '--force', '--engine', 'vibe/vibe-glm-5.3-flash'], { actions: { response: summary } });
  assert.equal(update.status, 0, update.stdout + update.stderr);
  assert.match(update.stdout, /state update: written, 2 item\(s\) through turn 12/);

  const state = readState(snapshotProject(h.repo, resolveProject({ cwd }).key), 'long');
  assert.equal(state.through_turn, 12);
  assert.equal(state.items[0].turns[0], 1);

  const shown = h.run(['memory', 'state', 'show', '--session', 'long', '--cwd', cwd]);
  assert.match(shown.stdout, /KESTREL-41/);

  // The nested summariser call must not have been recorded as a turn of any session.
  const sessions = snapshotProject(h.repo, resolveProject({ cwd }).key).list('sessions').filter(e => e.name.endsWith('.meta.json'));
  assert.equal(sessions.length, 1);

  assert.equal(h.run([...CLAUDE, '--session', 'long', '--cwd', cwd, '--task', 'are you sure?']).status, 0);
  const block = memoryBlock(h.lastCall().prompt);
  assert.match(block, /State of this conversation through turn 12/);
  assert.match(block, /KESTREL-41/);
  assert.match(block, /Turns up to 10 are condensed in the state above/);
  assert.doesNotMatch(block, /turn 1 \(/, 'turn 1 is covered by the state, not repeated raw');
  assert.match(block, /turn 12 \(/);
  assert.match(h.lastCall().prompt, /state items cite turns up to 12/);

  assert.match(h.run(['memory', 'state', 'update', '--session', 'long', '--cwd', cwd]).stdout, /state update: disabled/, 'state_every_turns 0 switches background updates off');
  h.writeConfig(cfg => { cfg.memory.conversation_tokens = 500; cfg.memory.state_every_turns = 6; cfg.memory.state_min_turns = 8; for (const m of Object.values(cfg.engines.claude.models)) delete m.memory_conversation_tokens; });
  const again = h.run(['memory', 'state', 'update', '--session', 'long', '--cwd', cwd], { actions: { response: summary } });
  assert.match(again.stdout, /state update: not_due/);
  const stale = h.run(['memory', 'state', 'update', '--session', 'long', '--cwd', cwd, '--force'], { actions: { response: 'I could not do that.' } });
  assert.match(stale.stdout, /state update: unusable_output/);
  assert.equal(stale.status, 1);
  assert.equal(readState(snapshotProject(h.repo, resolveProject({ cwd }).key), 'long').through_turn, 12, 'a failed update leaves the old state');
});

test('state_tokens 0 ignores a stored state and the old conversation lines return', t => {
  const h = makeHarness(t, { config: cfg => { cfg.memory.conversation_tokens = 3000; for (const m of Object.values(cfg.engines.claude.models)) delete m.memory_conversation_tokens; } });
  const cwd = workDir(h, 'off');
  seed(h, cwd, 'off', 9, 'First answer with the code OWL-5.');
  const summary = JSON.stringify({ goal: 'g', items: [{ type: 'fact', text: 'state-only fact STATEONLY-1', turns: [1] }] });
  assert.equal(h.run(['memory', 'state', 'update', '--session', 'off', '--cwd', cwd, '--force'], { actions: { response: summary } }).status, 0);
  h.writeConfig(cfg => { cfg.memory.conversation_tokens = 3000; cfg.memory.state_tokens = 0; for (const m of Object.values(cfg.engines.claude.models)) delete m.memory_conversation_tokens; });
  assert.equal(h.run([...CLAUDE, '--session', 'off', '--cwd', cwd, '--task', 'are you sure?']).status, 0);
  const block = memoryBlock(h.lastCall().prompt);
  assert.doesNotMatch(block, /STATEONLY-1/);
  assert.match(block, /OWL-5/);
});

test('--no-memory neither reads nor records anything', t => {
  const h = makeHarness(t);
  const cwd = workDir(h, 'nomem');
  seed(h, cwd, 'nm', 1, 'A reply with the code HAWK-2.');
  const before = snapshotProject(h.repo, resolveProject({ cwd }).key).seq;
  const result = h.run([...CLAUDE, '--no-memory', '--session', 'nm', '--cwd', cwd, '--task', 'what was the code in the previous reply?']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(memoryBlock(h.lastCall().prompt), null);
  assert.doesNotMatch(result.stdout, /^memory:/m);
  assert.equal(snapshotProject(h.repo, resolveProject({ cwd }).key).seq, before);
});

test('stateJob starts only for a long, stale session at depth 0 and only when enabled', t => {
  const h = makeHarness(t);
  const cwd = workDir(h, 'job');
  seed(h, cwd, 'job', 8, 'First.');
  const config = JSON.parse(fs.readFileSync(h.configFile, 'utf8'));
  const make = (memoryConfig, env = {}) => createMemory({ repoDir: h.repo, dataDir: h.dataDir, indexFile: null, memoryConfig: { ...config.memory, ...memoryConfig },
    routerConfig: config, env, log: () => {}, routerScript: ROUTER });
  const ctxOf = memory => memory.resolveSession({ cwd, session: 'job' });

  let memory = make({ state_every_turns: 0 });
  assert.equal(memory.stateJob(ctxOf(memory), { n: 8 }), null, 'off by default');
  memory = make({ state_every_turns: 6, state_min_turns: 8 });
  const job = memory.stateJob(ctxOf(memory), { n: 8 });
  assert.ok(job, 'due at turn 8');
  assert.deepEqual(job.args.slice(1, 4), ['memory', 'state', 'update']);
  assert.equal(memory.stateJob(ctxOf(memory), { n: 7 }), null, 'below state_min_turns');
  assert.equal(memory.stateJob(ctxOf(memory), { n: 8 }, { ok: false }), null, 'failed turns do not start one');
  assert.equal(make({ state_every_turns: 6, state_min_turns: 8 }, { AI_FACTORY_ROUTER_DEPTH: '1' }).stateJob(ctxOf(memory), { n: 8 }), null, 'never from a helper');

  assert.equal(h.run(['memory', 'state', 'update', '--session', 'job', '--cwd', cwd, '--force'], { actions: { response: JSON.stringify({ goal: 'g', items: [{ type: 'fact', text: 'f', turns: [1] }] }) } }).status, 0);
  assert.equal(memory.stateJob(ctxOf(memory), { n: 9 }), null, 'state is only 1 turn stale');
});
