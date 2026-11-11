import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, normalizeRemote, parseMarker, slugify, isValidProjectKey } from './project.mjs';
import { tempDir as makeTemp } from './test-helpers.mjs';

const tempDir = t => makeTemp(t, 'mem proj ');

function fakeRepo(dir, remotes) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  let config = '[core]\n\tbare = false\n';
  for (const [name, url] of Object.entries(remotes)) config += `[remote "${name}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${name}/*\n`;
  fs.writeFileSync(path.join(dir, '.git', 'config'), config);
}

test('remote URLs normalise the same across transports', () => {
  for (const url of ['git@github.com:Acme/API.git', 'https://github.com/acme/api', 'ssh://git@github.com:22/acme/api.git',
    'https://user:pw@github.com/acme/api.git/']) {
    assert.equal(normalizeRemote(url), 'github.com/acme/api', url);
  }
});

test('project resolution order: flag, marker, upstream, origin, folder', t => {
  const dir = tempDir(t);
  const repo = path.join(dir, 'My Repo');
  const sub = path.join(repo, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(resolveProject({ cwd: sub }).key, 'deep');
  assert.equal(resolveProject({ cwd: repo }).key, 'my-repo');
  assert.equal(resolveProject({ cwd: sub }).source, 'folder');

  fakeRepo(repo, { origin: 'git@github.com:acme/api.git' });
  const origin = resolveProject({ cwd: sub });
  assert.equal(origin.source, 'remote:origin');
  assert.match(origin.key, /^acme-api-[0-9a-f]{8}$/);
  assert.equal(origin.root, repo);

  fakeRepo(repo, { origin: 'git@github.com:me/api.git', upstream: 'https://github.com/acme/api' });
  assert.equal(resolveProject({ cwd: sub }).source, 'remote:upstream');
  assert.equal(resolveProject({ cwd: sub }).key, origin.key);

  fs.writeFileSync(path.join(repo, '.ai-factory.toml'), 'project = "Shared Name" # comment\nignore_paths = [\n  ".runtime/",\n  "telegram-config.json"\n]\n');
  const marked = resolveProject({ cwd: sub });
  assert.equal(marked.key, 'shared-name');
  assert.deepEqual(marked.ignorePaths, ['.runtime/', 'telegram-config.json']);
  assert.equal(resolveProject({ cwd: sub, project: 'Override' }).key, 'override');
});

test('a linked worktree resolves through its gitdir file to the shared remote', t => {
  const dir = tempDir(t);
  const main = path.join(dir, 'main');
  fakeRepo(main, { origin: 'https://github.com/acme/api' });
  const wtGit = path.join(main, '.git', 'worktrees', 'wt');
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.equal(resolveProject({ cwd: wt }).key, resolveProject({ cwd: main }).key);
});

test('marker parser and slugs stay inside git ref rules', () => {
  assert.deepEqual(parseMarker('[memory]\nenabled = false\nproject = \'x\''), { 'memory.enabled': false, 'memory.project': 'x' });
  for (const raw of ['..', 'a..b', 'x.lock', '.hidden', 'Ünïcode Name', '']) {
    assert.ok(isValidProjectKey(slugify(raw)), raw);
  }
});
