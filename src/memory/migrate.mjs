// One-time move of the legacy global session_registry.json into per-project memory sessions.
//
// Each entry becomes session "legacy-<name>" in the project its cwd resolves to, with the alias
// <name> and the provider session id under engine_sessions. Entries without a cwd go to the
// "_unscoped" project. The file is then renamed to "<file>.migrated". Running it twice is harmless:
// the second run rewrites identical files.

import fs from 'node:fs';
import { resolveProject, UNSCOPED_PROJECT, slugify } from './project.mjs';
import { followMoves } from './projects.mjs';
import { commitProject } from './store.mjs';
import { ALIASES_FILE, sessionPaths, isValidSid } from './session.mjs';
import { renameWithRetry } from './gitobj.mjs';

export function legacySid(name) {
  const sid = `legacy-${slugify(name)}`.slice(0, 120);
  return isValidSid(sid) ? sid : `legacy-${Buffer.from(String(name)).toString('hex').slice(0, 100)}`;
}

export function migrateRegistry(repoDir, registryFile, warn = () => {}) {
  if (!registryFile || !fs.existsSync(registryFile)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch (err) {
    warn(`${registryFile} is not valid JSON; left in place (${err.message})`);
    return null;
  }
  const byProject = new Map();
  for (const [name, entry] of Object.entries(data?.sessions || {})) {
    if (!entry || typeof entry !== 'object' || ['__proto__', 'constructor', 'prototype'].includes(name)) continue;
    const project = entry.cwd ? followMoves(repoDir, resolveProject({ cwd: entry.cwd })) : { key: UNSCOPED_PROJECT, name: UNSCOPED_PROJECT, source: 'migration' };
    if (!entry.cwd) {
      warn(`legacy session "${name}" had no cwd and was filed under project ${UNSCOPED_PROJECT}. ` +
        `To move it: node router.mjs memory session adopt "${name}" --cwd <project directory>`);
    }
    if (!byProject.has(project.key)) byProject.set(project.key, { project, entries: [] });
    byProject.get(project.key).entries.push([name, entry]);
  }
  const migrated = [];
  for (const { project, entries } of byProject.values()) {
    commitProject(repoDir, project.key, { subject: `migrate ${entries.length} session(s) from session_registry.json`, trailers: { Kind: 'migration' } }, view => {
      if (!view.read('project.json')) {
        view.write('project.json', JSON.stringify({ key: project.key, name: project.name, source: project.source,
          remote: project.remote || '', aliases: [], created: new Date().toISOString() }, null, 2));
      }
      const aliases = JSON.parse(view.read(ALIASES_FILE) || '{}');
      for (const [name, entry] of entries) {
        const sid = legacySid(name);
        const paths = sessionPaths(sid);
        const meta = JSON.parse(view.read(paths.meta) || 'null') || { sid, project: project.key, turns: 0, last_injected_seq: {} };
        meta.alias = name;
        meta.cwd = entry.cwd || meta.cwd || '';
        meta.engine_sessions = { ...(meta.engine_sessions || {}) };
        meta.models = { ...(meta.models || {}) };
        if (entry.engine) {
          if (entry.sessionId) meta.engine_sessions[entry.engine] = entry.sessionId;
          if (entry.model) meta.models[entry.engine] = entry.model;
          meta.last_engine = entry.engine;
        }
        meta.created = meta.created || entry.updated_at || new Date().toISOString();
        meta.updated = entry.updated_at || meta.updated || new Date().toISOString();
        meta.migrated_from = 'session_registry.json';
        view.write(paths.meta, JSON.stringify(meta, null, 2));
        aliases[name] = sid;
        migrated.push({ name, sid, project: project.key });
      }
      view.write(ALIASES_FILE, JSON.stringify(aliases, null, 2));
    });
  }
  let target = registryFile + '.migrated';
  if (fs.existsSync(target)) target = `${registryFile}.migrated-${Date.now()}`;
  try { renameWithRetry(registryFile, target); } catch (err) {
    // A concurrent router migrated and renamed it first.
    if (err.code !== 'ENOENT') throw err;
  }
  return { migrated, renamedTo: target };
}
