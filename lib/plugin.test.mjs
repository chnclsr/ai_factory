import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installPlugin } from './plugin.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-plugin-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, target: path.join(dir, 'config', 'plugins', 'ai-factory') };
}

test('redeployment preserves backups outside the plugin discovery directory', t => {
  const { dir, target } = fixture(t);
  installPlugin({ target });
  fs.writeFileSync(path.join(target, 'local-marker.txt'), 'preserve this');
  const { backup } = installPlugin({ target });
  assert.equal(path.dirname(backup), path.join(dir, 'config', 'plugin-backups'));
  assert.equal(fs.readFileSync(path.join(backup, 'local-marker.txt'), 'utf8'), 'preserve this');
  const plugins = fs.readdirSync(path.dirname(target)).filter(name =>
    fs.existsSync(path.join(path.dirname(target), name, 'plugin.json')));
  assert.deepEqual(plugins, ['ai-factory']);
});

test('installed and injected router commands run in the host shell', t => {
  const { dir, target } = fixture(t);
  installPlugin({ target });
  const rule = fs.readFileSync(path.join(target, 'rules', 'ai_factory_router.md'), 'utf8');
  const command = rule.match(/^Run (.+) --task "<user request>"/m)?.[1];
  assert.ok(command);
  const env = { ...process.env, AI_FACTORY_ROUTER_DEPTH: '0', AI_FACTORY_DATA_DIR: path.join(dir, 'state') };
  const injected = spawnSync(process.execPath, [path.join(target, 'hooks', 'hook_handler.js')], {
    input: '{}', encoding: 'utf8', env, timeout: 10000
  });
  assert.equal(injected.status, 0, injected.stderr);
  const injectedRule = JSON.parse(injected.stdout).injectSteps[0].systemMessage.systemMessage;
  assert.ok(injectedRule.includes('Run ' + command + ' --task'));
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command'] : ['-c'];
  const result = spawnSync(shell, [...args, command + ' --engine gemini --task "plugin launch smoke"'], {
    encoding: 'utf8', env, timeout: 15000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /succeed_with: handoff_to_gemini/);
});
