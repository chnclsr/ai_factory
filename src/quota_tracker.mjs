#!/usr/bin/env node
/**
 * AI Factory - Unified Quota & Usage Tracker (v1.0)
 * Monit\u00f6rlenen Motorlar:
 * 1. Codex (OpenAI RateLimits & Reset Credits via JSON-RPC 'account/rateLimits/read')
 * 2. Antigravity (Gemini & Claude/GPT 5h/Weekly quotas via 'agy -p /usage')
 * 3. Meta Muse (Subscription & Model status via JSON-RPC 'usage/read')
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

import { stateFile } from '../lib/paths.mjs';
export const QUOTA_FILE = stateFile('quota_registry.json');

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 dakika \u00f6nbellek

// Executable bulucular
export function findCodexJs() {
  if (process.env.CODEX_EXECUTABLE && fs.existsSync(process.env.CODEX_EXECUTABLE)) {
    return process.env.CODEX_EXECUTABLE;
  }
  const defaultJs = path.join(
    process.env.APPDATA || '',
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js'
  );
  if (fs.existsSync(defaultJs)) return defaultJs;

  if (process.platform !== 'win32') {
    try { return execSync('command -v codex', { encoding: 'utf8' }).trim() || null; } catch { return null; }
  }
  try {
    const stdout = execSync('where codex', { encoding: 'utf8' }).trim();
    const firstLine = stdout.split(/\r?\n/)[0].trim();
    if (firstLine.endsWith('.js') && fs.existsSync(firstLine)) return firstLine;
    const candidate = path.join(path.dirname(firstLine), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch (e) {}

  return null;
}

export function findMuseExe() {
  if (process.env.MUSE_EXECUTABLE && fs.existsSync(process.env.MUSE_EXECUTABLE)) {
    return process.env.MUSE_EXECUTABLE;
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  const museDir = path.join(localAppData, 'Programs', 'muse');
  if (fs.existsSync(museDir)) {
    const candidates = fs.readdirSync(museDir)
      .filter(f => f.startsWith('muse-bin-') && f.endsWith('.exe'))
      .map(f => ({ path: path.join(museDir, f), mtime: fs.statSync(path.join(museDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > 0) return candidates[0].path;
  }
  try {
    const stdout = execSync(process.platform === 'win32' ? 'where muse' : 'command -v muse', { encoding: 'utf8' }).trim();
    const firstLine = stdout.split(/\r?\n/)[0].trim();
    if (fs.existsSync(firstLine)) return firstLine;
  } catch (e) {}
  return null;
}

export function findAgyExe() {
  if (process.env.ANTIGRAVITY_EXECUTABLE && fs.existsSync(process.env.ANTIGRAVITY_EXECUTABLE)) {
    return process.env.ANTIGRAVITY_EXECUTABLE;
  }
  const defaultExe = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
  if (fs.existsSync(defaultExe)) return defaultExe;
  try {
    const stdout = execSync(process.platform === 'win32' ? 'where agy' : 'command -v agy', { encoding: 'utf8' }).trim();
    const firstLine = stdout.split(/\r?\n/)[0].trim();
    if (fs.existsSync(firstLine)) return firstLine;
  } catch (e) {}
  return null;
}

// JSON-RPC stdio k\u00f6pr\u00fcs\u00fc
function rpc(executable, args, method, params, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    if (!executable || !fs.existsSync(executable)) {
      return reject(new Error('Y\u00fcr\u00fct\u00fclebilir dosya bulunamad\u0131: ' + executable));
    }
    const isJs = executable.endsWith('.js');
    const child = spawn(
      isJs ? process.execPath : executable,
      isJs ? [executable, ...args] : args,
      { windowsHide: true }
    );
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('RPC zaman a\u015f\u0131m\u0131 (' + timeoutMs + 'ms)')), timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch (e) {}
      try { child.kill(); } catch (e) {}
      if (error) reject(error);
      else resolve(result);
    }

    function send(id, name, data) {
      try {
        const payload = {
          ...(method === 'usage/read' ? { jsonrpc: '2.0' } : {}),
          ...(id == null ? {} : { id }),
          method: name,
          ...(data === undefined ? {} : { params: data })
        };
        child.stdin.write(JSON.stringify(payload) + '\n');
      } catch (e) {}
    }

    child.on('error', err => finish(err));
    child.on('exit', code => {
      if (!settled) finish(new Error('RPC s\u00fcreci kapand\u0131 (kod: ' + code + ')'));
    });

    child.stderr.on('data', () => {});
    child.stdin.on('error', err => finish(err));
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        let message;
        try { message = JSON.parse(line); } catch (e) { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error(message.error.message || 'Ba\u015flatma hatas\u0131'));
          send(null, 'initialized');
          send(2, method, params);
        } else if (message.id === 2) {
          if (message.error) return finish(new Error(message.error.message || 'Sorgu hatas\u0131'));
          finish(null, message.result);
        }
      }
    });

    send(1, 'initialize', { clientInfo: { name: 'quota_tracker', version: '1.0' } });
  });
}

// 1. Codex Kotas\u0131
export async function queryCodexQuota(timeoutMs = 25000) {
  const codexJs = findCodexJs();
  if (!codexJs) return { error: 'Codex y\u00fcr\u00fct\u00fcc\u00fcs\u00fc bulunamad\u0131' };
  try {
    const raw = await rpc(codexJs, ['app-server'], 'account/rateLimits/read', {}, timeoutMs);
    const primary = raw?.rateLimits?.primary || {};
    const credits = raw?.rateLimitResetCredits || {};
    return {
      status: 'ok',
      planType: raw?.rateLimits?.planType || 'unknown',
      usedPercent: primary.usedPercent != null ? primary.usedPercent : null,
      remainingPercent: primary.usedPercent != null ? Math.max(0, 100 - primary.usedPercent) : null,
      resetsAt: primary.resetsAt ? new Date(primary.resetsAt * 1000).toISOString() : null,
      windowDurationMins: primary.windowDurationMins || null,
      spendControlReached: raw?.rateLimits?.spendControlReached || false,
      ordinaryUsageAllowed: raw?.ordinaryUsageAllowed ?? true,
      resetCreditsAvailable: credits.availableCount || 0,
      observedAt: new Date().toISOString()
    };
  } catch (err) {
    return { status: 'error', error: err.message, observedAt: new Date().toISOString() };
  }
}

// 2. Antigravity Kotas\u0131
export function queryAntigravityQuota(timeoutMs = 25000) {
  return new Promise(resolve => {
    const agyExe = findAgyExe();
    if (!agyExe) return resolve({ status: 'error', error: 'Antigravity (agy) bulunamad\u0131' });

    const child = spawn(agyExe, ['--print-timeout', '15s', '-p', '/usage'], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      resolve({ status: 'error', error: 'Antigravity kullan\u0131m sorgusu zaman a\u015f\u0131m\u0131na u\u011frad\u0131' });
    }, timeoutMs);

    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ status: 'error', error: err.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      const rows = stdout
        .split(/\r?\n/)
        .filter(line => /Limit Remaining/i.test(line))
        .map(line => {
          const parts = line.split('\t');
          return {
            modelGroup: parts[0]?.trim(),
            window: parts[1]?.trim(),
            remainingPercent: parseFloat(parts[2]),
            resetsAt: parts[3]?.trim()
          };
        });
      resolve({
        status: code === 0 ? 'ok' : 'error',
        exitCode: code,
        quotas: rows,
        observedAt: new Date().toISOString()
      });
    });
  });
}

// 3. Meta Muse Kotas\u0131
export async function queryMuseQuota(timeoutMs = 20000) {
  const museExe = findMuseExe();
  if (!museExe) return { status: 'error', error: 'Muse y\u00fcr\u00fct\u00fcc\u00fcs\u00fc bulunamad\u0131' };
  try {
    const res = await rpc(museExe, ['serve', '--no-session-log', '--disable-shell', '--disable-write'], 'usage/read', {}, timeoutMs);
    return {
      status: 'ok',
      tier: 'muse-spark-1.3-contributor (0$ Community Contributor)',
      usage: res?.usage || null,
      note: res?.usage ? 'Abonelik kullan\u0131m verisi mevcut' : 'Muse aktif; kullan\u0131m kotas\u0131 bildirilmedi',
      observedAt: new Date().toISOString()
    };
  } catch (err) {
    return { status: 'error', error: err.message, observedAt: new Date().toISOString() };
  }
}

// T\u00fcm Kotalar\u0131 Toplama ve Kaydetme
export async function fetchAllQuotas({ force = false, timeoutMs = 25000 } = {}) {
  // \u00d6nbellek kontrol\u00fc
  if (!force && fs.existsSync(QUOTA_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
      const age = Date.now() - new Date(cached.updatedAt).getTime();
      if (age < (cached.ttlMs || DEFAULT_TTL_MS)) {
        return cached;
      }
    } catch (e) {}
  }

  const [codex, antigravity, muse] = await Promise.all([
    queryCodexQuota(timeoutMs),
    queryAntigravityQuota(timeoutMs),
    queryMuseQuota(timeoutMs)
  ]);

  const payload = {
    updatedAt: new Date().toISOString(),
    ttlMs: DEFAULT_TTL_MS,
    engines: {
      muse,
      codex,
      antigravity
    }
  };

  // Atomik kay\u0131t
  try {
    const tmp = `${QUOTA_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, QUOTA_FILE);
  } catch (e) {}

  return payload;
}

// Quota Gate Kontrol\u00fc (Router pre-flight denetimi)
export function checkEngineQuotaGate(engine, quotaRegistry = null) {
  let reg = quotaRegistry;
  if (!reg && fs.existsSync(QUOTA_FILE)) {
    try {
      reg = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    } catch (e) {}
  }
  if (!reg?.engines) return { allowed: true };
  if (reg.updatedAt && Date.now() - Date.parse(reg.updatedAt) >= (reg.ttlMs || DEFAULT_TTL_MS)) return { allowed: true };

  const eng = engine.toLowerCase();
  if (eng === 'codex') {
    const c = reg.engines.codex;
    if (c && c.status === 'ok') {
      if (c.spendControlReached) {
        return { allowed: false, reason: 'Codex harcama kontrol s\u0131n\u0131r\u0131na ula\u015f\u0131ld\u0131 (Spend control reached)' };
      }
      if (c.usedPercent !== null && c.usedPercent >= 100 && c.resetCreditsAvailable === 0) {
        return {
          allowed: false,
          reason: `Codex haftal\u0131k kullan\u0131m kotas\u0131 doldu (%100 kullan\u0131ld\u0131, s\u0131f\u0131rlanma: ${c.resetsAt})`,
          remainingPercent: 0
        };
      }
    }
  }

  return { allowed: true };
}

// G\u00fczel Terminal Tablosu
export function formatQuotaTable(data) {
  const e = data.engines || {};
  const dateStr = new Date(data.updatedAt).toLocaleString('tr-TR');
  const lines = [];

  lines.push('='.repeat(78));
  lines.push('  AI FACTORY - B\u0130RLE\u015e\u0130K MODEL & MOTOR KOTA RAPORU');
  lines.push(`  Son G\u00fcncelleme: ${dateStr}  |  \u00d6nbellek TTL: 5 dk`);
  lines.push('='.repeat(78));
  lines.push(
    'MOTOR'.padEnd(14) +
    'DURUM'.padEnd(10) +
    'KALAN KOTA / KULLANIM'.padEnd(28) +
    'DETAY & SIFIRLANMA'
  );
  lines.push('-'.repeat(78));

  // 1. Muse
  const m = e.muse;
  if (m && m.status === 'ok') {
    lines.push(
      'Meta Muse'.padEnd(14) +
      'AKTIF'.padEnd(10) +
      'Kota: sa\u011flay\u0131c\u0131ya ba\u011fl\u0131'.padEnd(28) +
      'muse-spark-1.3-contributor modeli'
    );
  } else {
    lines.push('Meta Muse'.padEnd(14) + 'HATA'.padEnd(10) + (m?.error || 'Ula\u015f\u0131lam\u0131yor').slice(0, 50));
  }

  // 2. Codex
  const c = e.codex;
  if (c && c.status === 'ok') {
    const usedStr = c.usedPercent != null ? `%${c.remainingPercent}% kalan (%${c.usedPercent} kul.)` : 'Bilinmiyor';
    const detail = `Plan: ${c.planType.toUpperCase()} | Reset Kredisi: ${c.resetCreditsAvailable}`;
    lines.push(
      'Codex (OpenAI)'.padEnd(14) +
      'AKTIF'.padEnd(10) +
      usedStr.padEnd(28) +
      detail
    );
  } else {
    lines.push('Codex (OpenAI)'.padEnd(14) + 'HATA'.padEnd(10) + (c?.error || 'Ula\u015f\u0131lam\u0131yor').slice(0, 50));
  }

  // 3. Antigravity
  const a = e.antigravity;
  if (a && a.status === 'ok' && a.quotas?.length > 0) {
    const gem5 = a.quotas.find(q => q.modelGroup?.includes('Gemini') && q.window?.includes('Five Hour'));
    const gemW = a.quotas.find(q => q.modelGroup?.includes('Gemini') && q.window?.includes('Weekly'));
    const gpt5 = a.quotas.find(q => q.modelGroup?.includes('Claude') && q.window?.includes('Five Hour'));
    const gptW = a.quotas.find(q => q.modelGroup?.includes('Claude') && q.window?.includes('Weekly'));

    lines.push(
      'Antigravity'.padEnd(14) +
      'AKTIF'.padEnd(10) +
      `Gemini: %${gem5?.remainingPercent ?? '?'} (5s) / %${gemW?.remainingPercent ?? '?'} (H)`.padEnd(28) +
      `GPT/Claude: %${gpt5?.remainingPercent ?? '?'} (5s) / %${gptW?.remainingPercent ?? '?'} (H)`
    );
  } else {
    lines.push('Antigravity'.padEnd(14) + 'HATA'.padEnd(10) + (a?.error || 'Ula\u015f\u0131lam\u0131yor').slice(0, 50));
  }

  lines.push('='.repeat(78));
  return lines.join('\n');
}

// CLI olarak do\u011frudan \u00e7a\u011fr\u0131l\u0131rsa
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const force = process.argv.includes('--refresh') || process.argv.includes('-r');
  const asJson = process.argv.includes('--json');

  fetchAllQuotas({ force })
    .then(data => {
      if (asJson) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log('\n' + formatQuotaTable(data) + '\n');
      }
      process.exit(0);
    })
    .catch(err => {
      console.error('[Quota Tracker Hatas\u0131]', err);
      process.exit(1);
    });
}

