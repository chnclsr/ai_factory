import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineCapture } from './stream-capture.mjs';

function collect() {
  const lines = [];
  return { lines, capture: createLineCapture({ onLine: (line, stream) => lines.push([stream, line]) }) };
}

test('a line split across chunks comes out whole', () => {
  const { lines, capture } = collect();
  capture.write('stdout', Buffer.from('hatalar ve '));
  capture.write('stdout', Buffer.from('notlar\nikinci'));
  capture.write('stdout', Buffer.from(' satir\n'));
  assert.deepEqual(lines, [['stdout', 'hatalar ve notlar'], ['stdout', 'ikinci satir']]);
});

test('a multi-byte character split between chunks is not replaced', () => {
  const { lines, capture } = collect();
  const bytes = Buffer.from('çağrıları ve şunlar\n', 'utf8');
  // Cut inside "ç" (2 bytes) and inside "ş".
  capture.write('stdout', bytes.subarray(0, 1));
  capture.write('stdout', bytes.subarray(1, bytes.indexOf(0xc5) + 1));
  capture.write('stdout', bytes.subarray(bytes.indexOf(0xc5) + 1));
  assert.deepEqual(lines, [['stdout', 'çağrıları ve şunlar']]);
  assert.ok(!lines[0][1].includes('\uFFFD'));
});

test('stdout and stderr keep separate unfinished lines', () => {
  const { lines, capture } = collect();
  capture.write('stdout', Buffer.from('half of an answer'));
  capture.write('stderr', Buffer.from('muse: workspace root\n'));
  capture.write('stdout', Buffer.from(' and the rest\n'));
  assert.deepEqual(lines, [['stderr', 'muse: workspace root'], ['stdout', 'half of an answer and the rest']]);
});

test('flush emits a last line without a newline, once', () => {
  const { lines, capture } = collect();
  capture.write('stdout', Buffer.from('first\nlast'));
  capture.flush();
  capture.flush();
  assert.deepEqual(lines, [['stdout', 'first'], ['stdout', 'last']]);
});

test('write returns the decoded text for display and JSON parsing', () => {
  const { capture } = collect();
  const bytes = Buffer.from('é', 'utf8');
  assert.equal(capture.write('stdout', bytes.subarray(0, 1)), '');
  assert.equal(capture.write('stdout', bytes.subarray(1)), 'é');
});
