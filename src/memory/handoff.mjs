// Handoffs: work one engine (or the user) leaves for another.
//
//   handoffs/<hid>.md   front matter: state open|accepted|expired, to, from_session, from_engine,
//                       reason, seq, created, accepted_by, accepted_at; body: the task and errors.
//
// Automatic handoffs are written in the same commit as the turn that handed over (Gemini or all
// engines failed). `memory handoff begin` writes one on request. Both share one state machine, and
// taking a handoff is a commit made under the ref lock that only succeeds while it is still open,
// so exactly one taker wins.

import crypto from 'node:crypto';
import { commitProject, parseFrontMatter, formatFrontMatter, snapshotProject } from './store.mjs';
import { registerL0Source, clip, shortHash } from './pack.mjs';

export const HANDOFF_STATES = ['open', 'accepted', 'expired'];
const HID_RE = /^h[0-9a-z]{8,12}-[0-9a-f]{6}$/;

export function newHandoffId(now = Date.now()) {
  return `h${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export function isValidHandoffId(hid) {
  return typeof hid === 'string' && HID_RE.test(hid);
}

export function handoffPath(hid) {
  if (!isValidHandoffId(hid)) throw new Error(`invalid handoff id: ${hid}`);
  return `handoffs/${hid}.md`;
}

export function parseHandoff(id, text) {
  const { meta, body } = parseFrontMatter(text);
  return { id, ...meta, seq: Number(meta.seq || 0), task: body.trim() };
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

// Writes a new open handoff inside an existing commit (view from commitProject).
export function writeHandoff(view, { hid = newHandoffId(), to = 'any', fromSession = '', fromEngine = '', reason = '', task = '', errors = [] }) {
  const meta = { state: 'open', to, from_session: fromSession, from_engine: fromEngine, reason, seq: view.seq, created: new Date().toISOString() };
  const body = [task, errors.length ? `\nErrors:\n${errors.map(e => `- ${e}`).join('\n')}` : ''].join('\n');
  view.write(handoffPath(hid), formatFrontMatter(meta, body), { maxBytes: 32768 });
  return hid;
}

// Moves an open handoff to `accepted` inside an existing commit. Returns false if it is not open.
export function acceptInView(view, hid, by) {
  const file = handoffPath(hid);
  const text = view.read(file);
  if (!text) return false;
  const { meta, body } = parseFrontMatter(text);
  if (meta.state !== 'open') return false;
  view.write(file, formatFrontMatter({ ...meta, state: 'accepted', accepted_by: by, accepted_at: new Date().toISOString() }, body), { maxBytes: 32768 });
  return true;
}

export function beginHandoff(repoDir, projectKey, options) {
  let hid = null;
  commitProject(repoDir, projectKey, { subject: `handoff to ${options.to || 'any'}`, trailers: { Session: options.fromSession, Kind: 'handoff' } }, view => {
    hid = writeHandoff(view, options);
  });
  return hid;
}

// The single-claim operation. Returns { ok, state } — ok is true for exactly one caller.
export function claimHandoff(repoDir, projectKey, hid, by) {
  handoffPath(hid);
  let state = 'missing';
  const result = commitProject(repoDir, projectKey, { subject: `accept handoff ${hid}`, trailers: { Session: by, Kind: 'handoff-accept' } }, view => {
    const text = view.read(handoffPath(hid));
    if (!text) return false;
    state = parseFrontMatter(text).meta.state;
    if (!acceptInView(view, hid, by)) return false;
    state = 'accepted';
    return true;
  });
  return { ok: result.result === true, state: result.result === true ? 'accepted' : state };
}

export function openHandoffSummaries(repoDir, projectKey) {
  return listOpenHandoffs(snapshotProject(repoDir, projectKey));
}

// Open handoffs addressed to this engine (or to anyone) join L0 of the pack.
registerL0Source(({ snapshot, knownSeq, engine }) =>
  listOpenHandoffs(snapshot, { forEngine: engine }).filter(h => h.seq > knownSeq).map(h => ({
    line: `- open handoff ${h.id} from ${h.from_engine || 'user'} (${h.reason || 'handoff'}): ${clip(h.task, 240)}`,
    source: { kind: 'handoff', id: h.id, seq: h.seq, hash: shortHash(h.task) }
  })));
