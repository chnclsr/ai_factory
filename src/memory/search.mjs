// Scoped retrieval over a project's memory, read straight from git objects (no git process).
//
//   repo  pages and turns on the project's ref (default)
//   dir   only turns and pages recorded with a cwd inside the given directory
//   mine  only the personal ref; never mixed into project results
//
// Plain term matching is the baseline; the FTS5 index of step 6 replaces the ranking.

import path from 'node:path';
import { snapshotProject, snapshotRef, parseFrontMatter } from './store.mjs';
import { PERSONAL_REF } from './project.mjs';
import { listSessions, readTurns } from './session.mjs';

export const SCOPES = ['repo', 'dir', 'mine'];

export function terms(text) {
  return [...new Set(String(text || '').toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || [])].slice(0, 32);
}

function score(haystack, queryTerms) {
  const lower = haystack.toLowerCase();
  let hits = 0;
  for (const term of queryTerms) if (lower.includes(term)) hits++;
  return hits;
}

export function isInside(child, parent) {
  if (!child || !parent) return false;
  const norm = p => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function collectPages(snapshot, { cwd = '', scope = 'repo' } = {}) {
  const pages = [];
  for (const entry of snapshot.list('pages')) {
    if (entry.mode === '40000' || !entry.name.endsWith('.md') || /\.v\d+\.md$/.test(entry.name)) continue;
    const text = snapshot.read(`pages/${entry.name}`) || '';
    const { meta, body } = parseFrontMatter(text);
    if (scope === 'dir' && !isInside(meta.cwd, cwd)) continue;
    pages.push({ kind: 'page', id: `pages/${entry.name}`, slug: entry.name.slice(0, -3), meta, text: body, sha: entry.sha });
  }
  return pages;
}

export function collectTurns(snapshot, { cwd = '', scope = 'repo' } = {}) {
  const out = [];
  for (const session of listSessions(snapshot)) {
    for (const turn of readTurns(snapshot, session.sid)) {
      if (turn.kind !== 'turn') continue;
      if (scope === 'dir' && !isInside(turn.cwd, cwd)) continue;
      out.push({ kind: 'turn', id: `${session.sid}#${turn.n}`, sid: session.sid, turn,
        text: `${turn.task}\n${turn.response_head || ''}` });
    }
  }
  return out;
}

// Returns ranked items [{ kind, id, text, score, ... }].
export function search(repoDir, { projectKey, query, scope = 'repo', cwd = '', limit = 10 }) {
  if (!SCOPES.includes(scope)) throw new Error(`unknown scope: ${scope}`);
  const queryTerms = terms(query);
  let items;
  if (scope === 'mine') {
    items = collectPages(snapshotRef(repoDir, PERSONAL_REF));
  } else {
    const snapshot = snapshotProject(repoDir, projectKey);
    items = [...collectPages(snapshot, { cwd, scope }), ...collectTurns(snapshot, { cwd, scope })];
  }
  return items.map(item => ({ ...item, score: queryTerms.length ? score(item.text, queryTerms) : 1 }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.meta?.updated || b.turn?.ts || '').localeCompare(String(a.meta?.updated || a.turn?.ts || '')))
    .slice(0, limit);
}
