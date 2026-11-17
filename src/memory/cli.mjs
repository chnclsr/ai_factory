// `node router.mjs memory <command>`: inspection and maintenance commands for the memory store.
//
//   memory session show [<alias|sid>]          turns, engines and changed files of a session
//   memory record-agy --transcript <file> --session <id> [--model <m>]
//                                               record Antigravity's last turn (Stop hook)
//   memory state show|update [--session <s>] [--force]
//                                               the model-written session state (phase 3)
//   memory turn show <n> [--session <s>]        the full recorded request and reply of turn n
//   memory turn diff <n> [--session <s>]        the patch recorded for turn n
//   memory turn revert <n> [--session <s>] [--yes]
//                                               reverse turn n's patch in the working tree
//   memory session adopt <alias>                move a migrated _unscoped session into this project
//   memory handoff begin --to <engine|any> [--task <text>] [--session <s>]
//   memory handoff list [--all]
//   memory handoff accept <hid>                 take an open handoff (exactly one taker wins)
//   memory handoff approve|reject <hid> [--note <text>]
//   memory handoff complete <hid>
//   memory handoff summary [--run <run_id>]
//   memory worktree list [--cwd <dir>]          real git worktrees in this repository
//   memory worktree create <name> [--base <ref>] [--branch <ref>]
//   memory worktree remove <name> [--force] [--keep-branch]
//   memory worktree prune                       prune stale worktree metadata
//   memory note add <text> [--scope repo|mine]  store a note page (mine = personal ref)
//   memory project list                         projects with their head Seq, sessions and aliases
//   memory project rename <old> <new> [--yes]   the old key keeps resolving to the new one
//   memory project merge <source> <target> [--yes]
//                                               lossless merge; source then resolves to target
//   memory search <query> [--scope repo|dir|mine] [--global]
//                                               --global: every project, never the personal ref

import fs from 'node:fs';
import { resolveProject, findGitRepo, UNSCOPED_PROJECT } from './project.mjs';
import { snapshotProject, commitProject, writePage } from './store.mjs';
import { findSession, listSessions, readTurns, readMeta, sessionPaths, ALIASES_FILE } from './session.mjs';
import { searchWithInfo, SCOPES } from './search.mjs';
import { vectorSettings } from './vector.mjs';
import { beginHandoff, claimHandoff, completeHandoff, approveHandoff, listHandoffs, runSummary, isValidHandoffId, isValidRunId } from './handoff.mjs';
import { revertPatch, listWorktrees, createWorktree, removeWorktree, pruneWorktrees } from './worktree.mjs';
import { followMoves, describeProjects, renameProject, mergeProjects } from './projects.mjs';
import { sanitizeValue, neutralizeForInjection } from './sanitize.mjs';
import { readState, renderState, updateState } from './state.mjs';
import { recordAgyTurn } from './agy.mjs';
import path from 'node:path';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y' || arg === '--global' || arg === '--all' || arg === '--force' || arg === '--keep-branch') {
      flags[arg.replace(/^-+/, '')] = true;
    } else if (arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[arg.slice(2)] = next;
        i++;
      } else {
        flags[arg.slice(2)] = '';
      }
    } else {
      positional.push(arg);
    }
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

function readMemoryConfig(configFile) {
  if (!configFile) return {};
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8'))?.memory || {}; } catch { return {}; }
}

export async function runMemoryCli(argv, { repoDir, indexFile = null, configFile = null, cwd = process.cwd(), io: ioOverride, routerScript = null } = {}) {
  const io = ioOverride || { out: s => process.stdout.write(s), err: s => process.stderr.write(s), isTTY: Boolean(process.stdin.isTTY) };
  const { positional, flags } = parseArgs(argv);
  const [group, action, arg] = positional;
  const workdir = flags.cwd || cwd;
  const project = followMoves(repoDir, resolveProject({ project: flags.project, cwd: workdir }));
  const snapshot = snapshotProject(repoDir, project.key);

  if (group === 'project') {
    if (action === 'list') {
      const projects = describeProjects(repoDir);
      for (const p of projects) {
        io.out(p.movedTo ? `${p.key} -> ${p.movedTo}\n` : `${p.key} seq ${p.seq}, ${p.sessions} session(s)${p.aliases.length ? `, aliases: ${p.aliases.join(', ')}` : ''}${p.key === project.key ? '  (current)' : ''}\n`);
      }
      if (!projects.length) io.out('(no projects)\n');
      return 0;
    }
    if (action === 'rename' || action === 'merge') {
      const [first, second] = positional.slice(2);
      if (!first || !second) { io.err(`Usage: memory project ${action} <${action === 'rename' ? 'old> <new' : 'source> <target'}>\n`); return 1; }
      const question = action === 'rename'
        ? `Rename project ${first} to ${second}? The old key will keep resolving to the new one.`
        : `Merge project ${first} into ${second}? Afterwards ${first} resolves to ${second}.`;
      if (!flags.yes && !askYesNo(question, io)) { io.err(`Not changed. Re-run with --yes to confirm.\n`); return 2; }
      try {
        if (action === 'rename') {
          renameProject(repoDir, first, second);
          io.out(`Renamed ${first} to ${second}.\n`);
        } else {
          const report = mergeProjects(repoDir, first, second);
          io.out(`Merged ${first} into ${second}: ${report.added} file(s) added, ${report.conflicts.length} kept side by side.\n`);
          for (const c of report.conflicts) io.out(`  ${c.path}: ${second}'s copy kept, ${first}'s copy at ${c.sourceCopy}\n`);
          for (const [alias, renamed] of Object.entries(report.aliasRenames)) io.out(`  alias ${alias} from ${first} is now ${renamed}\n`);
        }
      } catch (err) { io.err(`${err.message}\n`); return 1; }
      return 0;
    }
  }

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

  // The pull path: the full recorded reply of one turn, read straight from git objects (no index),
  // so it works while the index is locked. Engines run it when the block shortened a turn.
  // Session state (phase 3): `state show` prints it, `state update` asks the summariser engine for a
  // new one. The router starts `state update` as a detached process after a turn when one is due.
  // Antigravity's own turn, from its transcript (started by the plugin's Stop hook).
  if (group === 'record-agy') {
    const result = recordAgyTurn({ repoDir, transcriptPath: flags.transcript, sid: flags.session, cwd: workdir, model: flags.model });
    // The Stop hook runs this detached with no console, so each run leaves one line to check later.
    try {
      fs.appendFileSync(path.join(path.dirname(repoDir), 'agy-record.log'),
        `${new Date().toISOString()} ${String(flags.session || '-').slice(0, 40)} ${project.key} ${result.status}${result.n ? ` turn ${result.n}` : ''}\n`);
    } catch {}
    io.out(`record-agy: ${result.status}${result.n ? ` (turn ${result.n})` : ''}\n`);
    return ['recorded', 'duplicate', 'routed', 'no_exchange'].includes(result.status) ? 0 : 1;
  }

  if (group === 'state' && (action === 'show' || action === 'update')) {
    const sid = pickSession(snapshot, flags.session || arg);
    if (!sid) { io.err(`No session found in project ${project.key}.\n`); return 1; }
    if (action === 'show') {
      const state = readState(snapshot, sid);
      if (!state) { io.out('(no state yet)\n'); return 0; }
      io.out(`state of ${sid} through turn ${state.through_turn} (${state.engine}${state.model ? '/' + state.model : ''}, ${state.updated})\n`);
      io.out(renderState(state, 100000).join('\n') + '\n');
      return 0;
    }
    const memoryConfig = readMemoryConfig(configFile);
    const number = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
    const result = updateState({
      repoDir, projectKey: project.key, sid, cwd: workdir, routerScript: routerScript || path.resolve(import.meta.dirname, '..', '..', 'router.mjs'),
      engine: flags.engine || memoryConfig.state_engine || 'vibe/vibe-glm-5.3-flash', dataDir: path.dirname(repoDir), force: Boolean(flags.force),
      minTurns: number(memoryConfig.state_min_turns, 8), everyTurns: number(memoryConfig.state_every_turns, 6)
    });
    io.out(`state update: ${result.status}${result.items !== undefined ? `, ${result.items} item(s) through turn ${result.through}` : ''}${result.error ? ` (${result.error})` : ''}\n`);
    return ['written', 'superseded', 'not_due', 'disabled', 'busy', 'no_turns'].includes(result.status) ? 0 : 1;
  }

  if (group === 'turn' && action === 'show') {
    const n = Number(arg);
    const sid = pickSession(snapshot, flags.session);
    if (!Number.isInteger(n) || n < 1 || !sid) { io.err('Usage: memory turn show <n> [--session <alias|sid>] [--cwd <dir>] [--max-bytes <n>]\n'); return 1; }
    const turn = readTurns(snapshot, sid).find(t => t.kind === 'turn' && t.n === n);
    if (!turn) { io.err(`Turn ${n} not found in session ${sid}.\n`); return 1; }
    let reply = (turn.response_ref && snapshot.read(turn.response_ref)) || turn.response_head || '';
    const maxBytes = Number(flags['max-bytes']);
    if (Number.isFinite(maxBytes) && maxBytes > 0 && Buffer.byteLength(reply) > maxBytes) {
      reply = Buffer.from(reply).subarray(0, maxBytes).toString('utf8').replace(/�+$/, '') + `\n[… truncated at ${maxBytes} bytes]`;
    }
    io.out(`turn ${n} (${turn.engine}/${turn.model}${turn.ok ? '' : ', failed'}) in session ${sid}\n`);
    io.out(`request: ${neutralizeForInjection(String(turn.task || ''))}\n`);
    io.out(`reply:\n${neutralizeForInjection(reply)}\n`);
    if (Array.isArray(turn.files) && turn.files.length) io.out(`files:\n${describeFiles(turn.files)}\n`);
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

  if (group === 'handoff') {
    if (action === 'begin') {
      const to = (flags.to || 'any').toLowerCase();
      if (!['any', 'gemini', 'vibe', 'opencode', 'muse', 'codex', 'claude'].includes(to)) { io.err(`Unknown handoff target: ${to}\n`); return 1; }
      const sid = pickSession(snapshot, flags.session);
      const lastTurn = sid ? readTurns(snapshot, sid).filter(t => t.kind === 'turn').at(-1) : null;
      const task = flags.task || lastTurn?.task || '';
      if (!task) { io.err('Nothing to hand off: pass --task or run a session first.\n'); return 1; }
      const parentRun = flags.run || flags['parent-run'] || '';
      const taskId = flags['task-id'] || flags.taskid || '';
      const rawDepends = flags['depends-on'] !== undefined ? flags['depends-on'] : flags.dependson;
      if (rawDepends !== undefined && (typeof rawDepends !== 'string' || !rawDepends.trim())) {
        io.err('Usage: --depends-on needs a value: a task id or a comma-separated list of task ids.\n');
        return 1;
      }
      const dependsOn = rawDepends || '';
      const approval = flags.gate || flags.approval || '';
      try {
        const hid = beginHandoff(repoDir, project.key, {
          to, fromSession: sid || '', fromEngine: 'user', reason: flags.reason || 'manual handoff', task,
          parentRun, taskId, dependsOn, approval
        });
        io.out(`handoff: ${hid}\n`);
        return 0;
      } catch (err) {
        io.err(`Handoff begin failed: ${err?.message || err}\n`);
        return 1;
      }
    }
    if (action === 'list') {
      const all = listHandoffs(snapshot).filter(h => flags.all !== undefined || h.state === 'open');
      for (const h of all) io.out(`${h.id} ${h.state} to=${h.to} from=${h.from_engine || '-'} (${h.reason || '-'}): ${String(h.task).split('\n')[0].slice(0, 100)}\n`);
      if (!all.length) io.out('(no open handoffs)\n');
      return 0;
    }
    if (action === 'accept') {
      if (!isValidHandoffId(arg)) { io.err('Usage: memory handoff accept <handoff id>\n'); return 1; }
      const claim = claimHandoff(repoDir, project.key, arg, flags.by || 'user');
      if (!claim.ok) {
        const reasons = claim.reasons ? ` (${claim.reasons.join(', ')})` : '';
        io.err(`Handoff ${arg} was not taken: it is ${claim.state}${reasons}.\n`);
        return 3;
      }
      const handoff = listHandoffs(snapshotProject(repoDir, project.key)).find(h => h.id === arg);
      io.out(`Accepted ${arg}.\n${handoff?.task || ''}\n`);
      return 0;
    }
    if (action === 'approve' || action === 'reject') {
      if (!isValidHandoffId(arg)) { io.err(`Usage: memory handoff ${action} <handoff id> [--note <text>] [--by <who>]\n`); return 1; }
      const status = action === 'approve' ? 'approved' : 'rejected';
      const res = approveHandoff(repoDir, project.key, arg, { by: flags.by || 'user', status, note: flags.note || '' });
      if (!res.ok) { io.err(`Handoff ${arg} could not be ${status}: ${res.reason}.\n`); return 3; }
      io.out(`${action === 'approve' ? 'Approved' : 'Rejected'} handoff ${arg}.\n`);
      return 0;
    }
    if (action === 'complete') {
      if (!isValidHandoffId(arg)) { io.err('Usage: memory handoff complete <handoff id> [--by <who>]\n'); return 1; }
      const res = completeHandoff(repoDir, project.key, arg, { by: flags.by || 'user' });
      if (!res.ok) { io.err(`Handoff ${arg} could not be completed: it is ${res.state}.\n`); return 3; }
      io.out(`Completed handoff ${arg}.\n`);
      return 0;
    }
    if (action === 'summary') {
      if (flags.run) {
        if (!isValidRunId(flags.run)) { io.err(`Invalid run id: ${flags.run}\n`); return 1; }
        const summary = runSummary(snapshot, flags.run);
        io.out(`Run ${summary.run}: open=${summary.counts.open}, accepted=${summary.counts.accepted}, completed=${summary.counts.completed}, expired=${summary.counts.expired}\n`);
        io.out(`Ready (${summary.ready.length}): ${summary.ready.map(h => h.id).join(', ') || 'none'}\n`);
        io.out(`Blocked (${summary.blocked.length}): ${summary.blocked.map(h => h.id).join(', ') || 'none'}\n`);
        for (const h of summary.subtasks) {
          io.out(`  ${h.id} [${h.state}${h.approval ? `/${h.approval}` : ''}]: ${h.task_id || '-'} ${h.task.slice(0, 60)}\n`);
        }
        return 0;
      }
      const all = listHandoffs(snapshot);
      const counts = { open: 0, accepted: 0, completed: 0, expired: 0 };
      const runs = new Set();
      for (const h of all) {
        counts[h.state] = (counts[h.state] || 0) + 1;
        if (h.parent_run) runs.add(h.parent_run);
      }
      io.out(`Total handoffs: ${all.length} (open: ${counts.open}, accepted: ${counts.accepted}, completed: ${counts.completed}, expired: ${counts.expired})\n`);
      if (runs.size) io.out(`Runs: ${[...runs].join(', ')}\n`);
      return 0;
    }
  }

  if (group === 'worktree') {
    const repo = findGitRepo(workdir);
    if (!repo) { io.err(`No git repository at ${workdir}.\n`); return 1; }

    if (action === 'list') {
      const trees = listWorktrees(repo);
      for (const w of trees) {
        const details = [
          w.branch ? `[${w.branch}]` : w.detached ? '[detached]' : '',
          w.head ? w.head.slice(0, 8) : '',
          w.bare ? '(bare)' : '',
          w.locked ? `(locked: ${w.locked})` : '',
          w.prunable ? `(prunable: ${w.prunable})` : ''
        ].filter(Boolean).join(' ');
        io.out(`${w.path} ${details}\n`);
      }
      if (!trees.length) io.out('(no worktrees)\n');
      return 0;
    }
    if (action === 'create') {
      const name = arg;
      if (!name) { io.err('Usage: memory worktree create <name> [--base <ref>] [--branch <ref>] [--cwd <dir>]\n'); return 1; }
      try {
        const res = createWorktree(repo, { name, base: flags.base || 'HEAD', branch: flags.branch });
        io.out(`Worktree created at ${res.path} on branch ${res.branch}${res.reused ? ' (reused)' : ''}\n`);
        return 0;
      } catch (err) {
        io.err(`Worktree creation failed: ${err.message}\n`);
        return 1;
      }
    }
    if (action === 'remove') {
      const name = arg;
      if (!name) { io.err('Usage: memory worktree remove <name> [--force] [--keep-branch] [--cwd <dir>]\n'); return 1; }
      const res = removeWorktree(repo, name, { force: Boolean(flags.force), deleteBranch: !flags['keep-branch'] });
      if (!res.ok) {
        io.err(`Worktree removal failed: ${res.reason}${res.hint ? ' (' + res.hint + ')' : ''}\n`);
        return 1;
      }
      io.out(`Removed worktree at ${res.path}${res.branchDeleted ? ` (branch ${res.branch} deleted)` : ''}\n`);
      return 0;
    }
    if (action === 'prune') {
      pruneWorktrees(repo);
      io.out('Pruned stale worktrees.\n');
      return 0;
    }
  }

  if (group === 'note' && action === 'add') {
    const text = positional.slice(2).join(' ').trim();
    const scope = flags.scope === 'mine' ? 'mine' : 'repo';
    if (!text) { io.err('Usage: memory note add <text> [--scope repo|mine] [--slug <name>]\n'); return 1; }
    const slug = flags.slug || `note-${Date.now().toString(36)}`;
    writePage(repoDir, project.key, { slug, body: text, cwd: workdir, scope });
    io.out(`Saved ${scope === 'mine' ? 'personal' : `project ${project.key}`} note ${slug}.\n`);
    return 0;
  }

  if (group === 'search') {
    const query = positional.slice(1).join(' ');
    const scope = flags.scope || 'repo';
    if (!SCOPES.includes(scope)) { io.err(`Unknown scope: ${scope} (use ${SCOPES.join(', ')})\n`); return 1; }
    const memoryConfig = readMemoryConfig(configFile);
    const index = indexFile && memoryConfig.index !== false ? { file: indexFile, vector: vectorSettings(memoryConfig.vector) } : null;
    let hits;
    try {
      ({ items: hits } = searchWithInfo(repoDir, { projectKey: project.key, query, scope, cwd: workdir, limit: Number(flags.limit) || 10,
        global: Boolean(flags.global), index,
        onError: err => io.err(`[AI Factory Memory] index unavailable, scanning git objects instead: ${err.message}\n`) }));
    } catch (err) { io.err(`${err.message}\n`); return 1; }
    for (const hit of hits) {
      const where = flags.global ? `[${hit.project}] ` : '';
      const label = where + (hit.kind === 'page' ? `page ${hit.slug}` : `turn ${hit.id}`);
      io.out(`${label}: ${hit.text.replace(/\s+/g, ' ').slice(0, 160)}\n`);
    }
    if (!hits.length) io.out('(no matches)\n');
    return 0;
  }

  if (group === 'session' && action === 'adopt') {
    const name = arg;
    const unscoped = snapshotProject(repoDir, UNSCOPED_PROJECT);
    const sid = findSession(unscoped, name);
    if (!sid) { io.err(`No session "${name}" in ${UNSCOPED_PROJECT}.\n`); return 1; }
    const paths = sessionPaths(sid);
    const files = [paths.meta, paths.log].map(file => [file, unscoped.read(file)]).filter(([, text]) => text !== null);
    commitProject(repoDir, project.key, { subject: `adopt session ${name}`, trailers: { Session: sid, Kind: 'migration' } }, view => {
      for (const [file, text] of files) {
        if (file === paths.meta) {
          const meta = JSON.parse(text);
          meta.project = project.key;
          meta.cwd = meta.cwd || workdir;
          view.write(file, JSON.stringify(meta, null, 2));
        } else view.writeRaw(file, text);
      }
      const aliases = JSON.parse(view.read(ALIASES_FILE) || '{}');
      aliases[name] = sid;
      view.write(ALIASES_FILE, JSON.stringify(aliases, null, 2));
    });
    commitProject(repoDir, UNSCOPED_PROJECT, { subject: `session ${name} moved to ${project.key}`, trailers: { Session: sid, Kind: 'migration' } }, view => {
      for (const [file] of files) view.remove(file);
      const aliases = JSON.parse(view.read(ALIASES_FILE) || '{}');
      delete aliases[name];
      view.write(ALIASES_FILE, JSON.stringify(aliases, null, 2));
    });
    io.out(`Session "${name}" now belongs to project ${project.key}.\n`);
    return 0;
  }

  io.err('Usage: node router.mjs memory session show [<alias|sid>] | session adopt <alias> | turn show <n> | turn diff <n> | turn revert <n> [--yes]\n' +
    '       | note add <text> [--scope repo|mine] | search <query> [--scope repo|dir|mine] [--global]\n' +
    '       | project list | project rename <old> <new> [--yes] | project merge <source> <target> [--yes]\n' +
    '       | handoff begin --to <engine|any> [--task <text>] | handoff list [--all] | handoff accept <hid> | handoff approve|reject|complete <hid> | handoff summary [--run <id>]\n' +
    '       | worktree list | worktree create <name> | worktree remove <name> [--force] | worktree prune\n');
  return 1;
}
