// Git object writer and ref compare-and-swap, without spawning git.
//
// Loose objects only: blobs, trees and commits are SHA-1 addressed, zlib-deflated and written
// atomically (tmp + rename). Refs are updated with git's own lock protocol: "<ref>.lock" is
// created with O_EXCL, the old value is checked while the lock is held, the new value is fsynced
// into the lock file and the lock is renamed over the ref. Every path written inside the repo
// uses "/" internally; only the final fs call converts through path.join.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const AUTHOR = 'ai-factory <ai-factory@localhost>';
const ZERO_SHA = /^[0-9a-f]{40}$/;
const LOCK_STALE_MS = 30000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, Math.max(0, ms));
}

// Windows refuses rename while another process holds the target open; retry briefly.
export function renameWithRetry(from, to, attempts = 12) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (err) {
      if (i >= attempts || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      sleepSync(5 + Math.floor(Math.random() * 15));
    }
  }
}

export function initRepo(repoDir) {
  if (fs.existsSync(path.join(repoDir, 'HEAD'))) return repoDir;
  for (const dir of ['objects/info', 'objects/pack', 'refs/heads', 'refs/tags', 'info']) {
    fs.mkdirSync(path.join(repoDir, dir), { recursive: true, mode: 0o700 });
  }
  // gc.auto=0: this writer reads loose objects only, so git must never pack them on its own.
  fs.writeFileSync(path.join(repoDir, 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n[gc]\n\tauto = 0\n');
  fs.writeFileSync(path.join(repoDir, 'description'), 'ai-factory memory\n');
  fs.writeFileSync(path.join(repoDir, 'HEAD'), 'ref: refs/heads/main\n');
  return repoDir;
}

function objectPath(repoDir, sha) {
  return path.join(repoDir, 'objects', sha.slice(0, 2), sha.slice(2));
}

export function hashObject(type, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const store = Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'latin1'), body]);
  return { sha: crypto.createHash('sha1').update(store).digest('hex'), store, body };
}

// Objects are created in place with O_EXCL instead of tmp + rename: on Windows each rename costs
// about 1.5 ms under real-time scanning, which alone would exceed the write budget. Safety comes
// from ordering, not from per-object atomicity: the ref only moves after every object is written,
// so a crash leaves at most unreferenced debris. A crash-truncated file is detected by size (zlib
// output for identical input is identical) and rewritten before anything references it again.
export function writeObject(repoDir, type, content) {
  const { sha, store, body } = hashObject(type, content);
  rememberObject(repoDir, sha, { type, content: body });
  const file = objectPath(repoDir, sha);
  const data = zlib.deflateSync(store, { level: 1 });
  try {
    if (fs.statSync(file).size === data.length) return sha;
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    fs.writeFileSync(file, data, { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return sha;
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, data, { flag: 'wx' }); } catch (again) { if (again.code !== 'EEXIST') throw again; }
  }
  return sha;
}

const objectCache = new Map();

// Objects are immutable, so anything written or read once in this process is served from memory.
function rememberObject(repoDir, sha, object) {
  if (objectCache.size > 8192) objectCache.clear();
  const key = repoDir + '|' + sha;
  if (!objectCache.has(key)) objectCache.set(key, object);
}

export function readObject(repoDir, sha) {
  const key = repoDir + '|' + sha;
  const cached = objectCache.get(key);
  if (cached) return cached;
  let raw;
  for (let attempt = 0; ; attempt++) {
    try {
      raw = zlib.inflateSync(fs.readFileSync(objectPath(repoDir, sha)));
      break;
    } catch (err) {
      if (err.code === 'ENOENT') { raw = readPackedObject(repoDir, sha); break; }
      // A concurrent writer may still be finishing this exact object.
      if (attempt >= 3 || !String(err.code || '').startsWith('Z_')) throw err;
      sleepSync(5);
    }
  }
  const nul = raw.indexOf(0);
  const [type] = raw.subarray(0, nul).toString('latin1').split(' ');
  const object = { type, content: raw.subarray(nul + 1) };
  rememberObject(repoDir, sha, object);
  return object;
}

// Only reached if someone ran `git gc` on the memory repo by hand. Correctness over speed here.
function readPackedObject(repoDir, sha) {
  const typeRun = spawnSync('git', ['--git-dir', repoDir, 'cat-file', '-t', sha], { encoding: 'utf8' });
  if (typeRun.status !== 0) throw new Error(`object not found: ${sha}`);
  const type = typeRun.stdout.trim();
  const body = spawnSync('git', ['--git-dir', repoDir, 'cat-file', type, sha]).stdout;
  return Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'latin1'), body]);
}

export function writeBlob(repoDir, content) {
  return writeObject(repoDir, 'blob', content);
}

// Git orders tree entries bytewise, comparing a directory name as if it ended in "/".
function treeSortKey(entry) {
  return Buffer.from(entry.mode === '40000' ? entry.name + '/' : entry.name, 'utf8');
}

export function validEntryName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' &&
    name.toLowerCase() !== '.git' && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

export function writeTree(repoDir, entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts = [];
  for (const entry of sorted) {
    if (!validEntryName(entry.name)) throw new Error(`invalid tree entry name: ${entry.name}`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.sha, 'hex'));
  }
  return writeObject(repoDir, 'tree', Buffer.concat(parts));
}

export function parseTree(content) {
  const entries = [];
  let i = 0;
  while (i < content.length) {
    const space = content.indexOf(0x20, i);
    const nul = content.indexOf(0, space);
    entries.push({
      mode: content.subarray(i, space).toString('latin1'),
      name: content.subarray(space + 1, nul).toString('utf8'),
      sha: content.subarray(nul + 1, nul + 21).toString('hex')
    });
    i = nul + 21;
  }
  return entries;
}

export function readTree(repoDir, sha) {
  if (!sha) return [];
  const object = readObject(repoDir, sha);
  if (object.type !== 'tree') throw new Error(`not a tree: ${sha}`);
  if (!object.entries) object.entries = parseTree(object.content);
  return object.entries;
}

export function writeCommit(repoDir, { tree, parents = [], message, time = Date.now() }) {
  const stamp = `${Math.floor(time / 1000)} +0000`;
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${AUTHOR} ${stamp}\ncommitter ${AUTHOR} ${stamp}\n\n`;
  text += message.endsWith('\n') ? message : message + '\n';
  return writeObject(repoDir, 'commit', text);
}

export function parseCommit(content) {
  const text = content.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = text.slice(0, split);
  const message = text.slice(split + 2);
  const commit = { tree: null, parents: [], message, trailers: {} };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5);
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7));
  }
  const paragraphs = message.trimEnd().split('\n\n');
  for (const line of paragraphs.at(-1).split('\n')) {
    const match = line.match(/^([A-Za-z-]+): (.*)$/);
    if (match) commit.trailers[match[1]] = match[2];
  }
  commit.seq = Number(commit.trailers.Seq || 0);
  return commit;
}

export function readCommit(repoDir, sha) {
  const object = readObject(repoDir, sha);
  if (object.type !== 'commit') throw new Error(`not a commit: ${sha}`);
  if (!object.commit) object.commit = parseCommit(object.content);
  return object.commit;
}

// Walks a "/"-separated path from a tree; returns { mode, sha } or null.
export function lookupPath(repoDir, treeSha, filePath) {
  let entry = { mode: '40000', sha: treeSha };
  for (const name of filePath.split('/').filter(Boolean)) {
    if (!entry || entry.mode !== '40000' || !entry.sha) return null;
    entry = readTree(repoDir, entry.sha).find(item => item.name === name) || null;
  }
  return entry;
}

export function readPath(repoDir, treeSha, filePath) {
  const entry = treeSha ? lookupPath(repoDir, treeSha, filePath) : null;
  if (!entry || entry.mode === '40000') return null;
  return readObject(repoDir, entry.sha).content;
}

// Applies { "a/b.txt": blobSha | null } to a tree and returns the new root tree sha.
export function applyChanges(repoDir, baseTree, changes) {
  const direct = new Map();
  const nested = new Map();
  for (const [filePath, sha] of changes) {
    const slash = filePath.indexOf('/');
    if (slash < 0) direct.set(filePath, sha);
    else {
      const head = filePath.slice(0, slash);
      if (!nested.has(head)) nested.set(head, new Map());
      nested.get(head).set(filePath.slice(slash + 1), sha);
    }
  }
  const entries = new Map(readTree(repoDir, baseTree).map(entry => [entry.name, entry]));
  for (const [name, sha] of direct) {
    if (sha === null) entries.delete(name);
    else entries.set(name, { mode: '100644', name, sha });
  }
  for (const [name, subChanges] of nested) {
    const current = entries.get(name);
    const subTree = applyChanges(repoDir, current?.mode === '40000' ? current.sha : null, subChanges);
    if (subTree) entries.set(name, { mode: '40000', name, sha: subTree });
    else entries.delete(name);
  }
  if (entries.size === 0) return null;
  return writeTree(repoDir, [...entries.values()]);
}

export function refFile(repoDir, refName) {
  return path.join(repoDir, ...refName.split('/'));
}

export function readRef(repoDir, refName) {
  try {
    const value = fs.readFileSync(refFile(repoDir, refName), 'utf8').trim();
    return ZERO_SHA.test(value) ? value : null;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    for (const line of fs.readFileSync(path.join(repoDir, 'packed-refs'), 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === refName && ZERO_SHA.test(sha)) return sha;
    }
  } catch {}
  return null;
}

export function listRefs(repoDir, prefix) {
  const base = refFile(repoDir, prefix);
  const out = [];
  const walk = (dir, rel) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of names) {
      if (item.name.endsWith('.lock')) continue;
      const nextRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) walk(path.join(dir, item.name), nextRel);
      else out.push(`${prefix}/${nextRel}`);
    }
  };
  walk(base, '');
  return out.sort();
}

function acquireLock(lockFile, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let delay = 1;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (;;) {
    try {
      return fs.openSync(lockFile, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      try {
        // A writer that crashed while holding the lock leaves it behind.
        if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockFile); continue; }
      } catch {}
      if (Date.now() > deadline) throw new Error(`ref lock busy: ${lockFile}`);
      sleepSync(delay + Math.floor(Math.random() * delay * 2));
      delay = Math.min(delay * 2, 25);
    }
  }
}

// Serialises writers on one ref. build(oldSha) runs while the lock is held and returns the new
// commit sha (or null to leave the ref as is). The old value is re-read under the lock, so a
// writer can never move a ref from a value it did not build on.
export function updateRefLocked(repoDir, refName, build, { lockTimeoutMs = 10000 } = {}) {
  const file = refFile(repoDir, refName);
  const lockFile = file + '.lock';
  const fd = acquireLock(lockFile, lockTimeoutMs);
  let renamed = false;
  try {
    const oldSha = readRef(repoDir, refName);
    const newSha = build(oldSha);
    if (!newSha) return { oldSha, newSha: oldSha, changed: false };
    fs.writeSync(fd, newSha + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    renameWithRetry(lockFile, file);
    renamed = true;
    return { oldSha, newSha, changed: true };
  } finally {
    if (!renamed) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
}

// Plain compare-and-swap for callers that already know the expected old value.
export function compareAndSwapRef(repoDir, refName, expectedOld, newSha) {
  let mismatch = false;
  updateRefLocked(repoDir, refName, current => {
    if ((current || null) !== (expectedOld || null)) { mismatch = true; return null; }
    return newSha;
  });
  return !mismatch;
}
