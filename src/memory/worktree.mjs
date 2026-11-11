// Before/after snapshots of the user's project, so a turn records only the changes made during it.
//
// In a git repository the snapshot is a tree written through a temporary GIT_INDEX_FILE seeded
// from the real index: `git add -A` then `git write-tree`. The user's index and working tree are
// never touched, .gitignore is honoured and untracked files are included. Outside git, a bounded
// walk records path, size and mtime. Any failure or a blown time budget yields "unavailable";
// the turn is still recorded.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { findGitRepo } from './project.mjs';

const DEFAULT_BUDGET_MS = 2000;
const MAX_FS_FILES = 20000;
const MAX_PATCH_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.runtime']);

// Settings that change diff or apply output are pinned so the stored patch always has a/ b/
// prefixes and no colour, whatever the user's git config says.
const GIT_PINNED = ['-c', 'core.quotepath=off', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  '-c', 'color.ui=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false'];

function runGit(cwd, args, { env = {}, deadline, input } = {}) {
  const timeout = Math.max(1, deadline - Date.now());
  const result = spawnSync('git', [...GIT_PINNED, ...args], {
    cwd, input, encoding: 'buffer', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...env }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim().slice(0, 300)}`);
  return result.stdout;
}

function excludeSpecs(ignorePaths) {
  return (ignorePaths || []).filter(p => typeof p === 'string' && p.trim())
    .map(p => `:(exclude,glob)${p.replace(/\\/g, '/').replace(/\/$/, '/**')}`);
}

export function snapshotGit(repo, { ignorePaths = [], deadline }) {
  const tmpIndex = path.join(os.tmpdir(), `ai-factory-index-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    // Seeding from the real index reuses its stat cache, so unchanged files are not re-hashed.
    try { fs.copyFileSync(path.join(repo.gitDir, 'index'), tmpIndex); } catch {}
    const env = { GIT_INDEX_FILE: tmpIndex };
    runGit(repo.worktree, ['add', '-A', '--', '.', ...excludeSpecs(ignorePaths)], { env, deadline });
    const tree = runGit(repo.worktree, ['write-tree'], { env, deadline }).toString('utf8').trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('write-tree returned no tree');
    return { kind: 'git', root: repo.worktree, tree };
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch {}
  }
}

function matchesIgnore(rel, ignorePaths) {
  return ignorePaths.some(p => {
    const clean = String(p).replace(/\\/g, '/').replace(/\/$/, '');
    return clean && (rel === clean || rel.startsWith(clean + '/'));
  });
}

export function snapshotFs(root, { ignorePaths = [], deadline }) {
  const files = {};
  let count = 0;
  const stack = [''];
  while (stack.length) {
    if (Date.now() > deadline) throw new Error('file walk exceeded its time budget');
    const rel = stack.pop();
    let items;
    try { items = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const item of items) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (matchesIgnore(childRel, ignorePaths)) continue;
      if (item.isDirectory()) { if (!SKIP_DIRS.has(item.name)) stack.push(childRel); continue; }
      if (!item.isFile()) continue;
      if (++count > MAX_FS_FILES) return { kind: 'fs', root, files, truncated: true };
      try {
        const stat = fs.statSync(path.join(root, childRel));
        files[childRel] = [stat.size, Math.floor(stat.mtimeMs)];
      } catch {}
    }
  }
  return { kind: 'fs', root, files, truncated: false };
}

export function takeSnapshot(cwd, { ignorePaths = [], budgetMs = DEFAULT_BUDGET_MS, enabled = true } = {}) {
  if (!enabled) return { kind: 'off' };
  const deadline = Date.now() + budgetMs;
  try {
    const repo = findGitRepo(cwd);
    if (repo) return snapshotGit(repo, { ignorePaths, deadline });
    return snapshotFs(path.resolve(cwd), { ignorePaths, deadline });
  } catch (err) {
    return { kind: 'unavailable', reason: String(err.message || err).slice(0, 200) };
  }
}

// Parses `git diff --raw --numstat -z` output (raw records first, then numstat records).
export function parseRawNumstat(buffer) {
  const parts = buffer.toString('utf8').split('\0');
  const status = new Map();
  const counts = new Map();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith(':')) {
      const fields = part.slice(1).split(' ');
      status.set(parts[++i], fields[4]);
    } else if (/^(\d+|-)\t(\d+|-)\t/.test(part)) {
      const [add, del, name] = part.split('\t');
      counts.set(name, { add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del) });
    }
  }
  return [...status].map(([file, st]) => {
    const c = counts.get(file) || { add: null, del: null };
    return { path: file, status: st, add: c.add, del: c.del, binary: c.add === null };
  });
}

// Returns { files: [...], patch: string|null, patchTruncated } or { files: 'unavailable', reason }.
export function diffSnapshots(before, after, { budgetMs = DEFAULT_BUDGET_MS } = {}) {
  if (before?.kind === 'off' || after?.kind === 'off') return { files: [], patch: null, tracked: false };
  if (!before || !after || before.kind !== after.kind || before.kind === 'unavailable') {
    return { files: 'unavailable', reason: before?.reason || after?.reason || 'snapshot kinds differ' };
  }
  const deadline = Date.now() + budgetMs;
  try {
    if (before.kind === 'git') {
      if (before.tree === after.tree) return { files: [], patch: null };
      const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
      const files = parseRawNumstat(runGit(after.root, [...base, '--raw', '--numstat', '-z', before.tree, after.tree], { deadline }));
      for (const file of files) {
        if (file.binary && file.status !== 'D') {
          try { file.size = fs.statSync(path.join(after.root, file.path)).size; } catch {}
        }
      }
      let patch = runGit(after.root, [...base, '--src-prefix=a/', '--dst-prefix=b/', '-U3', before.tree, after.tree], { deadline }).toString('utf8');
      let patchTruncated = false;
      if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) {
        patch = Buffer.from(patch).subarray(0, MAX_PATCH_BYTES).toString('utf8');
        patchTruncated = true;
      }
      return { files, patch, patchTruncated };
    }
    const files = [];
    for (const [file, [size, mtime]] of Object.entries(after.files)) {
      const prior = before.files[file];
      if (!prior) files.push({ path: file, status: 'A', size });
      else if (prior[0] !== size || prior[1] !== mtime) files.push({ path: file, status: 'M', size });
    }
    for (const file of Object.keys(before.files)) if (!after.files[file]) files.push({ path: file, status: 'D' });
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, patch: null, truncatedWalk: Boolean(before.truncated || after.truncated) };
  } catch (err) {
    return { files: 'unavailable', reason: String(err.message || err).slice(0, 200) };
  }
}

// Reverses a stored patch in the user's working tree. Tries a plain reverse apply first (touches
// only the working tree); falls back to --3way, which uses the snapshot blobs already stored in
// the user's object database by `git add` and may update the index for conflicted paths.
export function revertPatch(root, patch, { check = false } = {}) {
  const deadline = Date.now() + 30000;
  const file = path.join(os.tmpdir(), `ai-factory-revert-${process.pid}-${crypto.randomBytes(4).toString('hex')}.patch`);
  fs.writeFileSync(file, patch);
  try {
    try {
      runGit(root, ['apply', '-R', '--check', file], { deadline });
      if (!check) runGit(root, ['apply', '-R', file], { deadline });
      return { ok: true, mode: 'reverse' };
    } catch (plain) {
      try {
        if (check) return { ok: true, mode: '3way' };
        runGit(root, ['apply', '-R', '--3way', file], { deadline });
        return { ok: true, mode: '3way' };
      } catch (threeWay) {
        return { ok: false, reason: String(threeWay.message || plain.message).slice(0, 400) };
      }
    }
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}
