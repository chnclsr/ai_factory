// `node router.mjs memory <command>`: inspection and maintenance commands for the memory store.
//
//   memory session show [<alias|sid>]          turns, engines and changed files of a session
//   memory turn diff <n> [--session <s>]        the patch recorded for turn n
//   memory turn revert <n> [--session <s>] [--yes]
//                                               reverse turn n's patch in the working tree

import fs from 'node:fs';
import { resolveProject, findGitRepo } from './project.mjs';
import { snapshotProject, commitProject } from './store.mjs';
import { findSession, listSessions, readTurns, readMeta, sessionPaths } from './session.mjs';
import { revertPatch } from './worktree.mjs';
import { sanitizeValue } from './sanitize.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y' || arg === '--global') flags[arg.replace(/^-+/, '')] = true;
    else if (arg.startsWith('--')) flags[arg.slice(2)] = argv[++i] ?? '';
    else positional.push(arg);
  }
  return { positional, flags };
}

function askYesNo(question, io) {
  if (!io.isTTY) return false;
  io.out(question + ' [y/N] ');
  const buffer = Buffer.alloc(16);
  let answer = '';
  try { answer = buffer.subarray(0, fs.readSync(0, buffer, 0, 16, null)).toString('utf8'); } catch {}
  return /^y(es)?\s*$/i.test(answer.trim());
}

function describeFiles(files) {
  if (!Array.isArray(files)) return `  (file changes ${files || 'not recorded'})`;
  if (!files.length) return '  (no file changes)';
  return files.map(f => `  ${f.status} ${f.path}${f.binary ? ' (binary)' : f.add != null ? ` +${f.add} -${f.del}` : ''}`).join('\n');
}

function pickSession(snapshot, wanted) {
  if (wanted) return findSession(snapshot, wanted);
  return listSessions(snapshot)[0]?.sid || null;
}

export async function runMemoryCli(argv, { repoDir, cwd = process.cwd(), io: ioOverride } = {}) {
  const io = ioOverride || { out: s => process.stdout.write(s), err: s => process.stderr.write(s), isTTY: Boolean(process.stdin.isTTY) };
  const { positional, flags } = parseArgs(argv);
  const [group, action, arg] = positional;
  const workdir = flags.cwd || cwd;
  const project = resolveProject({ project: flags.project, cwd: workdir });
  const snapshot = snapshotProject(repoDir, project.key);

  if (group === 'session' && action === 'show') {
    const sid = pickSession(snapshot, arg || flags.session);
    if (!sid) { io.err(`No session found in project ${project.key}.\n`); return 1; }
    const meta = readMeta(snapshot, sid) || {};
    io.out(`session ${sid}${meta.alias ? ` (${meta.alias})` : ''} in project ${project.key}\n`);
    for (const [engine, id] of Object.entries(meta.engine_sessions || {})) io.out(`  engine session ${engine}: ${id}\n`);
    for (const turn of readTurns(snapshot, sid)) {
      if (turn.kind !== 'turn') { io.out(`- ${turn.kind} ${turn.ts}${turn.of ? ` of turn ${turn.of}` : ''}\n`); continue; }
      io.out(`- turn ${turn.n} seq ${turn.seq} ${turn.engine}/${turn.model} ${turn.ok ? 'ok' : 'fail'}: ${String(turn.task).slice(0, 100)}\n`);
      io.out(describeFiles(turn.files) + '\n');
    }
    return 0;
  }

  if (group === 'turn' && (action === 'diff' || action === 'revert')) {
    const n = Number(arg);
    const sid = pickSession(snapshot, flags.session);
    if (!Number.isInteger(n) || n < 1 || !sid) { io.err('Usage: memory turn diff|revert <n> [--session <alias|sid>] [--cwd <dir>]\n'); return 1; }
    const turn = readTurns(snapshot, sid).find(t => t.kind === 'turn' && t.n === n);
    if (!turn) { io.err(`Turn ${n} not found in session ${sid}.\n`); return 1; }
    const patch = turn.patch_ref ? snapshot.read(turn.patch_ref) : null;
    if (action === 'diff') {
      if (!patch) { io.out(describeFiles(turn.files) + '\n(no patch recorded for this turn)\n'); return 0; }
      io.out(patch);
      return 0;
    }
    if (!patch) { io.err(`Turn ${n} has no recorded patch, so it cannot be reverted.\n`); return 1; }
    if (turn.patch_truncated) { io.err(`Turn ${n}'s patch was truncated at record time; refusing a partial revert.\n`); return 1; }
    const repo = findGitRepo(turn.cwd || workdir);
    if (!repo) { io.err(`No git repository at ${turn.cwd}.\n`); return 1; }
    io.out(`Turn ${n} (${turn.engine}/${turn.model}) changed:\n${describeFiles(turn.files)}\n`);
    if (Array.isArray(turn.files) && turn.files.some(f => f.binary)) io.out('Binary changes are listed but cannot be reverted from the stored patch.\n');
    const check = revertPatch(repo.worktree, patch, { check: true });
    if (!check.ok) { io.err(`The patch no longer applies in reverse: ${check.reason}\n`); return 1; }
    if (!flags.yes && !askYesNo(`Reverse these changes in ${repo.worktree}?`, io)) {
      io.err('Not reverted. Re-run with --yes to confirm.\n');
      return 2;
    }
    const done = revertPatch(repo.worktree, patch);
    if (!done.ok) { io.err(`Revert failed: ${done.reason}\n`); return 1; }
    commitProject(repoDir, project.key, { subject: `revert turn ${n}`, trailers: { Session: sid, Kind: 'revert' } }, view => {
      view.appendLine(sessionPaths(sid).log, JSON.stringify(sanitizeValue({ kind: 'revert', of: n, ts: new Date().toISOString(), mode: done.mode })));
    });
    io.out(`Reverted turn ${n} (${done.mode}).\n`);
    return 0;
  }

  io.err('Usage: node router.mjs memory session show [<alias|sid>] | turn diff <n> | turn revert <n> [--yes]\n');
  return 1;
}
