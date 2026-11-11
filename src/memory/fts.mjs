// Derived SQLite index over the memory refs: FTS5 text search and, when enabled, chunk vectors.
//
// git stays the source of truth. The index file can be deleted at any time; the next query
// rebuilds it from the refs by reading git objects in JS, so the read path still spawns no
// process. Sync is incremental per file: a ref whose sha is unchanged costs one row lookup, and
// only session logs and pages whose blob sha changed are parsed again.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readRef, listRefs } from './gitobj.mjs';
import { snapshotRef, parseFrontMatter } from './store.mjs';
import { PERSONAL_REF } from './project.mjs';

const SCHEMA_VERSION = '3';
const MAX_BODY_CHARS = 32768;

let sqlite;
// node:sqlite prints an ExperimentalWarning on load; only that one warning is dropped.
function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/SQLite is an experimental feature/i.test(String(text))) return;
    return emit.call(process, warning, ...rest);
  };
  try { sqlite = createRequire(import.meta.url)('node:sqlite'); } catch { sqlite = null; } finally { process.emitWarning = emit; }
  return sqlite;
}

export function sqliteAvailable() {
  return Boolean(loadSqlite());
}

const handles = new Map();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS refs(ref TEXT PRIMARY KEY, sha TEXT, seq INTEGER, moved_to TEXT);
CREATE TABLE IF NOT EXISTS files(ref TEXT, path TEXT, sha TEXT, PRIMARY KEY(ref, path));
CREATE TABLE IF NOT EXISTS docs(
  id INTEGER PRIMARY KEY, ref TEXT NOT NULL, path TEXT NOT NULL, doc_id TEXT NOT NULL, kind TEXT NOT NULL,
  sid TEXT, n INTEGER, seq INTEGER, cwd TEXT, ts TEXT, data TEXT, body TEXT);
CREATE INDEX IF NOT EXISTS docs_ref_path ON docs(ref, path);
CREATE INDEX IF NOT EXISTS docs_ref_doc ON docs(ref, doc_id);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(body, refkey, tokenize = 'porter unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY, doc INTEGER NOT NULL, ref TEXT NOT NULL, ord INTEGER NOT NULL, start INTEGER, end INTEGER,
  key TEXT NOT NULL, provider TEXT, model TEXT, dim INTEGER, vec BLOB, list INTEGER);
CREATE TABLE IF NOT EXISTS centroids(ref TEXT NOT NULL, cid INTEGER NOT NULL, vec BLOB NOT NULL, PRIMARY KEY(ref, cid));
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc);
CREATE INDEX IF NOT EXISTS chunks_ref ON chunks(ref, list);
`;

// Opens (and caches per process) the index at `file`. Returns null when node:sqlite is missing.
export function openIndex(file) {
  if (handles.has(file)) return handles.get(file);
  const lib = loadSqlite();
  if (!lib) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let db = new lib.DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 3000');
  const version = (() => { try { return db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.value; } catch { return null; } })();
  if (version && version !== SCHEMA_VERSION) {
    // A derived file from another schema is simply rebuilt.
    db.close();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch {} }
    db = new lib.DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 3000');
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
  const idx = { file, db, stmts: new Map(), hooks: [] };
  handles.set(file, idx);
  return idx;
}

export function closeIndex(file) {
  const idx = handles.get(file);
  if (!idx) return;
  try { idx.db.close(); } catch {}
  handles.delete(file);
}

export function stmt(idx, sql) {
  let s = idx.stmts.get(sql);
  if (!s) { s = idx.db.prepare(sql); idx.stmts.set(sql, s); }
  return s;
}

// Lets the vector layer keep its chunk table in step with docs without fts.mjs importing it.
export function addIndexHook(idx, hook) {
  if (!idx.hooks.includes(hook)) idx.hooks.push(hook);
}

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function turnBody(turn) {
  const files = Array.isArray(turn.files) ? turn.files.map(f => f.path).join(' ') : '';
  return `${turn.task || ''}\n${turn.response_head || ''}\n${files}`.slice(0, MAX_BODY_CHARS);
}

// Documents produced by one file of a ref: each turn of a session log, or one page.
function docsForFile(snapshot, filePath) {
  const text = snapshot.read(filePath) || '';
  if (filePath.startsWith('sessions/')) {
    const sid = filePath.slice('sessions/'.length, -'.jsonl'.length);
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const turn = parseJson(line, null);
      if (!turn || turn.kind !== 'turn') continue;
      const data = { engine: turn.engine, model: turn.model, ok: turn.ok, task: turn.task, response_head: turn.response_head,
        files: turn.files, engine_session: turn.engine_session };
      out.push({ doc_id: `${sid}#${turn.n}`, kind: 'turn', sid, n: turn.n, seq: turn.seq || 0, cwd: turn.cwd || '',
        ts: turn.ts || '', data, body: turnBody(turn) });
    }
    return out;
  }
  const { meta, body } = parseFrontMatter(text);
  const slug = filePath.slice('pages/'.length, -'.md'.length);
  return [{ doc_id: filePath, kind: 'page', sid: meta.session || '', n: null, seq: Number(meta.seq || 0), cwd: meta.cwd || '',
    ts: meta.updated || '', data: { slug, meta }, body: body.slice(0, MAX_BODY_CHARS) }];
}

function indexedFiles(snapshot) {
  const files = new Map();
  for (const entry of snapshot.list('sessions')) {
    if (entry.mode !== '40000' && entry.name.endsWith('.jsonl')) files.set(`sessions/${entry.name}`, entry.sha);
  }
  for (const entry of snapshot.list('pages')) {
    if (entry.mode !== '40000' && entry.name.endsWith('.md') && !/\.v\d+\.md$/.test(entry.name)) files.set(`pages/${entry.name}`, entry.sha);
  }
  return files;
}

function removeFile(idx, ref, filePath) {
  for (const row of stmt(idx, 'SELECT id FROM docs WHERE ref = ? AND path = ?').all(ref, filePath)) {
    stmt(idx, 'DELETE FROM docs_fts WHERE rowid = ?').run(row.id);
  }
  for (const hook of idx.hooks) hook.removeFile?.(idx, ref, filePath);
  stmt(idx, 'DELETE FROM docs WHERE ref = ? AND path = ?').run(ref, filePath);
  stmt(idx, 'DELETE FROM files WHERE ref = ? AND path = ?').run(ref, filePath);
}

// Re-indexes one changed file. Unchanged documents keep their row id, so a session log that only
// gained a line inserts one row instead of rewriting the session.
function indexFile(idx, ref, snapshot, filePath, blobSha) {
  const existing = new Map(stmt(idx, 'SELECT id, doc_id, body, seq, data FROM docs WHERE ref = ? AND path = ?').all(ref, filePath)
    .map(row => [row.doc_id, row]));
  const seen = new Set();
  for (const doc of docsForFile(snapshot, filePath)) {
    seen.add(doc.doc_id);
    const data = JSON.stringify(doc.data);
    const old = existing.get(doc.doc_id);
    if (old && old.body === doc.body && old.data === data && Number(old.seq) === doc.seq) continue;
    if (old) {
      stmt(idx, 'DELETE FROM docs_fts WHERE rowid = ?').run(old.id);
      for (const hook of idx.hooks) hook.removeDoc?.(idx, old.id);
      stmt(idx, 'DELETE FROM docs WHERE id = ?').run(old.id);
    }
    const { lastInsertRowid } = stmt(idx, 'INSERT INTO docs(ref, path, doc_id, kind, sid, n, seq, cwd, ts, data, body) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(ref, filePath, doc.doc_id, doc.kind, doc.sid, doc.n, doc.seq, doc.cwd, doc.ts, data, doc.body);
    const id = Number(lastInsertRowid);
    stmt(idx, 'INSERT INTO docs_fts(rowid, body, refkey) VALUES (?, ?, ?)').run(id, doc.body, refToken(ref));
    for (const hook of idx.hooks) hook.addDoc?.(idx, { id, ref, ...doc });
  }
  for (const [docId, row] of existing) {
    if (seen.has(docId)) continue;
    stmt(idx, 'DELETE FROM docs_fts WHERE rowid = ?').run(row.id);
    for (const hook of idx.hooks) hook.removeDoc?.(idx, row.id);
    stmt(idx, 'DELETE FROM docs WHERE id = ?').run(row.id);
  }
  stmt(idx, 'INSERT OR REPLACE INTO files(ref, path, sha) VALUES (?,?,?)').run(ref, filePath, blobSha);
}

// Brings one ref's documents up to its current sha. A ref whose project.json says `moved_to`
// (renamed or merged away) indexes as empty, so its old content never shows up twice.
// Returns { ref, sha, changed, files }.
export function syncRef(idx, repoDir, ref) {
  const sha = readRef(repoDir, ref);
  const known = stmt(idx, 'SELECT sha FROM refs WHERE ref = ?').get(ref);
  if (known && (known.sha || null) === (sha || null)) return { ref, sha, changed: false, files: 0 };
  const snapshot = snapshotRef(repoDir, ref);
  const info = parseJson(snapshot.read('project.json') || 'null', null);
  const movedTo = typeof info?.moved_to === 'string' ? info.moved_to : null;
  const current = movedTo ? new Map() : indexedFiles(snapshot);
  let files = 0;
  idx.db.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have synced this ref while this one waited for the write lock.
    const again = stmt(idx, 'SELECT sha FROM refs WHERE ref = ?').get(ref);
    if (!(again && (again.sha || null) === (sha || null))) {
      const indexed = new Map(stmt(idx, 'SELECT path, sha FROM files WHERE ref = ?').all(ref).map(r => [r.path, r.sha]));
      for (const filePath of indexed.keys()) if (!current.has(filePath)) { removeFile(idx, ref, filePath); files++; }
      for (const [filePath, blobSha] of current) {
        if (indexed.get(filePath) === blobSha) continue;
        indexFile(idx, ref, snapshot, filePath, blobSha);
        files++;
      }
      stmt(idx, 'INSERT OR REPLACE INTO refs(ref, sha, seq, moved_to) VALUES (?,?,?,?)').run(ref, sha, snapshot.seq, movedTo);
      for (const hook of idx.hooks) hook.afterSync?.(idx, ref);
      // Documents changed without the vector layer attached: its chunks are stale until rebuilt.
      if (files && !idx.hooks.some(hook => hook.vectors)) stmt(idx, "DELETE FROM meta WHERE key = 'vector_model'").run();
    }
    idx.db.exec('COMMIT');
  } catch (err) {
    try { idx.db.exec('ROLLBACK'); } catch {}
    throw err;
  }
  return { ref, sha, changed: true, files };
}

export function projectRefs(repoDir) {
  return listRefs(repoDir, 'refs/heads/p');
}

// Syncs every project ref (and the personal ref) and drops refs that no longer exist.
export function syncAll(idx, repoDir) {
  const refs = [...projectRefs(repoDir), PERSONAL_REF];
  const results = refs.map(ref => syncRef(idx, repoDir, ref));
  const live = new Set(refs);
  for (const row of stmt(idx, 'SELECT ref FROM refs').all()) {
    if (live.has(row.ref)) continue;
    idx.db.exec('BEGIN IMMEDIATE');
    try {
      for (const file of stmt(idx, 'SELECT path FROM files WHERE ref = ?').all(row.ref)) removeFile(idx, row.ref, file.path);
      stmt(idx, 'DELETE FROM refs WHERE ref = ?').run(row.ref);
      idx.db.exec('COMMIT');
    } catch (err) { try { idx.db.exec('ROLLBACK'); } catch {} throw err; }
  }
  return results;
}

// Live (not moved) project refs as known to the index after a sync.
export function liveProjectRefs(idx) {
  return stmt(idx, "SELECT ref FROM refs WHERE ref LIKE 'refs/heads/p/%' AND moved_to IS NULL ORDER BY ref").all().map(r => r.ref);
}

// FTS5 query text: every term quoted (so no FTS syntax can leak in), terms of four or more
// characters also match as a prefix, which covers suffixed forms such as "dosya" → "dosyaları".
export function ftsQuery(queryTerms) {
  return queryTerms.map(t => t.replace(/"/g, '')).filter(Boolean)
    .map(t => (t.length >= 4 ? `"${t}"*` : `"${t}"`)).join(' OR ');
}

// The ref is stored as one indexed token in its own column, so FTS5 restricts a query to the
// wanted refs through its index instead of ranking every project's matches and filtering after.
export function refToken(ref) {
  return 'r' + crypto.createHash('sha1').update(ref).digest('hex').slice(0, 16);
}

function rowToDoc(row) {
  return { id: row.id, ref: row.ref, doc_id: row.doc_id, kind: row.kind, sid: row.sid, n: row.n, seq: row.seq, cwd: row.cwd,
    ts: row.ts, data: parseJson(row.data, {}), body: row.body, rank: row.rank };
}

// Ranked documents (best first) in the given refs. Only the top rows are joined with docs.
export function queryDocs(idx, { refs, queryTerms, limit = 50 }) {
  if (!refs.length || !queryTerms.length) return [];
  const terms = ftsQuery(queryTerms);
  if (!terms) return [];
  const match = `refkey : (${refs.map(ref => `"${refToken(ref)}"`).join(' OR ')}) AND body : (${terms})`;
  const top = stmt(idx, 'SELECT rowid AS id, bm25(docs_fts, 1.0, 0.0) AS rank FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?')
    .all(match, limit);
  if (!top.length) return [];
  const rows = new Map(docsByIds(idx, top.map(t => t.id)).map(d => [d.id, d]));
  return top.map(t => rows.get(t.id) && { ...rows.get(t.id), rank: t.rank }).filter(Boolean);
}

export function docsByIds(idx, ids) {
  if (!ids.length) return [];
  return idx.db.prepare(`SELECT * FROM docs WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(rowToDoc);
}

export function indexStats(idx) {
  return {
    refs: stmt(idx, 'SELECT count(*) AS n FROM refs').get().n,
    docs: stmt(idx, 'SELECT count(*) AS n FROM docs').get().n,
    chunks: stmt(idx, 'SELECT count(*) AS n FROM chunks').get().n
  };
}
