// Per-project ordered commit chain on top of gitobj.
//
// Every write is one commit on refs/heads/p/<project>. The tree is rebuilt on top of whatever the
// ref points to while the ref lock is held, so concurrent writers serialise and none is lost; the
// `Seq:` trailer is the chain height and therefore the project's total order.

import crypto from 'node:crypto';
import {
  initRepo, writeBlob, readPath, lookupPath, readTree, applyChanges, writeCommit, readCommit,
  readRef, updateRefLocked, listRefs
} from './gitobj.mjs';
import { projectRef, PERSONAL_REF } from './project.mjs';
import { sanitizeText } from './sanitize.mjs';

export function uuidv7(now = Date.now()) {
  const bytes = crypto.randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function refForScope(projectKey, scope = 'repo') {
  return scope === 'mine' ? PERSONAL_REF : projectRef(projectKey);
}

export function openRepo(repoDir) {
  initRepo(repoDir);
  return repoDir;
}

// Read-only snapshot of a ref: { sha, tree, seq, read(path), list(dir) }. No git process.
export function snapshotRef(repoDir, refName) {
  const sha = readRef(repoDir, refName);
  const commit = sha ? readCommit(repoDir, sha) : null;
  const tree = commit ? commit.tree : null;
  return {
    sha,
    tree,
    seq: commit ? commit.seq : 0,
    commit,
    read(filePath) {
      const buffer = tree ? readPath(repoDir, tree, filePath) : null;
      return buffer ? buffer.toString('utf8') : null;
    },
    list(dir) {
      const entry = tree ? (dir ? lookupPath(repoDir, tree, dir) : { mode: '40000', sha: tree }) : null;
      return entry && entry.mode === '40000' ? readTree(repoDir, entry.sha) : [];
    },
    blobSha(filePath) {
      const entry = tree ? lookupPath(repoDir, tree, filePath) : null;
      return entry && entry.mode !== '40000' ? entry.sha : null;
    }
  };
}

export function snapshotProject(repoDir, projectKey, scope = 'repo') {
  return snapshotRef(repoDir, refForScope(projectKey, scope));
}

// Walks first parents from `sha` back to (but excluding) the commit whose Seq is `afterSeq`.
// Returns oldest-first [{ sha, commit }]. Bounded by `limit` so a huge gap stays cheap.
export function commitsAfter(repoDir, sha, afterSeq, limit = 200) {
  const out = [];
  let current = sha;
  while (current && out.length < limit) {
    const commit = readCommit(repoDir, current);
    if (commit.seq <= afterSeq) break;
    out.push({ sha: current, commit });
    current = commit.parents[0];
  }
  return out.reverse();
}

// Runs mutate(view) under the ref lock and commits the result. view.write/append values are
// sanitised here, so nothing reaches disk unsanitised. Returns { sha, seq, changed, result }.
export function commitTo(repoDir, refName, { subject, trailers = {}, time = Date.now() }, mutate) {
  openRepo(repoDir);
  let outcome = null;
  const update = updateRefLocked(repoDir, refName, oldSha => {
    const parent = oldSha ? readCommit(repoDir, oldSha) : null;
    const baseTree = parent ? parent.tree : null;
    const seq = (parent ? parent.seq : 0) + 1;
    const changes = new Map();
    const pending = new Map();
    const view = {
      seq,
      parentSha: oldSha,
      read(filePath) {
        if (pending.has(filePath)) return pending.get(filePath);
        const buffer = baseTree ? readPath(repoDir, baseTree, filePath) : null;
        return buffer ? buffer.toString('utf8') : null;
      },
      blobSha(filePath) {
        if (changes.has(filePath)) return changes.get(filePath);
        const entry = baseTree ? lookupPath(repoDir, baseTree, filePath) : null;
        return entry && entry.mode !== '40000' ? entry.sha : null;
      },
      list(dir) {
        const entry = baseTree ? (dir ? lookupPath(repoDir, baseTree, dir) : { mode: '40000', sha: baseTree }) : null;
        return entry && entry.mode === '40000' ? readTree(repoDir, entry.sha) : [];
      },
      write(filePath, text, { maxBytes = 1048576 } = {}) {
        const clean = sanitizeText(text, { maxBytes });
        pending.set(filePath, clean);
        changes.set(filePath, writeBlob(repoDir, clean));
      },
      // Appends one already-serialised JSON line (sanitised by the caller via sanitizeValue).
      appendLine(filePath, line, { maxBytes = 65536 } = {}) {
        const current = view.read(filePath) || '';
        const clean = sanitizeText(line, { maxBytes }).replace(/\n/g, ' ');
        view.writeRaw(filePath, current + clean + '\n');
      },
      // For content already produced by sanitizeText in this call.
      writeRaw(filePath, text) {
        pending.set(filePath, text);
        changes.set(filePath, writeBlob(repoDir, text));
      },
      remove(filePath) {
        pending.delete(filePath);
        changes.set(filePath, null);
      }
    };
    const result = mutate(view);
    if (result === false || changes.size === 0) { outcome = { result, seq: parent ? parent.seq : 0 }; return null; }
    const tree = applyChanges(repoDir, baseTree, changes) || writeEmptyTree(repoDir);
    const allTrailers = { Seq: String(seq), ...trailers };
    const trailerText = Object.entries(allTrailers)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}: ${sanitizeText(String(value), { maxBytes: 200 }).replace(/\s+/g, ' ')}`).join('\n');
    const message = `${sanitizeText(subject, { maxBytes: 200 }).replace(/\s+/g, ' ')}\n\n${trailerText}\n`;
    const sha = writeCommit(repoDir, { tree, parents: oldSha ? [oldSha] : [], message, time });
    outcome = { result, seq };
    return sha;
  });
  return { sha: update.newSha, seq: outcome.seq, changed: update.changed, result: outcome.result };
}

function writeEmptyTree(repoDir) {
  return applyChanges(repoDir, null, new Map([['.keep', writeBlob(repoDir, '')]]));
}

export function commitProject(repoDir, projectKey, meta, mutate, scope = 'repo') {
  return commitTo(repoDir, refForScope(projectKey, scope), meta, mutate);
}

export function listProjects(repoDir) {
  return listRefs(repoDir, 'refs/heads/p').map(ref => ref.slice('refs/heads/p/'.length));
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────

export function parseFrontMatter(text) {
  const match = String(text || '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: String(text || '') };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: match[2] };
}

export function formatFrontMatter(meta, body) {
  const lines = Object.entries(meta).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, ' ')}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

export function pageSlug(value) {
  const slug = String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 100);
  if (!slug) throw new Error('invalid page slug');
  return slug;
}

// Writes pages/<slug>.md. `base` is the blob sha the editor read; when it no longer matches the
// stored page, the stored version is kept as pages/<slug>.v<N>.md and the new text becomes
// version N+1 with `supersedes` and `conflict_with` recorded. Nothing is deleted.
export function writePage(repoDir, projectKey, { slug, body, base = null, session = '', cwd = '', scope = 'repo' }) {
  const name = pageSlug(slug);
  const file = `pages/${name}.md`;
  return commitProject(repoDir, projectKey, { subject: `page ${name}`, trailers: { Session: session, Kind: 'page' } }, view => {
    const currentSha = view.blobSha(file);
    const current = currentSha ? parseFrontMatter(view.read(file)) : null;
    const version = current ? Number(current.meta.version || 1) : 0;
    // seq lets a resumed engine session skip pages it has already been shown.
    const meta = { version: version + 1, seq: view.seq, session, cwd, updated: new Date().toISOString() };
    if (current) meta.supersedes = base || currentSha;
    if (current && base && base !== currentSha) {
      meta.conflict_with = currentSha;
      view.writeRaw(`pages/${name}.v${version}.md`, view.read(file));
    }
    view.write(file, formatFrontMatter(meta, body), { maxBytes: 262144 });
    return { file, version: version + 1, conflict: Boolean(meta.conflict_with) };
  }, scope);
}
