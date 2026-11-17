import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './testing/helpers.mjs';
import {
  isValidWorktreeName,
  isValidGitRef,
  parseWorktreeList,
  listWorktrees,
  createWorktree,
  removeWorktree,
  pruneWorktrees,
  worktreePath,
  worktreeRoot
} from './worktree.mjs';

function initGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.local'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n');
  execFileSync('git', ['-C', dir, 'add', 'README.md'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial commit'], { stdio: 'pipe' });
}

test('worktree name and git ref validation', () => {
  assert.equal(isValidWorktreeName('worker-1'), true);
  assert.equal(isValidWorktreeName('agent.task_2'), true);
  assert.equal(isValidWorktreeName(''), false);
  assert.equal(isValidWorktreeName('-invalid'), false);
  assert.equal(isValidWorktreeName('invalid/slash'), false);
  assert.equal(isValidWorktreeName('a'.repeat(65)), false);

  assert.equal(isValidGitRef('HEAD'), true);
  assert.equal(isValidGitRef('main'), true);
  assert.equal(isValidGitRef('feature/orca'), true);
  assert.equal(isValidGitRef('-invalid-flag'), false);
  assert.equal(isValidGitRef('/leading-slash'), false);
  assert.equal(isValidGitRef('trailing/'), false);
  assert.equal(isValidGitRef('ref..with..dots'), false);
  assert.equal(isValidGitRef('ref@{1}'), false);
  assert.equal(isValidGitRef('ref with spaces'), false);
  assert.equal(isValidGitRef('ref~1'), true);
  assert.equal(isValidGitRef('ref^2'), true);
  assert.equal(isValidGitRef('HEAD~1'), true);
  assert.equal(isValidGitRef('main^'), true);
  assert.equal(isValidGitRef('ref:colon'), false);
  assert.equal(isValidGitRef('ref.lock'), false);
});

test('parseWorktreeList parses porcelain output into records', () => {
  const porcelain = [
    'worktree /path/to/main',
    'HEAD 1234567890abcdef',
    'branch refs/heads/main',
    '',
    'worktree /path/to/wt1',
    'HEAD abcdef1234567890',
    'branch refs/heads/ai-factory/wt1',
    'locked maintenance',
    '',
    'worktree /path/to/wt2',
    'HEAD fedcba0987654321',
    'detached',
    'prunable gitdir not found',
    ''
  ].join('\n');

  const records = parseWorktreeList(porcelain);
  assert.equal(records.length, 3);

  assert.equal(records[0].path, '/path/to/main');
  assert.equal(records[0].branch, 'main');
  assert.equal(records[0].detached, false);

  assert.equal(records[1].path, '/path/to/wt1');
  assert.equal(records[1].branch, 'ai-factory/wt1');
  assert.equal(records[1].locked, 'maintenance');

  assert.equal(records[2].path, '/path/to/wt2');
  assert.equal(records[2].detached, true);
  assert.equal(records[2].prunable, 'gitdir not found');
});

test('real worktree lifecycle: create, list, reuse, and remove with branch deletion', t => {
  const root = tempDir(t, 'wt-lifecycle-');
  initGitRepo(root);

  const listInitial = listWorktrees(root);
  assert.equal(listInitial.length, 1);
  assert.equal(listInitial[0].branch, 'main');

  // Create worktree 'w1'
  const created = createWorktree(root, { name: 'w1' });
  assert.equal(created.created, true);
  assert.equal(created.branch, 'ai-factory/w1');
  assert.ok(fs.existsSync(created.path));
  assert.ok(fs.existsSync(path.join(created.path, 'README.md')));

  // Ensure worktree root is excluded in git info/exclude
  const excludeContent = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.match(excludeContent, /\.ai-factory\/worktrees/);

  // Re-creating the same worktree returns existing
  const reused = createWorktree(root, { name: 'w1' });
  assert.equal(reused.reused, true);
  assert.equal(reused.branch, 'ai-factory/w1');

  // List includes new worktree
  const listAfter = listWorktrees(root);
  assert.equal(listAfter.length, 2);
  assert.ok(listAfter.some(w => w.branch === 'ai-factory/w1'));

  // Removing main worktree is refused
  const removeMain = removeWorktree(root, '..');
  assert.equal(removeMain.ok, false);

  // Remove worktree 'w1'
  const removed = removeWorktree(root, 'w1');
  assert.equal(removed.ok, true);
  assert.equal(removed.branchDeleted, true);
  assert.equal(fs.existsSync(created.path), false);

  // Verify branch ai-factory/w1 is deleted
  assert.throws(() => {
    execFileSync('git', ['-C', root, 'show-ref', '--verify', '--quiet', 'refs/heads/ai-factory/w1'], { stdio: 'pipe' });
  });

  // Prune succeeds
  const pruned = pruneWorktrees(root);
  assert.equal(pruned.ok, true);
});

test('createWorktree reuses unattached branch and rejects branch checked out elsewhere', t => {
  const root = tempDir(t, 'wt-branches-');
  initGitRepo(root);

  // Pre-create branch ai-factory/reuse-me
  execFileSync('git', ['-C', root, 'branch', 'ai-factory/reuse-me'], { stdio: 'pipe' });

  // Creating worktree with that name attaches existing branch
  const attached = createWorktree(root, { name: 'reuse-me' });
  assert.equal(attached.created, true);
  assert.equal(attached.reusedBranch, true);
  assert.equal(attached.branch, 'ai-factory/reuse-me');

  // Attempting to attach main (which is checked out at root) fails
  assert.throws(() => {
    createWorktree(root, { name: 'conflict', branch: 'main' });
  }, /already checked out/);

  // Cleanup
  removeWorktree(root, 'reuse-me');
});

test('worktreeRoot resolves to the common root when called inside a linked worktree', t => {
  const root = tempDir(t, 'wt-root-');
  initGitRepo(root);
  const wt = createWorktree(root, { name: 'linked-test' });
  assert.equal(wt.created, true);

  const rootResolved = worktreeRoot(root);
  const insideResolved = worktreeRoot(wt.path);
  assert.equal(insideResolved, rootResolved);

  removeWorktree(root, 'linked-test');
});

test('ensureExcluded adds exclusion entry to git info exclude', t => {
  const root = tempDir(t, 'wt-exclude-');
  initGitRepo(root);
  createWorktree(root, { name: 'exclude-check' });

  const excludeFile = path.join(root, '.git', 'info', 'exclude');
  assert.equal(fs.existsSync(excludeFile), true);
  const content = fs.readFileSync(excludeFile, 'utf8');
  assert.match(content, /# ai-factory isolated worktrees\r?\n\/\.ai-factory\/worktrees\//);

  removeWorktree(root, 'exclude-check');
});

test('createWorktree fails cleanly when base ref is invalid', t => {
  const root = tempDir(t, 'wt-badbase-');
  initGitRepo(root);

  assert.throws(() => {
    createWorktree(root, { name: 'bad-base', base: 'invalid-nonexistent-ref-999' });
  }, /git worktree add failed/);
});

