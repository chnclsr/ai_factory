#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPlugin } from './lib/plugin.mjs';

try {
  if (process.argv.slice(2).some(arg => arg !== '--builtin')) throw new Error('Usage: node deploy_skill.mjs [--builtin]');
  const result = installPlugin();
  console.log('Plugin installed: ' + result.target);
  if (result.backup) console.log('Backup: ' + result.backup);
  if (process.argv.includes('--builtin')) {
    const content = fs.readFileSync(path.join(result.target, 'skills', 'ai-factory', 'SKILL.md'), 'utf8');
    for (const host of ['antigravity', 'antigravity-cli', 'antigravity-ide']) {
      const builtin = path.join(os.homedir(), '.gemini', host, 'builtin', 'skills');
      if (!fs.existsSync(builtin)) { console.log('Skipped missing host: ' + host); continue; }
      const skill = path.join(builtin, 'ai_factory', 'SKILL.md');
      fs.mkdirSync(path.dirname(skill), { recursive: true });
      if (fs.existsSync(skill)) fs.copyFileSync(skill, skill + '.backup-' + Date.now());
      fs.writeFileSync(skill, content, 'utf8');
      console.log('Skill installed: ' + skill);
    }
  }
} catch (error) {
  console.error('[Deploy] ' + error.message);
  process.exitCode = 1;
}

