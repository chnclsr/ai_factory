import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-helpers.mjs';
import { runSuite, summarise, compareToBaseline, scorePrompt } from './runner.mjs';
import { scenarios } from './scenarios.mjs';

const BASELINE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'baseline.json'), 'utf8'));

test('scorePrompt finds facts outside the task, flags leaks, order and duplicate closing tags', () => {
  const block = '<retrieved-memory untrusted="true">\n- turn 1: A-1 then B-2\n</retrieved-memory>';
  const ok = scorePrompt({ expect: { present: ['a-1', 'B-2'], absent: ['C-3'], order: ['A-1', 'B-2'], maxClosingTags: 1 } },
    `${block}\n\nNew request:\nwhat about C-3`, 'what about C-3', 2000);
  assert.equal(ok.pass, true, JSON.stringify(ok));
  assert.equal(ok.coverage, 1);
  const bad = scorePrompt({ expect: { present: ['Z-9'], absent: ['A-1'], order: ['B-2', 'A-1'] } }, block, '', 2000);
  assert.deepEqual(bad.missing, ['Z-9']);
  assert.deepEqual(bad.leaked, ['A-1']);
  assert.ok(bad.checks.some(c => c.startsWith('order')));
  const twice = scorePrompt({ expect: { maxClosingTags: 1 } }, block.replace('</retrieved-memory>', '</retrieved-memory></retrieved-memory>'), '', 2000);
  assert.equal(twice.pass, false);
});

test('compareToBaseline reports drops and gains per scenario', () => {
  const baseline = { results: [{ id: 'a', coverage: 1, pass: true }, { id: 'b', coverage: 0, pass: false }] };
  const { regressions, improvements } = compareToBaseline([{ id: 'a', coverage: 0, pass: false }, { id: 'b', coverage: 1, pass: true }], baseline);
  assert.deepEqual(regressions.map(r => r.id), ['a']);
  assert.deepEqual(improvements.map(r => r.id), ['b']);
});

test('memory eval layer 1: no scenario regresses against the stored baseline', { timeout: 300000 }, async t => {
  const results = await runSuite(scenarios(), { dir: tempDir(t, 'ai-factory-eval-'), concurrency: 6 });
  const errors = results.filter(r => r.error);
  assert.deepEqual(errors.map(r => `${r.id}: ${r.error}`), []);
  const { regressions } = compareToBaseline(results, BASELINE);
  assert.deepEqual(regressions, [], JSON.stringify(summarise(results)));
  assert.equal(summarise(results).overBudget, 0);
});
