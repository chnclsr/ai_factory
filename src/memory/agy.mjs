// Records Antigravity's own turns into memory (the router never sees them otherwise).
//
// The plugin's Stop hook starts `memory record-agy` as a detached process when an Antigravity turn
// ends normally. This reads the conversation transcript Antigravity keeps (JSONL, one step per
// line), takes the last user request and the agent's final answer, and records them as one turn of
// the conversation's session (the same session id the router uses: Antigravity's conversationId),
// with engine "antigravity". Turns that ran the router are skipped, because the router already
// recorded the engine's full reply. Thinking steps and tool output are never recorded.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProject } from './project.mjs';
import { followMoves } from './projects.mjs';
import { snapshotProject } from './store.mjs';
import { recordTurnCommit, readTurns, isValidSid } from './session.mjs';

export function parseTranscript(text) {
  const steps = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { steps.push(JSON.parse(line)); } catch {}
  }
  return steps;
}

// The user's words without Antigravity's wrapper (<USER_REQUEST>, <ADDITIONAL_METADATA>, settings notes).
export function cleanRequest(content) {
  const text = String(content || '');
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (match ? match[1] : text.replace(/<([A-Z_]+)>[\s\S]*?<\/\1>/g, '')).trim();
}

const callText = call => JSON.stringify(call?.args || {});
// A router call is any shell command that runs router.mjs for a task; `router.mjs memory ...`
// (reading memory) is not a delegation.
export function isRouterCall(call) {
  if (!call || !/command/i.test(call.name || '')) return false;
  const text = callText(call);
  // The hook's command carries `--session <id>` before the subcommand, so a memory read looks like
  // `router.mjs" --session 5b48… memory search …`; that is still a read, not a delegation.
  return /router\.mjs/i.test(text) && !/router\.mjs\\?"?\s+(?:--session\s+\S+\s+)?memory\b/i.test(text);
}

// The last finished exchange: the last user request, the agent's final answer after it (a model
// step with text and no tool calls) and whether the router ran in between.
export function lastExchange(steps) {
  let userIndex = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].type === 'USER_INPUT') { userIndex = i; break; }
  }
  if (userIndex < 0) return null;
  const after = steps.slice(userIndex + 1);
  const finals = after.filter(s => s.source === 'MODEL' && s.type === 'PLANNER_RESPONSE' && s.content && !(s.tool_calls || []).length);
  const answer = finals.at(-1);
  if (!answer) return null;
  const routed = after.some(s => (s.tool_calls || []).some(isRouterCall));
  return {
    step: Number(steps[userIndex].step_index ?? userIndex),
    request: cleanRequest(steps[userIndex].content),
    answer: String(answer.content),
    routed,
    truncated: Boolean(answer.truncated_fields && String(answer.truncated_fields).includes('content'))
  };
}

// The full transcript sits next to the regular one when Antigravity truncated long fields.
function readTranscript(transcriptPath) {
  const full = path.join(path.dirname(transcriptPath), 'transcript_full.jsonl');
  for (const file of [full, transcriptPath]) {
    try { return fs.readFileSync(file, 'utf8'); } catch {}
  }
  return null;
}

export function recordAgyTurn({ repoDir, transcriptPath, sid, cwd, model = 'gemini' }) {
  if (!transcriptPath || !isValidSid(sid)) return { status: 'invalid_input' };
  const text = readTranscript(transcriptPath);
  if (text === null) return { status: 'no_transcript' };
  const exchange = lastExchange(parseTranscript(text));
  if (!exchange) return { status: 'no_exchange' };
  if (exchange.routed) return { status: 'routed' };
  if (!exchange.request) return { status: 'no_request' };
  const project = followMoves(repoDir, resolveProject({ cwd }));
  const already = readTurns(snapshotProject(repoDir, project.key), sid)
    .some(t => t.kind === 'turn' && t.engine === 'antigravity' && t.agy_step === exchange.step);
  if (already) return { status: 'duplicate' };
  const ctx = { sid, project, cwd, alias: '', injected: [], before: null };
  const result = recordTurnCommit(repoDir, ctx, {
    task: exchange.request, engine: 'antigravity', model: String(model || 'gemini').slice(0, 80), ok: true,
    output: exchange.answer, attempts: []
  }, { diff: { files: [], patch: null }, fields: { agy_step: exchange.step, source: 'antigravity-transcript' } });
  return { status: 'recorded', n: result.n, step: exchange.step };
}
