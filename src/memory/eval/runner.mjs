// Memory eval harness, layer 1 (docs/memory-harness-plan.md section 4): replays a scenario and
// scores the exact prompt the engine receives. Not a test file.
//
// History turns are seeded through the memory API (fast, in-process, real recordTurn) unless a
// turn says `via: 'router'`, which runs the real router with a fake engine CLI so the output
// capture path is exercised too. The probe always goes through the real router; the fake CLI
// records the prompt it was given, and that prompt is what gets scored.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHarness, memoryBlock, ROUTER, configuredModels } from '../router-harness.mjs';
import { resolveProbeActions } from './scenarios.mjs';
import { createMemory } from '../index.mjs';
import { initFixtureRepo, commitAll } from '../test-helpers.mjs';
import { estimateTokens } from '../pack.mjs';
import { validateState, writeState } from '../state.mjs';

const DEFAULT_PROBE_ENGINE = { engine: 'claude', model: 'haiku-5.5' };

function readConfig(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Runs the router asynchronously so several scenarios can run at once.
export function runRouter(h, args, { actions = {}, env = {} } = {}) {
  const actionsFile = path.join(h.dir, `actions-${process.hrtime.bigint()}.json`);
  fs.writeFileSync(actionsFile, JSON.stringify(actions));
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [ROUTER, ...args], {
      cwd: h.dir, windowsHide: true,
      env: { ...h.env, ...env, AI_FACTORY_FAKE_ACTIONS: '', AI_FACTORY_FAKE_ACTIONS_FILE: actionsFile }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('close', status => {
      clearTimeout(timer);
      try { fs.rmSync(actionsFile, { force: true }); } catch {}
      resolve({ status, stdout, stderr, ms: Date.now() - started });
    });
  });
}

function projectDir(h, scenario, name) {
  const dir = path.join(h.dir, 'projects', name);
  if (!fs.existsSync(dir)) {
    if (scenario.git) {
      initFixtureRepo(dir);
      fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
      fs.writeFileSync(path.join(dir, '.ai-factory.toml'), `project = "${name}"\n`);
      commitAll(dir, 'base');
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.ai-factory.toml'), `project = "${name}"\n`);
    }
  }
  return dir;
}

function engineArgs(spec) {
  const args = ['--engine', spec.engine];
  if (spec.model) args.push('--model', spec.model);
  return args;
}

// Seeds one turn through the memory API: the same recordTurn the router calls after an engine run.
function seedTurn(memory, { cwd, session, turn }) {
  const ctx = memory.resolveSession({ cwd, session });
  if (!ctx) throw new Error('resolveSession failed while seeding');
  for (const [file, content] of Object.entries(turn.writes || {})) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const ok = turn.ok !== false;
  const result = memory.recordTurn(ctx, {
    task: turn.task, engine: turn.engine, model: turn.model || turn.engine, ok,
    succeedWith: ok ? `${turn.engine}-${turn.model || turn.engine}` : null, aborted: !ok,
    output: turn.reply, attempts: ok ? [] : [`${turn.engine}: ${turn.error || 'failed'}`]
  });
  if (!result) throw new Error('recordTurn failed while seeding');
}

function normalise(text) {
  return String(text || '').replace(/\s+/g, ' ').toLocaleLowerCase('tr');
}

function contains(haystack, needle) {
  return normalise(haystack).includes(normalise(needle));
}

// Everything the engine got except the user's own task (which would trivially "contain" itself).
function contextOf(prompt, task) {
  const text = String(prompt || '');
  return task && text.endsWith(task) ? text.slice(0, text.length - task.length) : text;
}

export function scorePrompt(scenario, prompt, task, budget) {
  const context = contextOf(prompt, task);
  const block = memoryBlock(prompt) || '';
  const expect = scenario.expect || {};
  const present = expect.present || [];
  const found = present.filter(fact => contains(context, fact));
  const missing = present.filter(fact => !contains(context, fact));
  const leaked = (expect.absent || []).filter(fact => contains(context, fact));
  // Counted over the whole context: a stored closing tag that survived would end the block early.
  const closingTags = (context.match(/<\/retrieved-memory>/g) || []).length;
  const blockTokens = estimateTokens(block);
  const checks = [];
  if (expect.maxClosingTags !== undefined && closingTags > expect.maxClosingTags) checks.push(`closing tags ${closingTags}`);
  if (budget && blockTokens > budget) checks.push(`block ${blockTokens} tokens over budget ${budget}`);
  if (expect.order) {
    const positions = expect.order.map(fact => normalise(context).indexOf(normalise(fact)));
    if (positions.some(p => p < 0) || positions.some((p, i) => i > 0 && p < positions[i - 1])) checks.push(`order ${expect.order.join(' < ')}`);
  }
  const coverage = present.length ? found.length / present.length : 1;
  return {
    pass: missing.length === 0 && leaked.length === 0 && checks.length === 0,
    coverage, found, missing, leaked, checks, blockTokens, budget, closingTags,
    promptChars: String(prompt || '').length
  };
}

function budgetOf(config, spec) {
  const models = config.engines?.[spec.engine]?.models || {};
  const name = spec.model || config.engines?.[spec.engine]?.default_model;
  const entry = models[name] || Object.values(models).find(m => m.id === name);
  return entry?.memory_budget_tokens ?? config.memory?.default_budget_tokens ?? 1200;
}

// Builds the scenario's history in `h` and returns what the probe needs. Shared with the live layer.
export async function prepareScenario(h, scenario, { seedOnly = false } = {}) {
  const config = readConfig(h.configFile);
  const memory = createMemory({
    repoDir: h.repo, dataDir: h.dataDir, indexFile: path.join(h.dataDir, 'memory-index.sqlite'),
    memoryConfig: config.memory, routerConfig: config, env: {}, log: () => {}
  });
  const defaultProject = scenario.project || 'eval';
  const sessionOf = turn => turn.session || scenario.session || 'eval-session';
  for (const turn of scenario.turns || []) {
    const cwd = projectDir(h, scenario, turn.project || defaultProject);
    if (turn.handoff) {
      const r = await runRouter(h, ['memory', 'handoff', 'begin', '--to', turn.handoff.to, '--task', turn.handoff.task, '--cwd', cwd]);
      if (r.status !== 0) throw new Error(`handoff begin failed: ${r.stderr}`);
      continue;
    }
    // The live layer seeds everything through the API: a `via: 'router'` turn would call a real engine.
    if (turn.via === 'router' && !seedOnly) {
      const r = await runRouter(h, ['--session', sessionOf(turn), ...engineArgs(turn), '--no-fallback', '--cwd', cwd, '--task', turn.task],
        { actions: { response: turn.reply, writes: turn.writes } });
      if (r.status !== 0) throw new Error(`seed turn via router failed: ${r.stdout.slice(-400)} ${r.stderr.slice(-400)}`);
      continue;
    }
    seedTurn(memory, { cwd, session: sessionOf(turn), turn });
  }
  // A probe that names its engine does not inherit the default probe's model.
  // A scenario can seed a model-written state, as the background updater would have stored it.
  if (scenario.state) {
    const sid = scenario.session || 'eval-session';
    const seeded = (scenario.turns || []).filter(t => !t.handoff && sessionOf(t) === sid).length;
    const state = validateState(scenario.state, { maxTurn: seeded, engine: 'seed', model: 'seed' });
    if (!state) throw new Error('scenario.state is not a valid state');
    writeState(h.repo, defaultProject, sid, state);
  }
  const probe = scenario.probe?.engine ? { ...scenario.probe } : { ...DEFAULT_PROBE_ENGINE, ...scenario.probe };
  const cwd = projectDir(h, scenario, probe.project || defaultProject);
  const session = probe.session || scenario.session || 'eval-session';
  return { probe, cwd, session, config };
}

export async function runScenario(scenario, { dir, mutateConfig } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const h = createHarness(dir, { config: cfg => { if (mutateConfig) mutateConfig(cfg); if (scenario.config) scenario.config(cfg); } });
  const started = Date.now();
  try {
    const { probe, cwd, session, config } = await prepareScenario(h, scenario);
    h.resetCalls();
    const args = ['--session', session];
    if (probe.engine !== 'auto') args.push(...engineArgs(probe));
    if (probe.noFallback !== false && probe.engine !== 'auto') args.push('--no-fallback');
    args.push('--cwd', cwd, '--task', probe.task);
    const run = await runRouter(h, args, { actions: resolveProbeActions(scenario, configuredModels().chain[0]) });
    const call = h.calls().at(-1);
    const memoryLine = (run.stdout.match(/^memory: .*$/m) || [''])[0];
    if (!call) {
      return { id: scenario.id, category: scenario.category, lang: scenario.lang, gate: Boolean(scenario.gate),
        pass: false, coverage: 0, error: `no engine call (exit ${run.status}): ${run.stdout.slice(-300)}`, memoryLine, ms: Date.now() - started };
    }
    // The router reports the budget it used (it includes any conversation share); fall back to config.
    const reported = memoryLine.match(/~\d+\/(\d+) tokens/);
    const budget = reported ? Number(reported[1]) : budgetOf(config, { engine: call.engine, model: probe.model });
    const score = scorePrompt(scenario, call.prompt, probe.task, budget);
    return { id: scenario.id, category: scenario.category, lang: scenario.lang, gate: Boolean(scenario.gate),
      engine: call.engine, ...score, memoryLine, probeMs: run.ms, ms: Date.now() - started };
  } catch (err) {
    return { id: scenario.id, category: scenario.category, lang: scenario.lang, gate: Boolean(scenario.gate),
      pass: false, coverage: 0, error: String(err?.message || err).slice(0, 500), ms: Date.now() - started };
  }
}

// Runs scenarios with bounded concurrency; results keep the input order.
export async function runSuite(scenarios, { dir, concurrency = 4, mutateConfig, onResult } = {}) {
  const results = new Array(scenarios.length);
  let next = 0;
  async function worker() {
    while (next < scenarios.length) {
      const index = next++;
      const scenario = scenarios[index];
      results[index] = await runScenario(scenario, { dir: path.join(dir, `${String(index).padStart(2, '0')}-${scenario.id}`), mutateConfig });
      onResult?.(results[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, worker));
  return results;
}

export function summarise(results) {
  const byCategory = {};
  for (const r of results) {
    const c = byCategory[r.category] ||= { scenarios: 0, passed: 0, coverage: 0 };
    c.scenarios++;
    if (r.pass) c.passed++;
    c.coverage += r.coverage || 0;
  }
  for (const c of Object.values(byCategory)) c.coverage = +(c.coverage / c.scenarios).toFixed(3);
  const gated = results.filter(r => r.gate);
  return {
    scenarios: results.length,
    passed: results.filter(r => r.pass).length,
    coverage: +(results.reduce((n, r) => n + (r.coverage || 0), 0) / Math.max(1, results.length)).toFixed(3),
    gatedCoverage: +(gated.reduce((n, r) => n + (r.coverage || 0), 0) / Math.max(1, gated.length)).toFixed(3),
    overBudget: results.filter(r => (r.checks || []).some(c => c.includes('over budget'))).length,
    byCategory
  };
}

// Regressions of `current` against a stored baseline: a scenario whose coverage dropped, or that
// passed before and fails now.
export function compareToBaseline(current, baseline) {
  const before = new Map((baseline?.results || []).map(r => [r.id, r]));
  const regressions = [];
  const improvements = [];
  for (const r of current) {
    const b = before.get(r.id);
    if (!b) continue;
    if ((r.coverage ?? 0) < (b.coverage ?? 0) - 1e-9 || (b.pass && !r.pass)) regressions.push({ id: r.id, before: b.coverage, after: r.coverage });
    else if ((r.coverage ?? 0) > (b.coverage ?? 0) + 1e-9 || (!b.pass && r.pass)) improvements.push({ id: r.id, before: b.coverage, after: r.coverage });
  }
  return { regressions, improvements };
}
