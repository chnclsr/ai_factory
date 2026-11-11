// The router's only entry into the memory layer: resolveSession, buildPrompt, recordTurn.
//
// Paths and configuration arrive as parameters; nothing here imports the router or lib/paths.
// Every method catches its own errors, logs one "[AI Factory Memory]" line and returns a value
// that lets the task continue unchanged.

import { resolveProject } from './project.mjs';
import { takeSnapshot, diffSnapshots } from './worktree.mjs';
import { newSessionId, isValidSid, recordTurnCommit } from './session.mjs';

export const LOG_PREFIX = '[AI Factory Memory]';

export const DEFAULT_MEMORY_CONFIG = Object.freeze({
  enabled: false,
  track_files: true,
  file_budget_ms: 2000
});

export function createMemory({ repoDir, dataDir, memoryConfig = {}, routerConfig = {}, env = process.env, log = console.warn }) {
  const settings = { ...DEFAULT_MEMORY_CONFIG, ...memoryConfig };
  const warn = message => { try { log(`${LOG_PREFIX} ${message}`); } catch {} };
  const guard = (label, fallback, fn) => {
    try { return fn(); } catch (err) {
      warn(`${label} failed, continuing without memory: ${String(err?.message || err).split('\n')[0]}`);
      return typeof fallback === 'function' ? fallback() : fallback;
    }
  };

  function resolveSession(opts = {}) {
    return guard('resolveSession', null, () => {
      const cwd = opts.cwd || process.cwd();
      const project = resolveProject({ project: opts.project, cwd });
      let sid = opts.session || env.AI_FACTORY_SESSION_ID || '';
      if (sid && !isValidSid(sid)) { warn(`ignoring invalid session id "${String(sid).slice(0, 40)}"`); sid = ''; }
      sid = sid || newSessionId();
      const ctx = { project, sid, cwd, alias: opts.name || '', scope: opts.scope || 'repo', injected: [] };
      ctx.before = takeSnapshot(cwd, { ignorePaths: project.ignorePaths, budgetMs: settings.file_budget_ms, enabled: settings.track_files });
      return ctx;
    });
  }

  function buildPrompt(task) {
    return task;
  }

  function recordTurn(ctx, outcome) {
    if (!ctx) return null;
    return guard('recordTurn', null, () => {
      const after = takeSnapshot(ctx.cwd, { ignorePaths: ctx.project.ignorePaths, budgetMs: settings.file_budget_ms, enabled: settings.track_files });
      const diff = diffSnapshots(ctx.before, after, { budgetMs: settings.file_budget_ms });
      if (diff.files === 'unavailable') warn(`file changes not recorded: ${diff.reason}`);
      return recordTurnCommit(repoDir, ctx, outcome, { after, diff });
    });
  }

  return { settings, resolveSession, buildPrompt, recordTurn, repoDir, dataDir };
}
