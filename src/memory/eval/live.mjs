// Memory eval harness, layers 2 and 3 (docs/memory-harness-plan.md section 4). Not a test file.
//
// Layer 2: each scenario's history is seeded through the memory API (no engine calls), then the
// probe goes to a real engine through the real router. The engine's recorded answer is graded by a
// judge: the cheapest fast model in router_config.json by default (vibe/vibe-glm-5.3-flash), called
// through the router with memory switched off so judge calls never feed each other.
// Layer 3: the same, for real sessions exported from .runtime/memory.git with probes added by hand.
//
// Runs only with AI_FACTORY_LIVE=1; each probe and each judge call is one real engine call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../router-harness.mjs';
import { prepareScenario, runRouter } from './runner.mjs';
import { snapshotProject } from '../store.mjs';
import { readTurns, listSessions, findSession } from '../session.mjs';

const CONFIG_FILE = path.join(ROOT, 'router_config.json');
const REPLAY_DIR = path.join(ROOT, '.runtime', 'memory-eval', 'replays');
const DEFAULT_JUDGE = 'vibe/vibe-glm-5.3-flash';
// Phrases an engine uses when it treats the memory block as an attack instead of context.
const REJECTION = /prompt[- ]injection|untrusted (content|data|block)|cannot follow (these|the|those) instructions|will not act on (the )?retrieved/i;

function realEnv(dataDir, configFile) {
  const env = { ...process.env, AI_FACTORY_DATA_DIR: dataDir, AI_FACTORY_CONFIG: configFile };
  delete env.AI_FACTORY_ROUTER_DEPTH;
  delete env.AI_FACTORY_SESSION_ID;
  delete env.AI_FACTORY_MOCK;
  return env;
}

function liveHarness(dir, mutateConfig) {
  const dataDir = path.join(dir, 'state');
  fs.mkdirSync(dataDir, { recursive: true });
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  config.memory = { ...config.memory, auto_session_minutes: 0, state_every_turns: 0 };
  if (mutateConfig) mutateConfig(config);
  const configFile = path.join(dir, 'router_config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { dir, dataDir, repo: path.join(dataDir, 'memory.git'), configFile, env: realEnv(dataDir, configFile), calls: () => [], resetCalls() {} };
}

function lastReply(h, projectKey, session) {
  const snapshot = snapshotProject(h.repo, projectKey);
  const sid = findSession(snapshot, session) || session;
  const turn = readTurns(snapshot, sid).filter(t => t.kind === 'turn').at(-1);
  if (!turn) return '';
  return (turn.response_ref && snapshot.read(turn.response_ref)) || turn.response_head || '';
}

async function judge({ judgeSpec, dir, question, rubric, answer }) {
  const [engine, model] = judgeSpec.split('/');
  const h = liveHarness(path.join(dir, 'judge'), cfg => { cfg.memory = { ...cfg.memory, enabled: false }; });
  const task = [
    'You grade one answer from an AI coding assistant. Reply with exactly one line: "VERDICT: PASS" or "VERDICT: FAIL", then one short reason.',
    `Question the assistant was asked: ${question}`,
    `What a passing answer must do: ${rubric}`,
    'Answer to grade (between the markers):',
    '<<<ANSWER', String(answer).slice(0, 6000), 'ANSWER>>>'
  ].join('\n');
  const args = ['--engine', engine, ...(model ? ['--model', model] : []), '--no-fallback', '--cwd', h.dir, '--task', task];
  const run = await runRouter(h, args);
  const verdicts = [...run.stdout.matchAll(/VERDICT:\s*(PASS|FAIL)/gi)].map(m => m[1].toUpperCase());
  return { verdict: verdicts.at(-1) || 'UNKNOWN', ms: run.ms };
}

function majority(values) {
  const pass = values.filter(v => v === 'PASS').length;
  return pass * 2 > values.length ? 'PASS' : 'FAIL';
}

function loadReplays() {
  if (!fs.existsSync(REPLAY_DIR)) return [];
  return fs.readdirSync(REPLAY_DIR).filter(f => f.endsWith('.json')).flatMap(file => {
    const data = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, file), 'utf8'));
    return (data.probes || []).map((p, i) => ({
      id: `replay-${path.basename(file, '.json')}-${i + 1}`, category: 'replay', lang: data.lang || 'tr',
      project: data.project || 'replay', turns: data.turns, probe: { task: p.task, engine: p.engine },
      live: { rubric: p.rubric }
    }));
  });
}

export async function runLive({ scenarios, replay = false, engines = ['vibe', 'muse', 'claude'], runs = 1, judge: judgeSpec, stateEngine, settings = {}, log = () => {} }) {
  if (process.env.AI_FACTORY_LIVE !== '1') throw new Error('Set AI_FACTORY_LIVE=1 to run real engine CLIs.');
  const set = (replay ? loadReplays() : scenarios).filter(s => s.live?.rubric);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-live-eval-'));
  const rows = [];
  try {
    for (const scenario of set) {
      for (const engine of engines) {
        const verdicts = [];
        const detail = [];
        for (let run = 0; run < runs; run++) {
          const dir = path.join(work, `${scenario.id}-${engine}-${run}`);
          const h = liveHarness(dir, cfg => { cfg.memory = { ...cfg.memory, ...settings }; });
          try {
            const { probe, cwd, session } = await prepareScenario(h, scenario, { seedOnly: true });
            // An entry may name a model too ("vibe/vibe-glm-5.3-flash"); otherwise the engine default runs.
            const [engineName, modelName] = engine.split('/');
            const args = ['--session', session, '--engine', engineName, ...(modelName ? ['--model', modelName] : []), '--no-fallback', '--cwd', cwd, '--task', probe.task];
            // A scenario can ask for the real background state update first (one extra engine call).
            let stateLine = '';
            if (scenario.generateState) {
              const upd = await runRouter(h, ['memory', 'state', 'update', '--session', session, '--cwd', cwd, '--force', '--engine', stateEngine || DEFAULT_JUDGE]);
              stateLine = (upd.stdout.match(/^state update: .*$/m) || [upd.stderr.slice(-120)])[0];
            }
            const result = await runRouter(h, args);
            const memoryLine = (result.stdout.match(/^memory: .*$/m) || [''])[0];
            const answer = lastReply(h, scenario.project || probe.project || 'eval', session);
            const rejected = REJECTION.test(answer);
            const graded = answer ? await judge({ judgeSpec: judgeSpec || DEFAULT_JUDGE, dir, question: probe.task, rubric: scenario.live.rubric, answer }) : { verdict: 'FAIL' };
            verdicts.push(graded.verdict);
            detail.push({ run, verdict: graded.verdict, rejected, memoryLine, stateLine, probeMs: result.ms, judgeMs: graded.ms,
              answer: answer.replace(/\s+/g, ' ').slice(0, 300), exit: result.status });
          } catch (err) {
            verdicts.push('FAIL');
            detail.push({ run, verdict: 'FAIL', error: String(err?.message || err).slice(0, 300) });
          }
        }
        const row = { id: scenario.id, category: scenario.category, engine, verdict: majority(verdicts),
          rejected: detail.filter(d => d.rejected).length, runs: detail };
        rows.push(row);
        log(`${row.verdict.padEnd(4)} ${scenario.id.padEnd(30)} ${engine.padEnd(7)} ${row.rejected ? `rejected ${row.rejected}/${runs} ` : ''}${detail.at(-1)?.answer?.slice(0, 90) || detail.at(-1)?.error || ''}`);
      }
    }
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  }
  const byEngine = {};
  for (const r of rows) {
    const e = byEngine[r.engine] ||= { scenarios: 0, passed: 0, rejected: 0 };
    e.scenarios++;
    if (r.verdict === 'PASS') e.passed++;
    e.rejected += r.rejected;
  }
  log(`\n${Object.entries(byEngine).map(([e, s]) => `${e}: ${s.passed}/${s.scenarios} passed, ${s.rejected} rejection(s)`).join('; ')}`);
  return { layer: replay ? 3 : 2, date: new Date().toISOString(), judge: judgeSpec || DEFAULT_JUDGE, runs, settings, byEngine, rows };
}

// Copies one real session into .runtime/memory-eval/replays/<name>.json (gitignored: it holds
// your own conversations). Add probes to the file by hand: [{ "task": "...", "rubric": "..." }].
export function exportSession({ project, session, name, repoDir = path.join(ROOT, '.runtime', 'memory.git') }) {
  if (!project || !session) throw new Error('Usage: --export <project> <session|alias>');
  const snapshot = snapshotProject(repoDir, project);
  const sid = findSession(snapshot, session) || listSessions(snapshot).find(s => s.sid.startsWith(session))?.sid;
  if (!sid) throw new Error(`session ${session} not found in project ${project}`);
  const turns = readTurns(snapshot, sid).filter(t => t.kind === 'turn').map(t => ({
    engine: t.engine, model: t.model, ok: t.ok, task: t.task,
    reply: (t.response_ref && snapshot.read(t.response_ref)) || t.response_head || ''
  }));
  fs.mkdirSync(REPLAY_DIR, { recursive: true });
  const file = path.join(REPLAY_DIR, `${name || `${project}-${sid.slice(0, 8)}`}.json`);
  fs.writeFileSync(file, JSON.stringify({ project: `replay-${project}`.slice(0, 60), source: { project, sid }, turns,
    probes: [{ task: 'emin misin', rubric: 'Replace with what a correct answer must do.' }] }, null, 2));
  return file;
}
