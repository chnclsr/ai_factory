// Optional vector layer over the derived index (memory.vector.enabled, off by default).
//
// Embeddings are local and deterministic: words and character trigrams, feature-hashed into a
// fixed number of dimensions and L2-normalised. No model, no network, no dependency. They catch
// what term matching misses most in this project: Turkish words with different suffixes and typos.
// Every vector is stored with its {provider, model, dim}; a mismatch rebuilds the chunk table.
//
// Search is brute force while a ref has fewer chunks than ann_threshold. Above it, an IVF index
// (k-means centroids, each chunk filed under its nearest one) scores only the closest lists.
//
// ChunkSplice: documents are split into chunks on sentence boundaries; retrieval works per chunk,
// and the hit chunks of one document are spliced back into contiguous spans, so the block quotes
// the part of a long note that matched instead of its first lines.

import crypto from 'node:crypto';
import { stmt, addIndexHook } from './fts.mjs';

export const VECTOR_DEFAULTS = Object.freeze({
  enabled: false,
  dim: 256,
  chunk_chars: 600,
  ann_threshold: 4000,
  nprobe: 8,
  min_similarity: 0.2,
  fts_weight: 0.7
});

export const EMBEDDER = Object.freeze({ provider: 'local', model: 'hash-ngram-v1' });

export function vectorSettings(config) {
  const out = { ...VECTOR_DEFAULTS };
  for (const key of Object.keys(VECTOR_DEFAULTS)) {
    const value = config?.[key];
    if (key === 'enabled') out.enabled = value === true;
    else if (key === 'fts_weight') { if (Number.isFinite(value) && value >= 0 && value <= 1) out[key] = value; }
    else if (Number.isFinite(value) && value > 0) out[key] = value;
  }
  out.dim = Math.max(32, Math.min(2048, Math.round(out.dim)));
  return out;
}

function signature(settings) {
  return `${EMBEDDER.provider}/${EMBEDDER.model}/${settings.dim}/${settings.chunk_chars}`;
}

// ── Embedding ────────────────────────────────────────────────────────────────────────────────

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function fold(text) {
  return String(text || '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function embed(text, dim = VECTOR_DEFAULTS.dim) {
  const vec = new Float32Array(dim);
  const add = (feature, weight) => {
    const h = fnv1a(feature);
    vec[h % dim] += (h & 0x80000000 ? -1 : 1) * weight;
  };
  for (const word of fold(text).match(/[\p{L}\p{N}]{2,}/gu) || []) {
    add(`w:${word}`, 1);
    const padded = `<${word}>`;
    for (let i = 0; i + 3 <= padded.length; i++) add(`g:${padded.slice(i, i + 3)}`, 0.5);
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

const toBlob = vec => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
const fromBlob = blob => new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

// ── Chunking ─────────────────────────────────────────────────────────────────────────────────

// Splits text into consecutive chunks of at most `size` characters, cutting after a sentence end
// or line break when one falls in the second half of the window. Chunks cover the text exactly.
export function chunkText(text, size = VECTOR_DEFAULTS.chunk_chars) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const window = text.slice(start + Math.floor(size / 2), end);
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf('! '), window.lastIndexOf('? '));
      if (cut >= 0) end = start + Math.floor(size / 2) + cut + 1;
    }
    const piece = text.slice(start, end);
    if (piece.trim()) chunks.push({ ord: chunks.length, start, end, text: piece });
    start = end;
  }
  return chunks;
}

// ChunkSplice: hit chunk ordinals of one document become contiguous spans; each span's text is
// the original body between its first chunk's start and last chunk's end.
export function spliceChunks(body, hits) {
  const sorted = [...hits].sort((a, b) => a.ord - b.ord);
  const spans = [];
  for (const hit of sorted) {
    const last = spans.at(-1);
    if (last && hit.ord <= last.lastOrd + 1) { last.lastOrd = hit.ord; last.end = Math.max(last.end, hit.end); last.score = Math.max(last.score, hit.score); }
    else spans.push({ firstOrd: hit.ord, lastOrd: hit.ord, start: hit.start, end: hit.end, score: hit.score });
  }
  return spans.map(span => ({ ...span, text: body.slice(span.start, span.end) }));
}

// ── IVF index above the threshold ───────────────────────────────────────────────────────────
//
// Spherical k-means centroids per ref, trained on a sample; every chunk is filed under its nearest
// centroid (its "list"). A query scores the centroids and brute-forces only the `nprobe` closest
// lists. New chunks are filed under the existing centroids; the ref is retrained once it has
// doubled since the last training, and trained for the first time when it crosses ann_threshold.

const TRAIN_SAMPLE = 4096;
const TRAIN_ROUNDS = 8;

function centroidsOf(idx, ref) {
  return stmt(idx, 'SELECT cid, vec FROM centroids WHERE ref = ? ORDER BY cid').all(ref).map(r => ({ cid: r.cid, vec: fromBlob(r.vec) }));
}

function nearest(centroids, vec) {
  let best = -1;
  let bestScore = -Infinity;
  for (const c of centroids) {
    const s = dot(c.vec, vec);
    if (s > bestScore) { bestScore = s; best = c.cid; }
  }
  return best;
}

function normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

// Deterministic sample and seeding (by chunk id), so a retrain on the same data gives the same lists.
export function trainRef(idx, settings, ref) {
  const ids = stmt(idx, 'SELECT id FROM chunks WHERE ref = ? ORDER BY id').all(ref).map(r => r.id);
  if (!ids.length) return 0;
  const step = Math.max(1, Math.floor(ids.length / TRAIN_SAMPLE));
  const sample = [];
  for (let i = 0; i < ids.length && sample.length < TRAIN_SAMPLE; i += step) {
    sample.push(fromBlob(stmt(idx, 'SELECT vec FROM chunks WHERE id = ?').get(ids[i]).vec));
  }
  const k = Math.max(1, Math.min(sample.length, Math.round(Math.sqrt(ids.length))));
  let centroids = Array.from({ length: k }, (_, i) => ({ cid: i, vec: Float32Array.from(sample[Math.floor(i * sample.length / k)]) }));
  for (let round = 0; round < TRAIN_ROUNDS; round++) {
    const sums = centroids.map(() => new Float32Array(settings.dim));
    const counts = new Array(k).fill(0);
    for (const vec of sample) {
      const cid = nearest(centroids, vec);
      counts[cid]++;
      const sum = sums[cid];
      for (let d = 0; d < vec.length; d++) sum[d] += vec[d];
    }
    // An empty cluster keeps its centroid instead of collapsing to zero.
    centroids = centroids.map((c, i) => ({ cid: i, vec: counts[i] ? normalize(sums[i]) : c.vec }));
  }
  stmt(idx, 'DELETE FROM centroids WHERE ref = ?').run(ref);
  for (const c of centroids) stmt(idx, 'INSERT INTO centroids(ref, cid, vec) VALUES (?, ?, ?)').run(ref, c.cid, toBlob(c.vec));
  for (const row of stmt(idx, 'SELECT id, vec FROM chunks WHERE ref = ?').all(ref)) {
    stmt(idx, 'UPDATE chunks SET list = ? WHERE id = ?').run(nearest(centroids, fromBlob(row.vec)), row.id);
  }
  stmt(idx, 'INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(`ivf:${ref}`, String(ids.length));
  return k;
}

function trainedSize(idx, ref) {
  const row = stmt(idx, 'SELECT value FROM meta WHERE key = ?').get(`ivf:${ref}`);
  return row ? Number(row.value) : 0;
}

// Trains a ref whose chunk count crossed the threshold or doubled since its last training.
function maintainRefs(idx, settings, refs) {
  for (const ref of refs) {
    const count = stmt(idx, 'SELECT count(*) AS n FROM chunks WHERE ref = ?').get(ref).n;
    const trained = trainedSize(idx, ref);
    if (count >= settings.ann_threshold && (!trained || count >= trained * 2)) trainRef(idx, settings, ref);
  }
}

// ── Keeping chunks in step with documents ────────────────────────────────────────────────────

function addDocChunks(idx, settings, state, doc) {
  let centroids = state.centroids.get(doc.ref);
  if (centroids === undefined) { centroids = centroidsOf(idx, doc.ref); state.centroids.set(doc.ref, centroids); }
  for (const chunk of chunkText(doc.body, settings.chunk_chars)) {
    const vec = embed(chunk.text, settings.dim);
    const key = crypto.createHash('sha1').update(chunk.text).digest('hex').slice(0, 16);
    stmt(idx, 'INSERT INTO chunks(doc, ref, ord, start, end, key, provider, model, dim, vec, list) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(doc.id, doc.ref, chunk.ord, chunk.start, chunk.end, key, EMBEDDER.provider, EMBEDDER.model, settings.dim, toBlob(vec),
        centroids.length ? nearest(centroids, vec) : null);
  }
  state.touched.add(doc.ref);
}

function removeDocChunks(idx, docId) {
  stmt(idx, 'DELETE FROM chunks WHERE doc = ?').run(docId);
}

// Registers the chunk hooks on an open index and rebuilds every chunk when the stored vectors
// were made with other settings, or when documents changed while vectors were off.
export function attachVectors(idx, settings) {
  const sig = signature(settings);
  if (idx.vector?.sig === sig) return idx.vector;
  const state = { sig, settings, centroids: new Map(), touched: new Set() };
  idx.hooks = idx.hooks.filter(hook => !hook.vectors);
  addIndexHook(idx, {
    vectors: true,
    addDoc: (i, doc) => addDocChunks(i, settings, state, doc),
    removeDoc: (i, docId) => removeDocChunks(i, docId),
    removeFile: (i, ref, filePath) => {
      for (const row of stmt(i, 'SELECT id FROM docs WHERE ref = ? AND path = ?').all(ref, filePath)) removeDocChunks(i, row.id);
    },
    // Runs inside the sync transaction once a ref's documents are in step.
    afterSync: (i, ref) => {
      if (!state.touched.delete(ref)) return;
      maintainRefs(i, settings, [ref]);
      state.centroids.delete(ref);
    }
  });
  idx.vector = state;
  const stored = stmt(idx, "SELECT value FROM meta WHERE key = 'vector_model'").get()?.value;
  if (stored !== sig) {
    idx.db.exec('BEGIN IMMEDIATE');
    try {
      idx.db.exec('DELETE FROM chunks');
      idx.db.exec('DELETE FROM centroids');
      idx.db.exec("DELETE FROM meta WHERE key LIKE 'ivf:%'");
      for (const doc of stmt(idx, 'SELECT id, ref, body FROM docs ORDER BY id').all()) addDocChunks(idx, settings, state, doc);
      maintainRefs(idx, settings, [...state.touched]);
      state.touched.clear();
      state.centroids.clear();
      stmt(idx, "INSERT OR REPLACE INTO meta(key, value) VALUES ('vector_model', ?)").run(sig);
      idx.db.exec('COMMIT');
    } catch (err) {
      try { idx.db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }
  return state;
}

function scoreRows(rows, q) {
  return rows.map(row => ({ id: row.id, score: dot(q, fromBlob(row.vec)) }));
}

// Brute force below ann_threshold (or before the first training), the nprobe closest IVF lists above.
function scoreRef(idx, settings, ref, q, { exact = false } = {}) {
  const trained = !exact && trainedSize(idx, ref) > 0;
  if (!trained) return scoreRows(stmt(idx, 'SELECT id, vec FROM chunks WHERE ref = ?').all(ref), q);
  const lists = centroidsOf(idx, ref).map(c => ({ cid: c.cid, s: dot(c.vec, q) })).sort((a, b) => b.s - a.s)
    .slice(0, settings.nprobe).map(c => c.cid);
  const rows = idx.db.prepare(`SELECT id, vec FROM chunks WHERE ref = ? AND (list IN (${lists.map(() => '?').join(',')}) OR list IS NULL)`)
    .all(ref, ...lists);
  return scoreRows(rows, q);
}

// Best chunks for `query` across `refs`: [{ id, doc, ord, start, end, score }] best first.
export function vectorSearch(idx, { refs, query, k = 40 }) {
  const state = idx.vector;
  if (!state) return [];
  const q = embed(query, state.settings.dim);
  const scored = refs.flatMap(ref => scoreRef(idx, state.settings, ref, q));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k).filter(s => s.score >= state.settings.min_similarity);
  if (!top.length) return [];
  const rows = new Map(idx.db.prepare(`SELECT id, doc, ord, start, end FROM chunks WHERE id IN (${top.map(() => '?').join(',')})`)
    .all(...top.map(t => t.id)).map(r => [r.id, r]));
  return top.map(t => rows.get(t.id) && { ...rows.get(t.id), score: t.score }).filter(Boolean);
}

// Share of the IVF top k that brute force would also return. Chunks with identical vectors tie,
// so an answer counts when its score reaches brute force's k-th score.
export function annRecall(idx, { ref, queries, k = 10 }) {
  const { settings } = idx.vector;
  let hit = 0;
  let total = 0;
  for (const text of queries) {
    const q = embed(text, settings.dim);
    const exact = scoreRef(idx, settings, ref, q, { exact: true }).map(r => r.score).sort((a, b) => b - a).slice(0, k);
    const approx = scoreRef(idx, settings, ref, q).sort((a, b) => b.score - a.score).slice(0, k);
    const kth = exact.at(-1) ?? Infinity;
    hit += approx.filter(r => r.score >= kth - 1e-6).length;
    total += exact.length;
  }
  return total ? hit / total : 1;
}
