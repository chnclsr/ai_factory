// Project-level operations on the memory repository: list, rename, merge, and following a moved
// project to where it lives now.
//
// A renamed or merged-away project keeps its ref. Its head becomes a commit whose tree holds only
// project.json with `moved_to`, on top of the full history. Every resolution of that key follows
// the pointer, so a .ai-factory.toml or remote that still yields the old key keeps working, and
// nothing that was ever recorded becomes unreachable.

import { readRef, readCommit, readTree, applyChanges, writeBlob, writeCommit, updateRefLocked, initRepo } from './gitobj.mjs';
import { projectRef, isValidProjectKey } from './project.mjs';
import { snapshotRef, listProjects } from './store.mjs';
import { readAliases, ALIASES_FILE } from './session.mjs';
import { sanitizeText } from './sanitize.mjs';

const MAX_HOPS = 8;

function readProjectJson(snapshot) {
  try { return JSON.parse(snapshot.read('project.json') || 'null'); } catch { return null; }
}

// Returns the project with `key` replaced by where it lives now (and `movedFrom` set), or as is.
export function followMoves(repoDir, project) {
  let key = project.key;
  const seen = new Set([key]);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const info = readProjectJson(snapshotRef(repoDir, projectRef(key)));
    const next = info?.moved_to;
    if (typeof next !== 'string' || !isValidProjectKey(next) || seen.has(next)) break;
    seen.add(next);
    key = next;
  }
  return key === project.key ? project : { ...project, key, movedFrom: project.key };
}

export function describeProjects(repoDir) {
  return listProjects(repoDir).map(key => {
    const snapshot = snapshotRef(repoDir, projectRef(key));
    const info = readProjectJson(snapshot) || {};
    const sessions = snapshot.list('sessions').filter(e => e.name.endsWith('.meta.json')).length;
    return { key, seq: snapshot.seq, sessions, movedTo: info.moved_to || null, aliases: Array.isArray(info.aliases) ? info.aliases : [] };
  });
}

// Every blob under a tree as Map(path -> sha).
function walkTree(repoDir, treeSha, prefix = '', out = new Map()) {
  for (const entry of readTree(repoDir, treeSha)) {
    const full = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') walkTree(repoDir, entry.sha, full, out);
    else out.set(full, entry.sha);
  }
  return out;
}

function message(subject, trailers) {
  const lines = Object.entries(trailers).map(([k, v]) => `${k}: ${sanitizeText(String(v), { maxBytes: 200 }).replace(/\s+/g, ' ')}`);
  return `${subject}\n\n${lines.join('\n')}\n`;
}

function blobJson(repoDir, value) {
  return writeBlob(repoDir, JSON.stringify(value, null, 2));
}

function requireLive(repoDir, key, role) {
  if (!isValidProjectKey(key)) throw new Error(`invalid project key: ${key}`);
  const sha = readRef(repoDir, projectRef(key));
  if (!sha) throw new Error(`${role} project "${key}" does not exist`);
  const info = readProjectJson(snapshotRef(repoDir, projectRef(key)));
  if (info?.moved_to) throw new Error(`${role} project "${key}" already moved to "${info.moved_to}"`);
}

// Takes both ref locks in name order, so two operations on the same pair cannot deadlock.
// build({ [refA]: oldShaA, [refB]: oldShaB }) returns { [ref]: newSha | null }.
function withTwoRefs(repoDir, refA, refB, build) {
  const [first, second] = [refA, refB].sort();
  let result = null;
  updateRefLocked(repoDir, first, oldFirst => {
    let firstNew = null;
    updateRefLocked(repoDir, second, oldSecond => {
      result = build({ [first]: oldFirst, [second]: oldSecond });
      firstNew = result[first] || null;
      return result[second] || null;
    });
    return firstNew;
  });
  return result;
}

// The head commit that leaves `key` pointing at `target`: full history below, only project.json in the tree.
function movedCommit(repoDir, key, oldSha, target, kind, time) {
  const parent = readCommit(repoDir, oldSha);
  const tree = applyChanges(repoDir, null, new Map([['project.json', blobJson(repoDir, { key, moved_to: target, moved_at: new Date(time).toISOString(), kind })]]));
  return writeCommit(repoDir, { tree, parents: [oldSha], time,
    message: message(`project ${key} ${kind === 'rename' ? 'renamed' : 'merged'} into ${target}`, { Seq: parent.seq + 1, Kind: `project-${kind}`, 'Moved-To': target }) });
}

// Renames `from` to `to`. The new ref continues the same history; the old key becomes an alias.
export function renameProject(repoDir, from, to, { time = Date.now() } = {}) {
  initRepo(repoDir);
  if (from === to) throw new Error('old and new project keys are the same');
  requireLive(repoDir, from, 'source');
  if (!isValidProjectKey(to)) throw new Error(`invalid project key: ${to}`);
  const fromRef = projectRef(from);
  const toRef = projectRef(to);
  return withTwoRefs(repoDir, fromRef, toRef, old => {
    if (old[toRef]) throw new Error(`project "${to}" already exists; use merge to combine two projects`);
    const head = readCommit(repoDir, old[fromRef]);
    const info = readProjectJson(snapshotRef(repoDir, fromRef)) || {};
    const aliases = [...new Set([...(Array.isArray(info.aliases) ? info.aliases : []), from])];
    const tree = applyChanges(repoDir, head.tree, new Map([['project.json', blobJson(repoDir, { ...info, key: to, name: to, aliases, renamed_from: from })]]));
    const renamed = writeCommit(repoDir, { tree, parents: [old[fromRef]], time,
      message: message(`project ${from} renamed to ${to}`, { Seq: head.seq + 1, Kind: 'project-rename', 'Renamed-From': from }) });
    return { [toRef]: renamed, [fromRef]: movedCommit(repoDir, from, old[fromRef], to, 'rename', time) };
  }) && { from, to };
}

// Merges `source` into `target` with a two-parent commit. Nothing is dropped:
//   - a path only in source is added as is
//   - session-aliases.json is unioned; a clashing alias from source becomes "<alias>@<source>"
//   - a page that differs in both is kept from target, and source's copy becomes pages/<slug>.from-<source>.md
//   - any other differing path keeps target's copy, and source's goes to merged/<source>/<path>
// Seq continues from the larger of the two chains, so the order stays monotonic on the first parent.
export function mergeProjects(repoDir, source, target, { time = Date.now() } = {}) {
  initRepo(repoDir);
  if (source === target) throw new Error('cannot merge a project into itself');
  requireLive(repoDir, source, 'source');
  requireLive(repoDir, target, 'target');
  const sourceRef = projectRef(source);
  const targetRef = projectRef(target);
  const report = { source, target, added: 0, conflicts: [], aliasRenames: {} };
  withTwoRefs(repoDir, sourceRef, targetRef, old => {
    const sourceHead = readCommit(repoDir, old[sourceRef]);
    const targetHead = readCommit(repoDir, old[targetRef]);
    const sourceFiles = walkTree(repoDir, sourceHead.tree);
    const targetFiles = walkTree(repoDir, targetHead.tree);
    const changes = new Map();
    for (const [file, sha] of sourceFiles) {
      if (file === 'project.json' || file === ALIASES_FILE) continue;
      const existing = targetFiles.get(file);
      if (!existing) { changes.set(file, sha); report.added++; continue; }
      if (existing === sha) continue;
      // A kept older version (slug.vN.md) stays a version file, so it is not indexed as a live page.
      const page = file.match(/^pages\/(.+?)(\.v\d+)?\.md$/);
      const moved = page ? `pages/${page[1]}.from-${source}${page[2] || ''}.md` : `merged/${source}/${file}`;
      changes.set(moved, sha);
      report.conflicts.push({ path: file, keptFrom: target, sourceCopy: moved });
    }
    const targetAliases = readAliases(snapshotRef(repoDir, targetRef));
    const merged = { ...targetAliases };
    for (const [alias, sid] of Object.entries(readAliases(snapshotRef(repoDir, sourceRef)))) {
      if (!Object.hasOwn(merged, alias) || merged[alias] === sid) { merged[alias] = sid; continue; }
      const renamed = `${alias}@${source}`;
      merged[renamed] = sid;
      report.aliasRenames[alias] = renamed;
    }
    changes.set(ALIASES_FILE, blobJson(repoDir, merged));
    const targetInfo = readProjectJson(snapshotRef(repoDir, targetRef)) || { key: target };
    const sourceInfo = readProjectJson(snapshotRef(repoDir, sourceRef)) || {};
    const aliases = [...new Set([...(targetInfo.aliases || []), ...(sourceInfo.aliases || []), source])];
    changes.set('project.json', blobJson(repoDir, { ...targetInfo, key: target, aliases, merged_from: [...(targetInfo.merged_from || []), source] }));
    const tree = applyChanges(repoDir, targetHead.tree, changes);
    const seq = Math.max(sourceHead.seq, targetHead.seq) + 1;
    const mergeSha = writeCommit(repoDir, { tree, parents: [old[targetRef], old[sourceRef]], time,
      message: message(`merge project ${source} into ${target}`, { Seq: seq, Kind: 'project-merge', 'Merged-From': source }) });
    return { [targetRef]: mergeSha, [sourceRef]: movedCommit(repoDir, source, old[sourceRef], target, 'merge', time) };
  });
  return report;
}
