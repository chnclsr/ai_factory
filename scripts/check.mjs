#!/usr/bin/env node
// Environment and configuration check: `npm run check` (also run by `npm run setup`).
//
// Errors (exit 1) are things the router cannot work without: an unsupported Node.js, an
// unreadable or inconsistent router_config.json, missing plugin files. Warnings are things that
// only limit it: an engine CLI that is not installed, a missing git binary (file tracking in
// memory), an Antigravity plugin that is not deployed yet. Nothing here touches the network.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, CONFIG_FILE, PLUGIN_SOURCE, PLUGIN_TARGET } from '../lib/paths.mjs';

const results = [];
const note = (level, message) => results.push({ level, message });
const ok = message => note('ok', message);
const warn = message => note('warn', message);
const fail = message => note('error', message);

// ── Node.js ────────────────────────────────────────────────────────────────────────────────────
const required = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines?.node || '>=22.13';
const [needMajor, needMinor] = required.replace(/[^\d.]/g, '').split('.').map(Number);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > needMajor || (major === needMajor && minor >= (needMinor || 0))) ok(`Node.js ${process.versions.node} (needs ${required})`);
else fail(`Node.js ${process.versions.node} is too old (needs ${required})`);

try {
  await import('node:sqlite');
  ok('node:sqlite is available (memory search index)');
} catch {
  warn('node:sqlite is not available: memory search falls back to scanning the git store');
}

// ── router_config.json ─────────────────────────────────────────────────────────────────────────
let config = null;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  ok(`router_config.json parses (${path.relative(ROOT, CONFIG_FILE) || CONFIG_FILE})`);
} catch (err) {
  fail(`router_config.json: ${err.message}`);
}

if (config) {
  const engines = config.engines || {};
  const modelsOf = engine => Object.keys(engines[engine]?.models || {});
  for (const [name, engine] of Object.entries(engines)) {
    if (!modelsOf(name).length) fail(`engine ${name} has no models`);
    else if (!engine.models[engine.default_model]) fail(`engine ${name}: default_model "${engine.default_model}" is not one of its models`);
    for (const [model, entry] of Object.entries(engine.models || {})) {
      if (!entry.id) fail(`engine ${name}, model ${model}: missing "id"`);
    }
  }
  if (engines.vibe && !engines.vibe.models?.[engines.vibe.complex_model]) fail(`engine vibe: complex_model "${engines.vibe.complex_model}" is not one of its models`);
  const chain = Array.isArray(config.fallback_chain) ? config.fallback_chain : [];
  if (!chain.length) fail('fallback_chain is empty');
  for (const [index, step] of chain.entries()) {
    if (!engines[step.engine]) fail(`fallback_chain step ${index + 1}: unknown engine "${step.engine}"`);
    else if (!engines[step.engine].models?.[step.model]) fail(`fallback_chain step ${index + 1}: "${step.model}" is not a ${step.engine} model`);
  }
  if (chain.length && !results.some(r => r.level === 'error' && r.message.startsWith('fallback_chain'))) {
    ok(`fallback chain: ${chain.map(step => `${step.engine}/${step.model}`).join(' → ')}`);
  }
  const memory = config.memory || {};
  if (memory.enabled !== true) warn('memory is switched off (memory.enabled is not true): the router keeps no history');
  else ok('memory is enabled');
  for (const key of ['conversation_tokens', 'default_budget_tokens', 'state_every_turns', 'auto_session_minutes']) {
    if (memory[key] !== undefined && !(Number.isFinite(memory[key]) && memory[key] >= 0)) fail(`memory.${key} must be a number >= 0`);
  }
}

// ── Plugin sources and deployment ──────────────────────────────────────────────────────────────
const pluginFiles = ['plugin.json', 'hooks.json', 'hooks/hook_handler.js', 'rules/ai_factory_router.md', 'skills/ai-factory/SKILL.md'];
const missing = pluginFiles.filter(file => !fs.existsSync(path.join(PLUGIN_SOURCE, file)));
if (missing.length) fail(`plugin sources missing: ${missing.join(', ')}`);
else ok('plugin sources are complete');
if (fs.existsSync(path.join(PLUGIN_TARGET, 'plugin.json'))) ok(`Antigravity plugin is deployed (${PLUGIN_TARGET})`);
else warn('Antigravity plugin is not deployed yet: run `npm run deploy`');

// ── External programs ──────────────────────────────────────────────────────────────────────────
function onPath(program) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(locator, [program], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 && result.stdout.trim().split(/\r?\n/)[0];
}
if (onPath('git')) ok('git is installed (memory records each call\'s file changes with it)');
else warn('git was not found: memory still records turns but not file changes');
const wanted = { vibe: 'vibe', muse: 'muse', claude: 'claude' };
for (const [engine, program] of Object.entries(wanted)) {
  if (config && !config.engines?.[engine]) continue;
  const found = onPath(program);
  const inChain = (config?.fallback_chain || []).some(step => step.engine === engine);
  if (found) ok(`${program} CLI found (${found})`);
  else warn(`${program} CLI not found${inChain ? ' (it is in the default fallback chain)' : ' (only needed when you name it)'}`);
}

// ── Report ─────────────────────────────────────────────────────────────────────────────────────
const marks = { ok: ' ok  ', warn: 'warn ', error: 'FAIL ' };
for (const r of results) console.log(`${marks[r.level]} ${r.message}`);
const errors = results.filter(r => r.level === 'error').length;
const warnings = results.filter(r => r.level === 'warn').length;
console.log(`\n${errors ? `${errors} error(s)` : 'No errors'}, ${warnings} warning(s).`);
process.exit(errors ? 1 : 0);
