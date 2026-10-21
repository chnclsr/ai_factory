import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.AI_FACTORY_DATA_DIR || path.join(ROOT, '.runtime'));
export const CONFIG_FILE = path.resolve(process.env.AI_FACTORY_CONFIG || path.join(ROOT, 'router_config.json'));
export const PLUGIN_SOURCE = path.join(ROOT, 'plugins', 'ai-factory');
export const PLUGIN_TARGET = path.resolve(process.env.AI_FACTORY_PLUGIN_DIR || path.join(os.homedir(), '.gemini', 'config', 'plugins', 'ai-factory'));

export function stateFile(name) {
  // Existing installations keep legacy root-level state; fresh clones use .runtime.
  const legacy = path.join(ROOT, name);
  if (!process.env.AI_FACTORY_DATA_DIR && fs.existsSync(legacy)) return legacy;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  return path.join(DATA_DIR, name);
}
