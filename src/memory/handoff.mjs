// Handoffs: work one engine (or the user) leaves for another. A handoff is also the unit of the
// supervised-orchestration layer: a coordinator run (parent_run) fans a task out into subtasks
// (task_id), declares which handoffs each one waits for (depends_on) and can gate a handoff behind
// an approval. Plain handoffs use none of this and behave exactly as before.
//
//   handoffs/<hid>.md   front matter: state open|accepted|expired, to, from_session, from_engine,
//                       reason, seq, created, accepted_by, accepted_at; optional orchestration
//                       fields parent_run, task_id, depends_on (space/comma separated hids),
//                       approval (pending|approved|rejected); body: the task and errors.
//
// Automatic handoffs are written in the same commit as the turn that handed over (Gemini or all
// engines failed). `memory handoff begin` writes one on request. Both share one state machine, and
// taking a handoff is a commit made under the ref lock that only succeeds while it is still open,
// so exactly one taker wins.

import crypto from 'node:crypto';
import { commitProject, parseFrontMatter, formatFrontMatter, snapshotProject } from './store.mjs';
import { registerL0Source, clip, shortHash } from './pack.mjs';

export const HANDOFF_STATES = ['open', 'accepted', 'completed', 'expired'];
export const APPROVAL_STATES = ['pending', 'approved', 'rejected'];
const HID_RE = /^h[0-9a-z]{8,12}-[0-9a-f]{6}$/;

// Coordinator runs and subtask ids may be invented by any engine, so they are validated by one
// shared shape rule instead of the store's own handoff id format: printable, no whitespace, no
// path separators, bounded length.
const ID_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function newHandoffId(now = Date.now()) {
  return `h${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export function newRunId(now = Date.now()) {
  return `r${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export function isValidHandoffId(hid) {
  return typeof hid === 'string' && HID_RE.test(hid);
}

export function isValidRunId(run) {
  return typeof run === 'string' && ID_PART_RE.test(run);
}

export function isValidTaskId(taskId) {
  return typeof taskId === 'string' && ID_PART_RE.test(taskId);
}

export function handoffPath(hid) {
  if (!isValidHandoffId(hid)) throw new Error(`invalid handoff id: ${hid}`);
  return `handoffs/${hid}.md`;
}

// `depends_on` is stored as one front-matter line; engines may write comma or space separated ids.
export function parseDependencyList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(/[,\s;]+/).map(v => v.trim()).filter(Boolean);
}

function parseApproval(value) {
  return APPROVAL_STATES.includes(value) ? value : '';
}

// Front matter is flat single-line key/values, so orchestration fields are normalised here for
// every reader. Handoffs written before the orchestration layer have none of these fields.
export function parseHandoff(id, text) {
  const { meta, body } = parseFrontMatter(text);
  return {
    id, ...meta, seq: Number(meta.seq || 0), task: body.trim(),
    parent_run: isValidRunId(meta.parent_run) ? meta.parent_run : '',
    task_id: isValidTaskId(meta.task_id) ? meta.task_id : '',
    depends_on: parseDependencyList(meta.depends_on),
    approval: parseApproval(meta.approval),
  };
}

export function listHandoffs(snapshot) {
  return snapshot.list('handoffs').filter(e => e.name.endsWith('.md'))
    .map(e => parseHandoff(e.name.slice(0, -3), snapshot.read(`handoffs/${e.name}`) || ''))
    .sort((a, b) => b.seq - a.seq);
}

export function listOpenHandoffs(snapshot, { forEngine = '' } = {}) {
  return listHandoffs(snapshot).filter(h => h.state === 'open' &&
    (!forEngine || h.to === 'any' || h.to === forEngine));
}

export function listRunHandoffs(snapshot, runId) {
  if (!isValidRunId(runId)) return [];
  return listHandoffs(snapshot).filter(h => h.parent_run === runId).sort((a, b) => a.seq - b.seq);
}

// Dependencies of `handoff` that are not met yet, as { id, reason }. A dependency is met once it is
// accepted or completed; missing or expired ones block for good. A handoff that depends on itself is
// found open, so it stays blocked forever.
export function unmetDependenciesInReader(reader, handoff) {
  const unmet = [];
  for (const id of handoff?.depends_on || []) {
    let text = null;
    try {
      text = reader.read(handoffPath(id));
    } catch {
      text = null;
    }
    if (!text) {
      unmet.push({ id, reason: `${id}: not found` });
    } else {
      const dep = parseHandoff(id, text);
      if (dep.state !== 'accepted' && dep.state !== 'completed') {
        unmet.push({ id, reason: `${id}: ${dep.state}` });
      }
    }
  }
  return unmet;
}

// Resolves a handoff's DAG position: its dependencies must exist and have been accepted or completed,
// and a gated handoff must be approved. Missing or expired dependencies block for good, so a coordinator
// can see exactly which subtask is stuck on what.
export function dependencyReport(snapshot, handoff) {
  const unmet = unmetDependenciesInReader(snapshot, handoff);
  const unmetIds = new Set(unmet.map(u => u.id));
  const reasons = unmet.map(u => u.reason);
  if (handoff?.approval === 'pending') reasons.push(`${handoff.id}: awaiting approval`);
  else if (handoff?.approval === 'rejected') reasons.push(`${handoff.id}: rejected`);
  return { blocked: reasons.length > 0, satisfied: (handoff?.depends_on || []).filter(id => !unmetIds.has(id)), reasons };
}

// Per-run overview for a coordinator: what finished, what is ready to hand out, what is stuck.
// Readiness uses the same rule as claimHandoff, judged against the whole snapshot.
export function runSummary(snapshot, runId) {
  const all = listHandoffs(snapshot);
  const subtasks = isValidRunId(runId) ? all.filter(h => h.parent_run === runId).sort((a, b) => a.seq - b.seq) : [];
  const counts = { open: 0, accepted: 0, completed: 0, expired: 0 };
  const ready = [];
  const blocked = [];
  for (const h of subtasks) {
    counts[h.state] = (counts[h.state] || 0) + 1;
    if (h.state !== 'open') continue;
    if (h.approval === 'pending' || h.approval === 'rejected') { blocked.push(h); continue; }
    if (dependencyReport(snapshot, { ...h, approval: '' }).blocked) blocked.push(h); else ready.push(h);
  }
  return { run: runId, counts, ready, blocked, subtasks };
}

// Writes a new open handoff inside an existing commit (view from commitProject). The orchestration
// fields are optional; a plain handoff passes none of them and stores nothing extra.
export function writeHandoff(view, { hid = newHandoffId(), to = 'any', fromSession = '', fromEngine = '', reason = '',
  task = '', errors = [], parentRun = '', taskId = '', dependsOn = [], approval = '' } = {}) {
  if (parentRun && !isValidRunId(parentRun)) throw new Error(`invalid parent run id: ${parentRun}`);
  if (taskId && !isValidTaskId(taskId)) throw new Error(`invalid task id: ${taskId}`);
  if (approval && !APPROVAL_STATES.includes(approval)) throw new Error(`invalid approval state: ${approval}`);
  const deps = parseDependencyList(dependsOn);
  for (const id of deps) if (!isValidHandoffId(id)) throw new Error(`invalid dependency handoff id: ${id}`);
  if (deps.includes(hid)) throw new Error(`handoff ${hid} cannot depend on itself`);
  const meta = { state: 'open', to, from_session: fromSession, from_engine: fromEngine, reason, seq: view.seq,
    created: new Date().toISOString() };
  if (parentRun) meta.parent_run = parentRun;
  if (taskId) meta.task_id = taskId;
  if (deps.length) meta.depends_on = deps.join(',');
  if (approval) meta.approval = approval;
  const body = [task, errors.length ? `\nErrors:\n${errors.map(e => `- ${e}`).join('\n')}` : ''].join('\n');
  view.write(handoffPath(hid), formatFrontMatter(meta, body), { maxBytes: 32768 });
  return hid;
}

// Moves an open handoff to `accepted` inside an existing commit. Returns false if it is not open,
// if its gate is undecided (`pending` or `rejected`), or if any of its dependencies are not yet
// accepted or completed.
export function acceptInView(view, hid, by) {
  const file = handoffPath(hid);
  const text = view.read(file);
  if (!text) return false;
  const handoff = parseHandoff(hid, text);
  if (handoff.state !== 'open') return false;
  const gate = parseApproval(handoff.approval);
  if (gate === 'pending' || gate === 'rejected') return false;
  if (handoff.depends_on && handoff.depends_on.length > 0) {
    const unmet = unmetDependenciesInReader(view, handoff);
    if (unmet.length > 0) return false;
  }
  const { meta, body } = parseFrontMatter(text);
  view.write(file, formatFrontMatter({ ...meta, state: 'accepted', accepted_by: by, accepted_at: new Date().toISOString(), accepted_seq: view.seq }, body), { maxBytes: 32768 });
  return true;
}

// Allowed gate moves. `pending` re-opens a decided gate for re-review; a rejection is only undone
// by re-opening it first, so approving a rejected handoff takes two deliberate steps.
const APPROVAL_TRANSITIONS = {
  '': ['pending', 'approved', 'rejected'],
  pending: ['pending', 'approved', 'rejected'],
  approved: ['approved', 'pending', 'rejected'],
  rejected: ['rejected', 'pending']
};

// Sets a handoff's approval gate inside an existing commit. Returns { ok, state, reason }: `state` is
// the handoff's state (or `missing`) and `reason` says why nothing changed.
export function setApprovalInView(view, hid, status, { by = '', note = '' } = {}) {
  const file = handoffPath(hid);
  if (!APPROVAL_STATES.includes(status)) throw new Error(`invalid approval state: ${status}`);
  const text = view.read(file);
  if (!text) return { ok: false, state: 'missing', reason: 'handoff not found' };
  const { meta, body } = parseFrontMatter(text);
  if (meta.state !== 'open') return { ok: false, state: meta.state, reason: `handoff is ${meta.state}, not open` };
  const current = parseApproval(meta.approval);
  if (!APPROVAL_TRANSITIONS[current].includes(status)) {
    return { ok: false, state: meta.state, reason: `cannot move the gate from ${current} to ${status}; set it to pending first` };
  }
  // A decision carries only its own note and author, never the previous decision's.
  const next = { ...meta, approval: status, approval_at: new Date().toISOString(), approval_seq: view.seq };
  if (by) next.approval_by = by; else delete next.approval_by;
  if (note) next.approval_note = note; else delete next.approval_note;
  view.write(file, formatFrontMatter(next, body), { maxBytes: 32768 });
  return { ok: true, state: meta.state, reason: '' };
}

export function beginHandoff(repoDir, projectKey, options) {
  let hid = null;
  commitProject(repoDir, projectKey, { subject: `handoff to ${options.to || 'any'}`, trailers: { Session: options.fromSession, Kind: 'handoff' } }, view => {
    hid = writeHandoff(view, options);
  });
  return hid;
}

// The single-claim operation. Returns { ok, state } — ok is true for exactly one caller. A claim
// refused only by its gate reports state `gated`; a claim refused because dependencies are not
// yet accepted or completed reports state `blocked` with reasons.
export function claimHandoff(repoDir, projectKey, hid, by) {
  handoffPath(hid);
  let state = 'missing';
  let blockedReasons = [];
  const result = commitProject(repoDir, projectKey, { subject: `accept handoff ${hid}`, trailers: { Session: by, Kind: 'handoff-accept' } }, view => {
    const text = view.read(handoffPath(hid));
    if (!text) return false;
    const handoff = parseHandoff(hid, text);
    state = handoff.state;
    if (handoff.state !== 'open') return false;
    if (handoff.approval === 'pending' || handoff.approval === 'rejected') {
      state = 'gated';
      return false;
    }
    if (handoff.depends_on && handoff.depends_on.length > 0) {
      blockedReasons.push(...unmetDependenciesInReader(view, handoff).map(u => u.reason));
      if (blockedReasons.length > 0) {
        state = 'blocked';
        return false;
      }
    }
    if (!acceptInView(view, hid, by)) return false;
    state = 'accepted';
    return true;
  });
  return {
    ok: result.result === true,
    state: result.result === true ? 'accepted' : state,
    ...(blockedReasons.length > 0 ? { reasons: blockedReasons } : {})
  };
}

// Marks an accepted handoff as completed.
export function completeHandoff(repoDir, projectKey, hid, { by = 'user' } = {}) {
  handoffPath(hid);
  let state = 'missing';
  const result = commitProject(repoDir, projectKey, { subject: `complete handoff ${hid}`, trailers: { Session: by, Kind: 'handoff-complete' } }, view => {
    const file = handoffPath(hid);
    const text = view.read(file);
    if (!text) return false;
    const { meta, body } = parseFrontMatter(text);
    state = meta.state;
    if (meta.state !== 'accepted') return false;
    view.write(file, formatFrontMatter({ ...meta, state: 'completed', completed_by: by, completed_at: new Date().toISOString(), completed_seq: view.seq }, body), { maxBytes: 32768 });
    state = 'completed';
    return true;
  });
  return { ok: result.result === true, state: result.result === true ? 'completed' : state };
}

// Commits a gate decision for an open handoff. Returns { ok, state, reason }: on success `state` is
// the new approval; otherwise it is the handoff's state (`missing`, `accepted`, ...) and `reason`
// says why the gate did not move.
export function approveHandoff(repoDir, projectKey, hid, { by = 'user', status = 'approved', note = '' } = {}) {
  handoffPath(hid);
  if (!APPROVAL_STATES.includes(status)) throw new Error(`invalid approval state: ${status}`);
  let outcome = { ok: false, state: 'missing', reason: 'handoff not found' };
  commitProject(repoDir, projectKey,
    { subject: `${status} handoff ${hid}`, trailers: { Session: by, Kind: 'handoff-approval' } },
    view => {
      outcome = setApprovalInView(view, hid, status, { by, note });
      return outcome.ok;
    });
  return outcome.ok ? { ok: true, state: status, reason: '' } : outcome;
}

export function openHandoffSummaries(repoDir, projectKey) {
  return listOpenHandoffs(snapshotProject(repoDir, projectKey));
}

// Open handoffs addressed to this engine (or to anyone) join L0 of the pack. Gated ones stay
// visible but marked, so the next model sees the work without being pushed to claim it early.
// `unmet` is the dependency ids still outstanding (all of them when omitted).
export function gateNotice(handoff, unmet = handoff.depends_on) {
  if (handoff.approval === 'pending') return ', awaiting approval';
  if (handoff.approval === 'rejected') return ', rejected at the gate';
  if (unmet?.length) return `, waits for ${unmet.join(', ')}`;
  if (handoff.approval === 'approved') return ', approved';
  return '';
}

// The latest seq at which something changed for an open handoff: its creation, its gate decision, or
// a dependency being accepted or completed. A session that saw the handoff before that point is
// shown it again with its new status.
function changeSeq(handoff, byId) {
  let seq = Math.max(handoff.seq, Number(handoff.approval_seq || 0));
  for (const id of handoff.depends_on) {
    const dep = byId.get(id);
    if (dep && (dep.state === 'accepted' || dep.state === 'completed')) {
      seq = Math.max(seq, Number(dep.accepted_seq || 0), Number(dep.completed_seq || 0));
    }
  }
  return seq;
}

export function handoffL0Items({ snapshot, knownSeq = 0, engine = '' }) {
  const all = listHandoffs(snapshot);
  const byId = new Map(all.map(h => [h.id, h]));
  return all.filter(h => h.state === 'open' && (h.to === 'any' || h.to === engine))
    .map(h => ({ h, seq: changeSeq(h, byId) }))
    .filter(x => x.seq > knownSeq)
    .map(({ h, seq }) => ({
      line: `- open handoff ${h.id} from ${h.from_engine || 'user'} (${h.reason || 'handoff'}${gateNotice(h, unmetDependenciesInReader(snapshot, h).map(u => u.id))}): ${clip(h.task, 240)}`,
      source: { kind: 'handoff', id: h.id, seq, hash: shortHash(h.task) }
    }));
}

registerL0Source(handoffL0Items);
