#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, CONFIG_FILE, PLUGIN_TARGET } from '../lib/paths.mjs';
import { installPlugin } from '../lib/plugin.mjs';

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Setup command failed: ' + args.join(' '));
}
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ required');
  const args = process.argv.slice(2);
  if (args.some(arg => !['--skip-install', '--skip-plugin'].includes(arg))) throw new Error('Options: --skip-install, --skip-plugin');
  JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!args.includes('--skip-install')) {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(npmCli)) {
      runNode([npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    } else {
      const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error('npm ci failed');
    }
  }
  runNode(['scripts/check.mjs']);
  runNode(['--test']);
  if (!args.includes('--skip-plugin')) {
    const result = installPlugin();
    console.log('Plugin installed: ' + result.target);
    if (result.backup) console.log('Previous plugin backup: ' + result.backup);
  }
  console.log('Setup complete. Run npm start, then open http://127.0.0.1:' + (process.env.AI_FACTORY_PORT || 8080));
  console.log('Restart Gemini/Antigravity to load hooks. Target: ' + PLUGIN_TARGET);
} catch (error) {
  console.error('[Setup] ' + error.message);
  process.exitCode = 1;
}

