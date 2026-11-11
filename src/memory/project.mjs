// Resolves which project a router call belongs to, without spawning git.
//
// Order: explicit --project, then the nearest .ai-factory.toml (`project = "..."`), then the
// normalised `upstream` remote, then `origin`, read straight from the repository's config file,
// and finally the folder name. Remote-derived keys carry a short hash of the normalised remote so
// two repositories with the same owner/name on different hosts never share a ref.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MARKER_FILE = '.ai-factory.toml';
export const UNSCOPED_PROJECT = '_unscoped';
export const PERSONAL_REF = 'refs/heads/personal';

// Git ref components may not start with "." or end with ".lock" and may not contain "..".
export function slugify(value) {
  const slug = String(value || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.-]+|[.-]+$/g, '')
    .replace(/\.lock$/, '-lock').slice(0, 80);
  return slug || 'project';
}

export function isValidProjectKey(key) {
  return typeof key === 'string' && /^[a-z0-9_][a-z0-9._-]{0,99}$/.test(key) &&
    !key.includes('..') && !key.endsWith('.lock');
}

export function projectRef(key) {
  if (!isValidProjectKey(key)) throw new Error(`invalid project key: ${key}`);
  return `refs/heads/p/${key}`;
}

// Minimal TOML: top-level `key = "string"`, `key = 'string'`, `key = true` and string arrays.
export function parseMarker(text) {
  const out = {};
  let table = '';
  const source = String(text).replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (header) { table = header[1] + '.'; continue; }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    let raw = kv[2];
    if (raw.startsWith('[') && !raw.includes(']')) {
      while (i + 1 < lines.length && !raw.includes(']')) raw += ' ' + lines[++i].replace(/#.*$/, '').trim();
    }
    let value;
    if (raw.startsWith('[')) value = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(m => m[1] ?? m[2]);
    else if (/^"(.*)"$/.test(raw)) value = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    else if (/^'(.*)'$/.test(raw)) value = raw.slice(1, -1);
    else if (raw === 'true' || raw === 'false') value = raw === 'true';
    else if (/^-?\d+$/.test(raw)) value = Number(raw);
    else continue;
    out[table + kv[1]] = value;
  }
  return out;
}

function findUp(start, predicate) {
  let dir = path.resolve(start);
  for (;;) {
    const hit = predicate(dir);
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Returns { worktree, gitDir, commonDir } for the repository containing `start`, or null.
// Handles linked worktrees and submodules, whose ".git" is a file pointing elsewhere.
export function findGitRepo(start) {
  return findUp(start, dir => {
    const dotGit = path.join(dir, '.git');
    let stat;
    try { stat = fs.statSync(dotGit); } catch { return null; }
    let gitDir = dotGit;
    if (stat.isFile()) {
      const match = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!match) return null;
      gitDir = path.resolve(dir, match[1].trim());
    }
    let commonDir = gitDir;
    try { commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch {}
    return { worktree: dir, gitDir, commonDir };
  });
}

export function readRemotes(commonDir) {
  const remotes = {};
  let text;
  try { text = fs.readFileSync(path.join(commonDir, 'config'), 'utf8'); } catch { return remotes; }
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(/^\[\s*remote\s+"([^"]+)"\s*\]$/i);
    if (section) { current = section[1]; continue; }
    if (line.startsWith('[')) { current = null; continue; }
    const url = current && line.match(/^url\s*=\s*(.+)$/i);
    if (url && !remotes[current]) remotes[current] = url[1].trim();
  }
  return remotes;
}

// "git@github.com:Acme/API.git", "https://user@github.com/acme/api" -> "github.com/acme/api".
export function normalizeRemote(url) {
  let value = String(url || '').trim();
  if (!value) return '';
  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/);
  if (scp && !/^[a-z]+:\/\//i.test(value)) value = `${scp[1]}/${scp[2]}`;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
  value = value.replace(/^([^/:]+):\d+\//, '$1/');
  value = value.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '');
  return value.toLowerCase();
}

export function remoteProjectName(normalized) {
  const parts = normalized.split('/').filter(Boolean);
  return slugify(parts.length > 1 ? parts.slice(1).join('-') : parts[0]);
}

function shortHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

export function readMarker(cwd) {
  return findUp(cwd, dir => {
    const file = path.join(dir, MARKER_FILE);
    try { return { dir, file, values: parseMarker(fs.readFileSync(file, 'utf8')) }; } catch { return null; }
  });
}

// Returns { key, name, source, root, remote, marker } for a working directory.
export function resolveProject({ project = '', cwd = process.cwd() } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const marker = readMarker(resolvedCwd);
  const ignorePaths = Array.isArray(marker?.values?.ignore_paths) ? marker.values.ignore_paths : [];
  if (project) {
    const key = slugify(project);
    return { key, name: key, source: 'flag', root: resolvedCwd, remote: '', ignorePaths };
  }
  if (marker && typeof marker.values.project === 'string' && marker.values.project.trim()) {
    const key = slugify(marker.values.project);
    return { key, name: key, source: 'marker', root: marker.dir, remote: '', ignorePaths };
  }
  const repo = findGitRepo(resolvedCwd);
  if (repo) {
    const remotes = readRemotes(repo.commonDir);
    for (const remoteName of ['upstream', 'origin']) {
      const normalized = normalizeRemote(remotes[remoteName]);
      if (!normalized) continue;
      const name = remoteProjectName(normalized);
      return { key: `${name}-${shortHash(normalized)}`, name, source: `remote:${remoteName}`,
        root: repo.worktree, remote: normalized, ignorePaths };
    }
  }
  const root = repo ? repo.worktree : resolvedCwd;
  const key = slugify(path.basename(root));
  return { key, name: key, source: 'folder', root, remote: '', ignorePaths };
}
