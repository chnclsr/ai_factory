import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, memoryBlock } from './memory/testing/router-harness.mjs';

const ROOT_CONFIG = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'router_config.json'), 'utf8'));
const CLAUDE = ['--engine', 'claude', '--model', 'haiku-5.5', '--no-fallback'];

test('the shipped config asks every engine to work in English', () => {
  assert.equal(ROOT_CONFIG.response_language, 'English');
});

test('the language line goes first on every engine prompt, whatever language the request is in', t => {
  const h = makeHarness(t, { config: cfg => { cfg.response_language = 'English'; } });
  const cwd = path.join(h.dir, 'lang');
  fs.mkdirSync(cwd, { recursive: true });
  const task = 'bu cevabı kontrol et, emin misin?';
  assert.equal(h.run([...CLAUDE, '--session', 's', '--cwd', cwd, '--task', task]).status, 0);
  let prompt = h.lastCall().prompt;
  assert.match(prompt, /^\[AI Factory\] Language: think and work in English\./);
  assert.ok(prompt.endsWith(`\n\n${task}`), 'the request follows unchanged');
  assert.match(prompt, /unless the request itself explicitly asks for a different language/);

  assert.equal(h.run([...CLAUDE, '--session', 's', '--cwd', cwd, '--task', 'ikinci istek: devam et lütfen']).status, 0);
  prompt = h.lastCall().prompt;
  assert.match(prompt, /^\[AI Factory\] Language: /);
  assert.ok(memoryBlock(prompt), 'the memory block still follows');
  assert.ok(prompt.indexOf('Language:') < prompt.indexOf('<retrieved-memory'));
  assert.ok(prompt.endsWith('ikinci istek: devam et lütfen'));
});

test('response_language empty switches the line off, another value is used as given', t => {
  const h = makeHarness(t, { config: cfg => { cfg.response_language = ''; } });
  const cwd = path.join(h.dir, 'off');
  fs.mkdirSync(cwd, { recursive: true });
  assert.equal(h.run([...CLAUDE, '--cwd', cwd, '--task', 'plain task']).status, 0);
  assert.equal(h.lastCall().prompt, 'plain task');
  h.writeConfig(cfg => { cfg.response_language = 'Turkish'; });
  assert.equal(h.run([...CLAUDE, '--cwd', cwd, '--task', 'another plain task']).status, 0);
  assert.match(h.lastCall().prompt, /^\[AI Factory\] Language: think and work in Turkish\./);
});
