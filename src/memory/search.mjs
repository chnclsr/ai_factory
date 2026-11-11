// Scoped retrieval over a project's memory.
//
//   repo  pages and turns on the project's ref (default)
//   dir   only turns and pages recorded with a cwd inside the given directory
//   mine  only the personal ref; never mixed into project results
//   --global  every live project ref (never the personal ref)
//
// With an index file the ranking is FTS5 bm25 over the derived SQLite index (fts.mjs). Without
// one, or if the index fails, a plain term scan over git objects answers instead, so search never
// depends on the index being healthy.

import path from 'node:path';
import { snapshotRef, parseFrontMatter } from './store.mjs';
import { PERSONAL_REF, projectRef } from './project.mjs';
import { listSessions, readTurns } from './session.mjs';
import { listRefs } from './gitobj.mjs';
import { openIndex, syncRef, syncAll, liveProjectRefs, queryDocs } from './fts.mjs';

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

// sessionLimit keeps the fallback scan to the most recently updated sessions.
export function collectTurns(snapshot, { cwd = '', scope = 'repo', sessionLimit = Infinity } = {}) {
  const out = [];
  for (const session of listSessions(snapshot).slice(0, sessionLimit)) {
    for (const turn of readTurns(snapshot, session.sid)) {
      if (turn.kind !== 'turn') continue;
      if (scope === 'dir' && !isInside(turn.cwd, cwd)) continue;
      out.push({ kind: 'turn', id: `${session.sid}#${turn.n}`, sid: session.sid, turn,
        text: `${turn.task}\n${turn.response_head || ''}` });
    }
  }
  return out;
}

const refKey = ref => (ref.startsWith('refs/heads/p/') ? ref.slice('refs/heads/p/'.length) : ref === PERSONAL_REF ? 'personal' : ref);

// Index documents in the shape the scan produces, so callers handle one kind of item.
export function docToItem(doc) {
  if (doc.kind === 'page') {
    return { kind: 'page', id: doc.doc_id, slug: doc.data.slug, meta: doc.data.meta || {}, text: doc.body, project: refKey(doc.ref),
      docRow: doc.id, seq: doc.seq };
  }
  const turn = { ...doc.data, n: doc.n, seq: doc.seq, cwd: doc.cwd, ts: doc.ts, kind: 'turn' };
  return { kind: 'turn', id: doc.doc_id, sid: doc.sid, turn, text: `${turn.task || ''}\n${turn.response_head || ''}`,
    project: refKey(doc.ref), docRow: doc.id, seq: doc.seq };
}

// Ranked index documents for one search. `filter(doc)` drops documents before the limit applies.
// Returns null when node:sqlite is unavailable, so the caller falls back to the scan.
export function indexSearch({ repoDir, file, projectKey, queryTerms, scope = 'repo', cwd = '', global = false, limit = 10, filter = null }) {
  const idx = openIndex(file);
  if (!idx) return null;
  let refs;
  if (scope === 'mine') {
    syncRef(idx, repoDir, PERSONAL_REF);
    refs = [PERSONAL_REF];
  } else if (global) {
    syncAll(idx, repoDir);
    refs = liveProjectRefs(idx);
  } else {
    refs = [projectRef(projectKey)];
    syncRef(idx, repoDir, refs[0]);
  }
  const fetched = queryDocs(idx, { refs, queryTerms, limit: Math.max(limit * 8, 40) });
  const items = [];
  for (const doc of fetched) {
    if (scope === 'dir' && !isInside(doc.cwd, cwd)) continue;
    if (filter && !filter(doc)) continue;
    items.push(docToItem(doc));
    if (items.length >= limit) break;
  }
  items.backend = 'fts';
  return items;
}

function liveProjectRefsByScan(repoDir) {
  return listRefs(repoDir, 'refs/heads/p').filter(ref => {
    try { return !JSON.parse(snapshotRef(repoDir, ref).read('project.json') || '{}').moved_to; } catch { return true; }
  });
}

function scanSearch(repoDir, { projectKey, queryTerms, scope, cwd, global }) {
  if (scope === 'mine') return collectPages(snapshotRef(repoDir, PERSONAL_REF));
  const refs = global ? liveProjectRefsByScan(repoDir) : [projectRef(projectKey)];
  return refs.flatMap(ref => {
    const snapshot = snapshotRef(repoDir, ref);
    return [...collectPages(snapshot, { cwd, scope }), ...collectTurns(snapshot, { cwd, scope })]
      .map(item => ({ ...item, project: refKey(ref) }));
  }).map(item => ({ ...item, score: queryTerms.length ? score(item.text, queryTerms) : 1 }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.meta?.updated || b.turn?.ts || '').localeCompare(String(a.meta?.updated || a.turn?.ts || '')));
}

// Returns ranked items [{ kind, id, text, project, ... }] and which backend answered.
//   options.index   { file } — use the derived index (falls back to the scan on error)
//   options.global  search every live project ref
export function searchWithInfo(repoDir, { projectKey, query, scope = 'repo', cwd = '', limit = 10, index = null, global = false, onError = null }) {
  if (!SCOPES.includes(scope)) throw new Error(`unknown scope: ${scope}`);
  if (global && scope === 'mine') throw new Error('--global searches projects; it cannot be combined with --scope mine');
  const queryTerms = terms(query);
  if (index?.file) {
    try {
      const items = indexSearch({ repoDir, file: index.file, projectKey, queryTerms, scope, cwd, global, limit });
      if (items) return { items, backend: items.backend || 'fts' };
    } catch (err) {
      onError?.(err);
    }
  }
  return { items: scanSearch(repoDir, { projectKey, queryTerms, scope, cwd, global }).slice(0, limit), backend: 'scan' };
}

export function search(repoDir, options) {
  return searchWithInfo(repoDir, options).items;
}
