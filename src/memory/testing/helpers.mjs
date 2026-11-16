// Shared helpers for the memory tests. Not a test file itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Windows Defender and the search indexer briefly hold freshly written files; cleanup is best
// effort so a busy handle in the OS temp directory never fails a test.
export function tempDir(t, prefix = 'mem-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  });
  return dir;
}

export function fsck(repo) {
  return spawnSync('git', ['--git-dir', repo, 'fsck', '--strict', '--no-dangling', '--no-progress'], { encoding: 'utf8' });
}

// Git for Windows cannot open \\.\nul as a config file, so an empty file stands in for "no config".
let emptyConfig = null;
function emptyGitConfig() {
  if (!emptyConfig) {
    emptyConfig = path.join(os.tmpdir(), `ai-factory-empty-gitconfig-${process.pid}`);
    fs.writeFileSync(emptyConfig, '');
    process.on('exit', () => { try { fs.unlinkSync(emptyConfig); } catch {} });
  }
  return emptyConfig;
}

// Runs git in a fixture repository without inheriting the user's global config or signing setup.
export function git(cwd, args, extra = {}) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: emptyGitConfig(), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost', ...(extra.env || {}) };
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env, ...extra, env });
  if (result.status !== 0 && !extra.allowFail) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result;
}

export function initFixtureRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

export function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-gpg-sign', '-m', message]);
}
