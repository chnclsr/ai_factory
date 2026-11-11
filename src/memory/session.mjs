// Sessions and turns inside a project's chain.
//
//   sessions/<sid>.jsonl                  one line per router call (append-only)
//   sessions/<sid>.meta.json              alias, cwd, engine_sessions, last_injected_seq, turn count
//   sessions/<sid>/turns/<n>.response.md  full response, up to 256 KB
//   sessions/<sid>/turns/<n>.patch        the turn's own diff, up to 512 KB
//   session-aliases.json                  alias -> sid for this project

import { commitProject, snapshotProject, uuidv7 } from './store.mjs';
import { sanitizeText, sanitizeValue } from './sanitize.mjs';

export const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const ALIASES_FILE = 'session-aliases.json';
const RESPONSE_HEAD_BYTES = 2048;
const RESPONSE_MAX_BYTES = 256 * 1024;
const TASK_MAX_BYTES = 8192;

export function isValidSid(sid) {
  return typeof sid === 'string' && SID_RE.test(sid) && !sid.endsWith('.lock') && !sid.includes('..');
}

export function sessionPaths(sid) {
  if (!isValidSid(sid)) throw new Error(`invalid session id: ${sid}`);
  return {
    log: `sessions/${sid}.jsonl`,
    meta: `sessions/${sid}.meta.json`,
    turnDir: `sessions/${sid}/turns`
  };
}

export function newSessionId(now) {
  return uuidv7(now);
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export function readMeta(snapshot, sid) {
  return parseJson(snapshot.read(sessionPaths(sid).meta), null);
}

export function readTurns(snapshot, sid) {
  const text = snapshot.read(sessionPaths(sid).log);
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const turn = parseJson(line, null);
    if (turn) out.push(turn);
  }
  return out;
}

export function readAliases(snapshot) {
  return parseJson(snapshot.read(ALIASES_FILE), {});
}

export function findSession(snapshot, nameOrSid) {
  if (!nameOrSid) return null;
  const aliases = readAliases(snapshot);
  if (Object.hasOwn(aliases, nameOrSid)) return aliases[nameOrSid];
  if (isValidSid(nameOrSid) && snapshot.read(sessionPaths(nameOrSid).meta)) return nameOrSid;
  return null;
}

export function listSessions(snapshot) {
  return snapshot.list('sessions').filter(e => e.name.endsWith('.meta.json'))
    .map(e => parseJson(snapshot.read(`sessions/${e.name}`), null)).filter(Boolean)
    .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
}

// Pulls the model's reply out of an engine's captured output tail. JSON engines emit one event per
// line; the others print plain text. The router's tail mixes stdout and stderr, so for plain-text
// engines the CLI's own status lines (Muse prints "muse: workspace root: ...") are dropped: they
// are not the reply, and kept they filled the recorded reply and the block with noise.
export function extractResponseText(output, engine = '') {
  const text = String(output || '');
  const pieces = [];
  let sawJson = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    sawJson = true;
    if (event.type === 'text' && event.part?.text) pieces.push(event.part.text);
    else if (event.type === 'result' && typeof event.result === 'string') pieces.push(event.result);
    else if (event.type === 'message' && event.role === 'assistant' && Array.isArray(event.content)) {
      pieces.push(event.content.filter(p => p.type === 'text').map(p => p.text).join(''));
    }
  }
  if (sawJson) return pieces.join('\n').trim();
  const prefix = engine ? `${String(engine).toLowerCase()}: ` : null;
  const lines = text.split('\n');
  return (prefix ? lines.filter(line => !line.toLowerCase().startsWith(prefix)) : lines).join('\n').trim();
}

const ENGINE_SESSION_FORMAT = {
  opencode: /^ses_[A-Za-z0-9]+$/,
  default: /^[0-9a-fA-F-]{36}$/
};

export function plausibleEngineSession(engine, id) {
  if (!id || typeof id !== 'string') return false;
  return (ENGINE_SESSION_FORMAT[engine] || ENGINE_SESSION_FORMAT.default).test(id);
}

export function engineSessionKey(engine, id) {
  return `${engine}:${id}`;
}

// Writes one turn as one commit. `outcome` comes from the router; `ctx` from resolveSession.
// Returns { seq, n, sha }.
export function recordTurnCommit(repoDir, ctx, outcome, extra = {}) {
  const { sid, project } = ctx;
  const paths = sessionPaths(sid);
  const response = sanitizeText(extractResponseText(outcome.output, outcome.engine), { maxBytes: RESPONSE_MAX_BYTES });
  const responseHead = sanitizeText(response, { maxBytes: RESPONSE_HEAD_BYTES });
  const engineSession = plausibleEngineSession(outcome.engine, outcome.engineSessionId) ? outcome.engineSessionId : null;
  const diff = extra.diff || { files: [], patch: null };
  const subject = `turn ${outcome.engine}/${outcome.model} ${outcome.ok ? 'ok' : 'fail'}`;
  const result = commitProject(repoDir, project.key, {
    subject,
    trailers: { Session: sid, Engine: outcome.engine, Kind: extra.kind || 'turn' }
  }, view => {
    const meta = parseJson(view.read(paths.meta), null) || {
      sid, project: project.key, created: new Date().toISOString(), turns: 0,
      engine_sessions: {}, models: {}, last_injected_seq: {}
    };
    const n = (meta.turns || 0) + 1;
    if (!view.read('project.json')) {
      view.write('project.json', JSON.stringify({ key: project.key, name: project.name, source: project.source,
        remote: project.remote || '', aliases: [], created: new Date().toISOString() }, null, 2));
    }
    let responseRef = null;
    if (Buffer.byteLength(response) > Buffer.byteLength(responseHead)) {
      responseRef = `${paths.turnDir}/${n}.response.md`;
      view.write(responseRef, response, { maxBytes: RESPONSE_MAX_BYTES });
    }
    let patchRef = null;
    if (typeof diff.patch === 'string' && diff.patch) {
      patchRef = `${paths.turnDir}/${n}.patch`;
      view.write(patchRef, diff.patch, { maxBytes: 600 * 1024 });
    }
    const line = sanitizeValue({
      kind: extra.kind || 'turn', n, seq: view.seq, ts: new Date().toISOString(),
      engine: outcome.engine, model: outcome.model, engine_session: engineSession, ok: Boolean(outcome.ok),
      cwd: ctx.cwd, task: sanitizeText(outcome.task, { maxBytes: TASK_MAX_BYTES }),
      response_head: responseHead, response_ref: responseRef,
      wt_before: ctx.before?.tree || null, wt_after: extra.after?.tree || null,
      files: diff.files, files_reason: diff.reason, patch_ref: patchRef, patch_truncated: Boolean(diff.patchTruncated),
      attempts: outcome.attempts || [], injected: ctx.injected || [], injected_pack: ctx.injectedPack || null,
      handoff: extra.handoffId || null
    }, { maxBytes: RESPONSE_HEAD_BYTES * 4 });
    view.appendLine(paths.log, JSON.stringify(line), { maxBytes: 64 * 1024 });

    meta.turns = n;
    meta.updated = line.ts;
    meta.cwd = ctx.cwd;
    if (ctx.alias) meta.alias = ctx.alias;
    meta.last_engine = outcome.engine;
    meta.models = meta.models || {};
    meta.engine_sessions = meta.engine_sessions || {};
    meta.last_injected_seq = meta.last_injected_seq || {};
    if (outcome.engine && outcome.model) meta.models[outcome.engine] = outcome.model;
    if (engineSession) {
      meta.engine_sessions[outcome.engine] = engineSession;
      // The engine session saw this turn itself, so everything up to this seq is known to it.
      meta.last_injected_seq[engineSessionKey(outcome.engine, engineSession)] = view.seq;
    }
    view.write(paths.meta, JSON.stringify(meta, null, 2));
    if (ctx.alias) {
      const aliases = parseJson(view.read(ALIASES_FILE), {});
      if (aliases[ctx.alias] !== sid) {
        aliases[ctx.alias] = sid;
        view.write(ALIASES_FILE, JSON.stringify(aliases, null, 2));
      }
    }
    if (typeof extra.mutate === 'function') extra.mutate(view, { n, meta });
    return { n };
  });
  return { seq: result.seq, sha: result.sha, n: result.result?.n };
}

export function projectSnapshot(repoDir, projectKey) {
  return snapshotProject(repoDir, projectKey);
}
