// The router's only entry into the memory layer: resolveSession, buildPrompt, recordTurn.
//
// Paths and configuration arrive as parameters; nothing here imports the router or lib/paths.
// Every method catches its own errors, logs one "[AI Factory Memory]" line and returns a value
// that lets the task continue unchanged.

import { resolveProject, UNSCOPED_PROJECT } from './project.mjs';
import { takeSnapshot, diffSnapshots } from './worktree.mjs';
import { newSessionId, isValidSid, recordTurnCommit, findSession, readMeta } from './session.mjs';
import { snapshotProject } from './store.mjs';
import { migrateRegistry } from './migrate.mjs';
import { SCOPES } from './search.mjs';

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

  // Session identity: --session, then AI_FACTORY_SESSION_ID, then a new UUIDv7. --name and
  // --resume are aliases resolved inside the project, so equal names in two projects never clash.
  // With --resume the result carries a registry-shaped `resume` entry for the router's resume path.
  function resolveSession(opts = {}) {
    return guard('resolveSession', null, () => {
      if (opts.legacyRegistryFile) {
        try { migrateRegistry(repoDir, opts.legacyRegistryFile, warn); } catch (err) { warn(`registry migration failed: ${err.message}`); }
      }
      let cwd = opts.cwd || process.cwd();
      let project = resolveProject({ project: opts.project, cwd });
      const scope = SCOPES.includes(opts.scope) ? opts.scope : 'repo';
      if (opts.scope && opts.scope !== scope) warn(`unknown scope "${opts.scope}", using repo`);
      let sid = opts.session || env.AI_FACTORY_SESSION_ID || '';
      if (sid && !isValidSid(sid)) { warn(`ignoring invalid session id "${String(sid).slice(0, 40)}"`); sid = ''; }
      let alias = opts.name || '';
      let resume = null;
      if (opts.resume) {
        alias = opts.resume;
        let snapshot = snapshotProject(repoDir, project.key);
        let found = findSession(snapshot, opts.resume);
        if (!found && !opts.project) {
          // Migrated sessions without a recorded cwd live in the _unscoped project.
          const unscoped = snapshotProject(repoDir, UNSCOPED_PROJECT);
          found = findSession(unscoped, opts.resume);
          if (found) { snapshot = unscoped; project = { key: UNSCOPED_PROJECT, name: UNSCOPED_PROJECT, source: 'migration', ignorePaths: [] }; }
        }
        if (!found) return { missing: true, project, sid: null };
        sid = found;
        const meta = readMeta(snapshot, sid) || {};
        const engine = opts.engine || meta.last_engine;
        const savedId = meta.engine_sessions?.[engine] || null;
        resume = {
          engine, model: meta.models?.[engine] || undefined, sessionId: savedId, cwd: meta.cwd || undefined,
          // A different engine than last time starts a new engine conversation on purpose: the
          // memory block carries the context over instead.
          switched: Boolean(opts.engine && opts.engine !== meta.last_engine && !savedId)
        };
        // The session stays in the project it was found in; only the working directory follows it.
        if (resume.cwd) cwd = resume.cwd;
      } else if (alias && !sid) {
        sid = findSession(snapshotProject(repoDir, project.key), alias) || '';
      }
      sid = sid || newSessionId();
      const ctx = { project, sid, cwd, alias, scope, resume, injected: [] };
      ctx.before = takeSnapshot(cwd, { ignorePaths: project.ignorePaths, budgetMs: settings.file_budget_ms, enabled: settings.track_files });
      return ctx;
    });
  }

  function buildPrompt(task) {
    return task;
  }

  function recordTurn(ctx, outcome) {
    if (!ctx || ctx.missing) return null;
    return guard('recordTurn', null, () => {
      const after = takeSnapshot(ctx.cwd, { ignorePaths: ctx.project.ignorePaths, budgetMs: settings.file_budget_ms, enabled: settings.track_files });
      const diff = diffSnapshots(ctx.before, after, { budgetMs: settings.file_budget_ms });
      if (diff.files === 'unavailable') warn(`file changes not recorded: ${diff.reason}`);
      return recordTurnCommit(repoDir, ctx, outcome, { after, diff });
    });
  }

  return { settings, resolveSession, buildPrompt, recordTurn, repoDir, dataDir };
}
