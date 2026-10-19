/**
 * Watchdog liveness erteleme davranışı için odaklı kalıcı testler.
 * Koşturma: node --test src/watchdog.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideWatchdogAction,
  collectProcessTreePids,
  isPidAlive,
  isProcessTreeAlive
} from './watchdog.mjs';

test('CPU sampling includes grandchildren behind shell and CLI wrappers', () => {
  const rows = [{ ProcessId: 3, ParentProcessId: 2 }, { ProcessId: 2, ParentProcessId: 1 },
    { ProcessId: 4, ParentProcessId: 3 }, { ProcessId: 9, ParentProcessId: 8 }];
  assert.deepEqual(collectProcessTreePids(1, rows).sort(), [1, 2, 3, 4]);
});

function base(overrides = {}) {
  return {
    elapsedMs: 60_000,
    idleMs: 130_000,
    thresholdMs: 120_000,
    maxExecutionMs: 600_000,
    treeAlive: true,
    cpuKnown: true,
    cpuAdvanced: false,
    cpuStillMs: 200_000,
    cpuStillLimitMs: 120_000,
    ...overrides
  };
}

test('sert tavan aşılınca canlı süreç bile öldürülür (hard_timeout)', () => {
  const d = decideWatchdogAction(base({
    elapsedMs: 600_001,
    cpuAdvanced: true // CPU ilerlese bile tavan kazanır
  }));
  assert.equal(d.action, 'kill');
  assert.equal(d.reason, 'hard_timeout');
});

test('eşik altı sessizlikte beklenir (wait)', () => {
  const d = decideWatchdogAction(base({ idleMs: 10_000 }));
  assert.equal(d.action, 'wait');
  assert.equal(d.reason, 'within_budget');
});

test('süreç hayattayken + CPU ilerliyorsa öldürme ertelenir (postpone)', () => {
  const d = decideWatchdogAction(base({ cpuAdvanced: true, cpuStillMs: 0 }));
  assert.equal(d.action, 'postpone');
  assert.equal(d.reason, 'tree_alive');
});

test('CPU örneklenemiyorsa canlı ağaç ertelenir (tavan sınırlar)', () => {
  const d = decideWatchdogAction(base({ cpuKnown: false }));
  assert.equal(d.action, 'postpone');
});

test('CPU donma süresi limit altındaysa ertelenir', () => {
  const d = decideWatchdogAction(base({ cpuAdvanced: false, cpuStillMs: 30_000 }));
  assert.equal(d.action, 'postpone');
});

test('canlı ağaç + donmuş CPU (limit üstü) zombi sayılıp öldürülür', () => {
  const d = decideWatchdogAction(base({ cpuAdvanced: false, cpuStillMs: 200_000 }));
  assert.equal(d.action, 'kill');
  assert.equal(d.reason, 'zombie_tree');
});

test('ölü ağaçta öldürme yapılmaz, close olayı beklenir', () => {
  const d = decideWatchdogAction(base({ treeAlive: false }));
  assert.equal(d.action, 'wait');
  assert.equal(d.reason, 'tree_dead_await_close');
});

test('isPidAlive: geçersiz PID false, kendi sürecimiz true', () => {
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(999_999_999), false);
  assert.equal(isPidAlive(process.pid), true);
});

test('isProcessTreeAlive: kapanmış child false', () => {
  const fakeChild = { exitCode: 0, signalCode: null };
  assert.equal(isProcessTreeAlive(999_999_999, fakeChild), false);
});
