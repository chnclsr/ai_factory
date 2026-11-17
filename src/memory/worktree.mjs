// Before/after snapshots of the user's project, so a turn records only the changes made during it.
// Also hosts the isolated-worktree helpers used to run agents in parallel on one repository.
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
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name)) continue;
        if (childRel === '.ai-factory/worktrees' || childRel.startsWith('.ai-factory/worktrees/')) continue;
        stack.push(childRel);
        continue;
      }
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

// ── Isolated worktrees ──────────────────────────────────────────────────────────────────────────
//
// Real `git worktree` isolation so several agents can work the same repository in parallel: each
// agent checks out its own linked worktree under <repo>/.ai-factory/worktrees/<name> on its own
// branch, and no one can overwrite another's files. The directory is ignored through the local
// .git/info/exclude (no tracked file is touched), so snapshots keep ignoring it too.

const WORKTREE_ROOT = '.ai-factory/worktrees';
const WORKTREE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WORKTREE_BUDGET_MS = 30000;
const WORKTREE_BRANCH_PREFIX = 'ai-factory/';

function worktreeDeadline() {
  return Date.now() + WORKTREE_BUDGET_MS;
}

// Accepts a repo handle ({ worktree, gitDir, commonDir } from findGitRepo) or a plain directory.
export function resolveWorktreeRepo(repo) {
  const handle = typeof repo === 'string' ? findGitRepo(repo) : repo;
  if (!handle || !handle.worktree) throw new Error('no git repository found');
  return handle;
}

export function isValidWorktreeName(name) {
  return typeof name === 'string' && WORKTREE_NAME_RE.test(name);
}

export function isValidGitRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return false;
  const trimmed = ref.trim();
  if (ref !== trimmed) return false;
  if (trimmed.startsWith('-') || trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.endsWith('.')) return false;
  if (trimmed.includes('..') || trimmed.includes('@{') || trimmed.includes('\\')) return false;
  if (/[\x00-\x1F\x7F :?*[]/.test(trimmed)) return false;
  if (trimmed.endsWith('.lock')) return false;
  return true;
}

export function samePath(a, b) {
  if (!a || !b) return false;
  const pa = path.resolve(a);
  const pb = path.resolve(b);
  return process.platform === 'win32'
    ? pa.toLowerCase() === pb.toLowerCase()
    : pa === pb;
}

export function pathStartsWith(target, parent) {
  if (!target || !parent) return false;
  const pt = path.resolve(target);
  const pp = path.resolve(parent);
  if (process.platform === 'win32') {
    const lt = pt.toLowerCase();
    const lp = pp.toLowerCase();
    return lt === lp || lt.startsWith(lp.endsWith(path.sep) ? lp : lp + path.sep);
  }
  return pt === pp || pt.startsWith(pp.endsWith(path.sep) ? pp : pp + path.sep);
}

export function worktreeRoot(repo) {
  const handle = resolveWorktreeRepo(repo);
  const mainWorktree = (handle.commonDir && !samePath(handle.gitDir, handle.commonDir))
    ? path.dirname(handle.commonDir)
    : handle.worktree;
  return path.join(mainWorktree, WORKTREE_ROOT);
}

export function worktreePath(repo, name) {
  if (!isValidWorktreeName(name)) throw new Error(`invalid worktree name: ${name}`);
  return path.join(worktreeRoot(repo), name);
}

function branchName(name) {
  return `${WORKTREE_BRANCH_PREFIX}${name}`;
}

// Keeps the internal worktree area out of the parent's status and snapshots. Local exclude only:
// .gitignore is a tracked file and its content belongs to the project, not to this tooling.
function ensureExcluded(repo) {
  const handle = resolveWorktreeRepo(repo);
  const excludeFile = path.join(handle.commonDir || handle.gitDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  let current = '';
  try { current = fs.readFileSync(excludeFile, 'utf8'); } catch {}
  const lines = new Set(current.split(/\r?\n/).map(l => l.trim()));
  const rule = `/${WORKTREE_ROOT}/`;
  if (!lines.has(rule)) {
    const addition = `# ai-factory isolated worktrees\n${rule}\n`;
    fs.appendFileSync(excludeFile, (current && !current.endsWith('\n') ? '\n' : '') + addition);
  }
}

// Parses `git worktree list --porcelain`: records separated by blank lines, one `key value` each.
export function parseWorktreeList(text) {
  const out = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) { if (current) out.push(current); current = null; continue; }
    const key = line.slice(0, line.indexOf(' ') === -1 ? line.length : line.indexOf(' '));
    const value = line.slice(key.length).replace(/^ /, '');
    if (key === 'worktree') { if (current) out.push(current); current = { path: value, head: '', branch: '', bare: false, detached: false, locked: '', prunable: '' }; }
    else if (!current) continue;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = value || 'locked';
    else if (key === 'prunable') current.prunable = value;
  }
  if (current) out.push(current);
  return out;
}

export function listWorktrees(repo) {
  const handle = resolveWorktreeRepo(repo);
  return parseWorktreeList(runGit(handle.worktree, ['worktree', 'list', '--porcelain'], { deadline: worktreeDeadline() }).toString('utf8'));
}

// Creates (or reopens) one isolated worktree. A fresh run gets its own branch ai-factory/<name>
// cut from `base`; if that branch already exists the existing checked-out state is reused, and a
// stale directory whose worktree was deregistered is replaced by a clean `worktree prune`.
export function createWorktree(repo, { name, base = 'HEAD', branch } = {}) {
  const handle = resolveWorktreeRepo(repo);
  if (!isValidWorktreeName(name)) {
    throw new Error(`invalid worktree name: ${name}`);
  }
  if (!isValidGitRef(base)) {
    throw new Error(`invalid base git ref: ${base}`);
  }
  if (branch && !isValidGitRef(branch)) {
    throw new Error(`invalid branch git ref: ${branch}`);
  }

  const dir = worktreePath(handle, name);
  const existing = listWorktrees(handle).find(w => samePath(w.path, dir));
  if (existing) {
    return { ...existing, reused: true, path: dir };
  }

  ensureExcluded(handle);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  const branchRef = branch || branchName(name);

  let branchExists = false;
  try {
    runGit(handle.worktree, ['show-ref', '--verify', '--quiet', `refs/heads/${branchRef}`], { deadline: worktreeDeadline() });
    branchExists = true;
  } catch {}

  if (branchExists) {
    const checkedOut = listWorktrees(handle).find(w => w.branch === branchRef);
    if (checkedOut) {
      throw new Error(`branch '${branchRef}' is already checked out at '${checkedOut.path}'`);
    }
    try {
      runGit(handle.worktree, ['worktree', 'add', '--', dir, branchRef], { deadline: worktreeDeadline() });
      return { path: dir, branch: branchRef, base, created: true, reusedBranch: true };
    } catch (err) {
      throw new Error(`git worktree add failed attaching branch '${branchRef}': ${String(err.message || err).slice(0, 300)}`);
    }
  }

  try {
    runGit(handle.worktree, ['worktree', 'add', '-b', branchRef, '--', dir, base], { deadline: worktreeDeadline() });
    return { path: dir, branch: branchRef, base, created: true };
  } catch (err) {
    if (fs.existsSync(dir)) {
      try {
        runGit(handle.worktree, ['worktree', 'prune'], { deadline: worktreeDeadline() });
        runGit(handle.worktree, ['worktree', 'add', '-b', branchRef, '--', dir, base], { deadline: worktreeDeadline() });
        return { path: dir, branch: branchRef, base, created: true };
      } catch (retry) {
        throw new Error(`git worktree add failed: ${String(retry.message || retry).slice(0, 300)}`);
      }
    }
    throw new Error(`git worktree add failed: ${String(err.message || err).slice(0, 300)}`);
  }
}

// Removes one worktree we created (refuses the main worktree and anything outside our area).
export function removeWorktree(repo, name, { force = false, deleteBranch = true } = {}) {
  const handle = resolveWorktreeRepo(repo);
  if (!isValidWorktreeName(name)) return { ok: false, reason: `invalid worktree name: ${name}` };
  const dir = path.resolve(worktreePath(handle, name));
  const listed = listWorktrees(handle).find(w => samePath(w.path, dir));
  if (!listed) return { ok: false, reason: `no worktree at ${dir}` };
  if (listed.bare) return { ok: false, reason: 'refusing to remove a bare worktree' };
  if (samePath(dir, handle.worktree)) return { ok: false, reason: 'refusing to remove the main worktree' };
  const internal = path.resolve(worktreeRoot(handle));
  if (!pathStartsWith(dir, internal)) return { ok: false, reason: 'worktree is outside the ai-factory area' };

  try {
    runGit(handle.worktree, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', dir], { deadline: worktreeDeadline() });
  } catch (err) {
    if (!force) return { ok: false, reason: String(err.message || err).slice(0, 300), hint: 'the worktree may have uncommitted changes; pass force to remove it anyway' };
    return { ok: false, reason: String(err.message || err).slice(0, 300) };
  }

  let branchDeleted = false;
  if (deleteBranch && listed.branch && listed.branch.startsWith(WORKTREE_BRANCH_PREFIX)) {
    try {
      runGit(handle.worktree, ['branch', force ? '-D' : '-d', '--', listed.branch], { deadline: worktreeDeadline() });
      branchDeleted = true;
    } catch {
      branchDeleted = false;
    }
  }

  return { ok: true, path: dir, branch: listed.branch, branchDeleted };
}

// Drops administrative records for worktrees whose directories are already gone.
export function pruneWorktrees(repo) {
  const handle = resolveWorktreeRepo(repo);
  runGit(handle.worktree, ['worktree', 'prune'], { deadline: worktreeDeadline() });
  return { ok: true };
}
