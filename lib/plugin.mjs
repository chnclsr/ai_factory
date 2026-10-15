import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PLUGIN_SOURCE, PLUGIN_TARGET } from './paths.mjs';

const FILES = [
  'plugin.json', 'package.json', 'hooks.json',
  'hooks/hook_handler.js', 'hooks/inject.js',
  'rules/ai_factory_router.md', 'rules/AGENTS.md', 'rules/GEMINI.md',
  'skills/ai-factory/SKILL.md'
];

export function installPlugin({ target = PLUGIN_TARGET } = {}) {
  target = path.resolve(target);
  if (target === PLUGIN_SOURCE || PLUGIN_SOURCE.startsWith(target + path.sep) || target.startsWith(PLUGIN_SOURCE + path.sep)) {
    throw new Error('Plugin target must be separate from plugin sources');
  }
  const router = path.join(ROOT, 'router.mjs').replaceAll('\\', '/');
  const node = process.execPath.replaceAll('\\', '/');
  const command = JSON.stringify(node) + ' ' + JSON.stringify(router);
  const hook = JSON.stringify(node) + ' ' + JSON.stringify(path.join(target, 'hooks', 'hook_handler.js').replaceAll('\\', '/'));
  const rendered = FILES.map(file => {
    let text = fs.readFileSync(path.join(PLUGIN_SOURCE, file), 'utf8');
    if (file === 'hooks.json') {
      text = text.replaceAll('node ./hooks/hook_handler.js', '{{HOOK_COMMAND}}');
      text = text.replaceAll('{{HOOK_COMMAND}}', JSON.stringify(hook).slice(1, -1));
      JSON.parse(text);
    } else {
      text = text.replaceAll('{{ROUTER_COMMAND}}', command);
    }
    return [file, text];
  });
  let backup = null;
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Plugin target cannot be a symbolic link');
    backup = target + '.backup-' + Date.now() + '-' + process.pid;
    fs.cpSync(target, backup, { recursive: true, errorOnExist: true, force: false });
  }
  fs.mkdirSync(target, { recursive: true });
  // Check all managed destinations before replacing an existing installation.
  for (const [file] of rendered) {
    let destination = path.join(target, file);
    while (destination !== target) {
      if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('Refusing plugin symlink: ' + destination);
      destination = path.dirname(destination);
    }
  }
  for (const [file, text] of rendered) {
    const destination = path.join(target, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text, 'utf8');
  }
  fs.writeFileSync(path.join(target, 'installation.json'), JSON.stringify({ root: ROOT, router, node }, null, 2));
  return { target, backup };
}

