import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTimeLeft, formatTimeAgo, formatQuotaChip, checkEngineQuotaGate, QUOTA_WARNING_USED_PERCENT } from './quota_tracker.mjs';

test('formatTimeLeft formats future durations cleanly and past as now', () => {
  const now = 1700000000000;
  assert.equal(formatTimeLeft(new Date(now + 7500 * 1000).toISOString(), now), '2h 5m');
  assert.equal(formatTimeLeft(new Date(now + 45 * 1000).toISOString(), now), '45s');
  assert.equal(formatTimeLeft(new Date(now + 120 * 1000).toISOString(), now), '2m');
  assert.equal(formatTimeLeft(new Date(now - 1000).toISOString(), now), 'now');
  assert.equal(formatTimeLeft('invalid-date', now), null);
});

test('formatTimeAgo formats past durations cleanly', () => {
  const now = 1700000000000;
  assert.equal(formatTimeAgo(new Date(now - 5 * 1000).toISOString(), now), 'just now');
  assert.equal(formatTimeAgo(new Date(now - 65 * 1000).toISOString(), now), '1m 5s ago');
  assert.equal(formatTimeAgo(new Date(now - 3600 * 1000).toISOString(), now), '1h ago');
  assert.equal(formatTimeAgo(new Date(now - (86400 + 7200) * 1000).toISOString(), now), '1d 2h ago');
  assert.equal(formatTimeAgo('invalid-date', now), null);
});

test('formatQuotaChip formats compact status line with warnings and ages', () => {
  const now = 1700000000000;
  const registry = {
    updatedAt: new Date(now - 120 * 1000).toISOString(),
    engines: {
      codex: {
        status: 'ok',
        usedPercent: 83,
        resetsAt: new Date(now + 3600 * 1000).toISOString(),
        spendControlReached: false,
        resetCreditsAvailable: 1
      },
      antigravity: {
        status: 'ok',
        quotas: [
          { modelGroup: 'Gemini', window: 'Five Hour', remainingPercent: 45 },
          { modelGroup: 'Gemini', window: 'Weekly', remainingPercent: 72 },
          { modelGroup: 'Claude', window: 'Five Hour', remainingPercent: 30 },
          { modelGroup: 'Claude', window: 'Weekly', remainingPercent: 65 }
        ]
      },
      muse: {
        status: 'ok',
        usage: { percentUsed: 25 }
      }
    }
  };

  const chip = formatQuotaChip(registry, { now });
  assert.match(chip, /\[codex 17% left! reset 1h \| agy gem 45%\/72% claude 30%\/65% \| muse 25% used \| updated 2m ago\]/);

  // No reset timestamps for agy in this registry: no countdown is invented.
  assert.doesNotMatch(chip, /agy[^|]*reset/);

  // Missing data fallback
  assert.equal(formatQuotaChip(null, { now, file: 'non_existent_file.json' }), '[quota: no data]');
});

function blockedRegistry(now, overrides = {}) {
  return {
    updatedAt: new Date(now - 60 * 1000).toISOString(),
    ttlMs: 5 * 60 * 1000,
    engines: {
      codex: { status: 'ok', usedPercent: 100, resetsAt: new Date(now + 3600 * 1000).toISOString(), spendControlReached: false, resetCreditsAvailable: 0, ...overrides },
      muse: { status: 'ok' }
    }
  };
}

test('chip BLOCKED follows the runtime quota gate', () => {
  const now = Date.now();
  const registry = blockedRegistry(now);
  assert.equal(checkEngineQuotaGate('codex', registry, now).allowed, false);
  assert.match(formatQuotaChip(registry, { now }), /codex 0% left! reset 1h BLOCKED/);

  // Spend control blocks in the gate and on the chip.
  const spend = blockedRegistry(now, { usedPercent: 10, spendControlReached: true });
  assert.match(formatQuotaChip(spend, { now }), /BLOCKED/);

  // A reset credit lets the gate through, so the chip must not claim BLOCKED.
  const credit = blockedRegistry(now, { resetCreditsAvailable: 1 });
  assert.equal(checkEngineQuotaGate('codex', credit, now).allowed, true);
  assert.doesNotMatch(formatQuotaChip(credit, { now }), /BLOCKED/);

  // 99.6% used rounds to 100 but is not 100: the gate allows it, so does the chip.
  const rounded = blockedRegistry(now, { usedPercent: 99.6 });
  assert.equal(checkEngineQuotaGate('codex', rounded, now).allowed, true);
  assert.doesNotMatch(formatQuotaChip(rounded, { now }), /BLOCKED/);

  // Stale data: the gate ignores it, so the chip does too.
  const stale = { ...blockedRegistry(now), updatedAt: new Date(now - 10 * 60 * 1000).toISOString() };
  assert.equal(checkEngineQuotaGate('codex', stale, now).allowed, true);
  assert.doesNotMatch(formatQuotaChip(stale, { now }), /BLOCKED/);
});

test('chip shows the agy reset countdown of the tightest window when resetsAt is present', () => {
  const now = 1700000000000;
  const registry = {
    updatedAt: new Date(now - 1000).toISOString(),
    engines: {
      codex: { status: 'error' },
      antigravity: {
        status: 'ok',
        quotas: [
          { modelGroup: 'Gemini', window: 'Five Hour', remainingPercent: 45, resetsAt: new Date(now + 3 * 3600 * 1000).toISOString() },
          { modelGroup: 'Claude', window: 'Five Hour', remainingPercent: 10, resetsAt: new Date(now + 1800 * 1000).toISOString() },
          { modelGroup: 'Claude', window: 'Weekly', remainingPercent: 65, resetsAt: 'not a date' }
        ]
      },
      muse: { status: 'ok' }
    }
  };
  assert.match(formatQuotaChip(registry, { now }), /agy gem 45%\/\? claude 10%\/65%! reset 30m/);
});
