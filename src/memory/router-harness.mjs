// Fake engine CLIs for router-level memory tests. Not a test file itself.
//
// A preload replaces child_process.spawn so every engine command runs a fake CLI instead. The fake
// reads the task from the engine's real channel (prompt file, --file attachment or stdin redirect),
// records it, applies scripted file edits in its working directory and prints output in the
// engine's real format, including a session id.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tempDir } from './test-helpers.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const ROUTER = path.join(ROOT, 'router.mjs');

// Model ids as the fake CLIs see them, read from router_config.json so tests follow the chain
// order and the vibe default model instead of hard-coding them.
export function configuredModels() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'router_config.json'), 'utf8'));
  const idOf = (engine, name) => config.engines[engine].models[name].id;
  return {
    chain: config.fallback_chain.map(entry => idOf(entry.engine, entry.model)),
    vibeDefault: idOf('vibe', config.engines.vibe.default_model),
    vibeComplex: idOf('vibe', config.engines.vibe.complex_model)
  };
}

export const FAKE_SESSION_IDS = {
  opencode: 'ses_Fake1',
  claude: '11111111-1111-4111-8111-111111111111',
  codex: '22222222-2222-4222-8222-222222222222',
  vibe: '33333333-3333-4333-8333-333333333333',
  muse: null
};

const MOCK = `
import fs from 'node:fs';
import path from 'node:path';
const [engine, command] = process.argv.slice(2);
const ids = ${JSON.stringify(FAKE_SESSION_IDS)};
const fileMatch = command.match(/--prompt-file "([^"]+)"/) || command.match(/--file "([^"]+)"/) || command.match(/< "([^"]+)"/);
const prompt = fileMatch ? fs.readFileSync(fileMatch[1], 'utf8') : '';
const model = (command.match(/--model (\\S+)/) || command.match(/ -m (\\S+)/) || [])[1] || null;
const actions = JSON.parse(process.env.AI_FACTORY_FAKE_ACTIONS || '{}');
const perEngine = (actions.byEngine && actions.byEngine[engine]) || {};
fs.appendFileSync(process.env.AI_FACTORY_FAKE_CALLS, JSON.stringify({ engine, model, command, prompt, cwd: process.cwd() }) + '\\n');
if ((actions.fail || []).includes(model) || (actions.fail || []).includes(engine)) {
  process.stderr.write('429 rate limit\\n');
  process.exit(1);
}
for (const [file, content] of Object.entries({ ...(actions.writes || {}), ...(perEngine.writes || {}) })) {
  const target = path.join(process.cwd(), file);
  if (content === null) fs.rmSync(target, { force: true });
  else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
}
const text = perEngine.response || actions.response || ('MOCK_OK from ' + engine);
const museSession = (command.match(/--session-id (\\S+)/) || [])[1];
if (engine === 'opencode') process.stdout.write(JSON.stringify({ type: 'text', sessionID: ids.opencode, part: { text } }) + '\\n');
else if (engine === 'claude') process.stdout.write(JSON.stringify({ type: 'result', session_id: ids.claude, result: text }) + '\\n');
else if (engine === 'vibe') process.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', id: 'm1', generationStatus: 'completed', sessionId: ids.vibe, content: [{ type: 'text', text }] }) + '\\n');
else if (engine === 'codex') process.stdout.write(text + '\\nsession id: ' + ids.codex + '\\n');
else process.stdout.write(text + (museSession ? '' : '') + '\\n');
`;

const PRELOAD = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const childProcess = createRequire(import.meta.url)('node:child_process');
const realSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const engine = typeof command === 'string' && (command.match(/^(opencode|muse|codex|claude|vibe)\\b/) || [])[1];
  if (engine) return realSpawn(process.execPath, [process.env.AI_FACTORY_MOCK, engine, command], { ...options, shell: false });
  return realSpawn(command, args, options);
};
syncBuiltinESMExports();
`;

export function makeHarness(t, { config } = {}) {
  const dir = tempDir(t, 'ai-factory-mem-');
  const mock = path.join(dir, 'mock.mjs');
  const preload = path.join(dir, 'preload.mjs');
  const callsFile = path.join(dir, 'calls.jsonl');
  const dataDir = path.join(dir, 'state');
  fs.writeFileSync(mock, MOCK);
  fs.writeFileSync(preload, PRELOAD);
  const baseConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'router_config.json'), 'utf8'));
  const configFile = path.join(dir, 'router_config.json');
  const writeConfig = mutate => {
    const next = structuredClone(baseConfig);
    // Under a parallel test run git spawns can take seconds; the product default stays 2 s.
    next.memory = { ...next.memory, file_budget_ms: 30000 };
    if (mutate) mutate(next);
    fs.writeFileSync(configFile, JSON.stringify(next));
  };
  writeConfig(config);
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`.trim(),
    AI_FACTORY_MOCK: mock,
    AI_FACTORY_FAKE_CALLS: callsFile,
    AI_FACTORY_DATA_DIR: dataDir,
    AI_FACTORY_CONFIG: configFile
  };
  delete env.AI_FACTORY_SESSION_ID;
  delete env.AI_FACTORY_ROUTER_DEPTH;
  return {
    dir,
    dataDir,
    repo: path.join(dataDir, 'memory.git'),
    configFile,
    writeConfig,
    run(args, { actions = {}, cwd = dir, extraEnv = {}, router = ROUTER, input } = {}) {
      return spawnSync(process.execPath, [router, ...args], {
        cwd, input, encoding: 'utf8', timeout: 60000,
        env: { ...env, ...extraEnv, AI_FACTORY_FAKE_ACTIONS: JSON.stringify(actions) }
      });
    },
    calls() {
      return fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    },
    lastCall() {
      return this.calls().at(-1);
    },
    resetCalls() {
      fs.rmSync(callsFile, { force: true });
    }
  };
}

export function memoryBlock(prompt) {
  const match = String(prompt).match(/<retrieved-memory untrusted="true"[\s\S]*?<\/retrieved-memory>/);
  return match ? match[0] : null;
}
