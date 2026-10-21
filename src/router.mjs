#!/usr/bin/env node
/**
 * AI Factory - Smart Router Engine (v2.1 - Hardened & Supervised)
 * Antigravity (orkestrasyon) -> OpenCode ücretsiz zincir -> Muse Contributor -> Codex free / Gemini (Supervisor)
 * 
 * Hardened Features (Codex Sol Review Verified):
 * - Atomic JSON State Writes (Lost-update & parse error prevention)
 * - Exclusive Half-Open Probe Lease (Thundering herd prevention)
 * - Signal-Aware Exit Codes & Empty Output Detection
 * - Strict Fallback Eligibility (Immediate abort on user cancel or invalid request)
 * - Watchdog Timeout Quarantining & Process Tree Termination
 * - Safe Model Alias Normalization (Object.hasOwn)
 * - Dynamic Session ID extraction from CLI outputs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import crypto from 'crypto';
import { fetchAllQuotas, formatQuotaTable, checkEngineQuotaGate } from './quota_tracker.mjs';
import { ROOT, CONFIG_FILE, stateFile } from '../lib/paths.mjs';
import { decideWatchdogAction, sampleTreeCpuMs } from './watchdog.mjs';

const __dirname = ROOT;
const REGISTRY_FILE = stateFile('session_registry.json');
const HEALTH_FILE = stateFile('health_registry.json');

function loadJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const content = fs.readFileSync(file, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    const tmpFile = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpFile, file);
  } catch (e) {
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error(`[AI Factory Warning] JSON kaydedilemedi (${file}):`, err.message);
    }
  }
}

// \u2500\u2500 Circuit Breaker & Health Management \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function getHealthRegistry() {
  return loadJson(HEALTH_FILE, { engines: {} });
}

function getEngineHealth(engine) {
  const reg = getHealthRegistry();
  if (!reg.engines[engine]) {
    reg.engines[engine] = {
      state: 'CLOSED', // CLOSED (sa\u011fl\u0131kl\u0131), OPEN (karantina), HALF_OPEN (tek probe)
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      quarantineUntil: 0,
      probeLeaseUntil: 0,
      lastError: null,
      updatedAt: new Date().toISOString()
    };
  }
  return reg.engines[engine];
}

function canExecuteEngine(engine, config) {
  // 0. Kota \u00d6n Denetimi (Kota t\u00fckenmi\u015fse do\u011frudan sonraki motora atla)
  // Health keys may be per model ("opencode:<model>"); quota is tracked per engine.
  const quotaCheck = checkEngineQuotaGate(engine.split(':')[0]);
  if (!quotaCheck.allowed) {
    console.warn(`[AI Factory Quota Gate] "${engine}" kotas\u0131 yetersiz: ${quotaCheck.reason}`);
    return { allowed: false, probe: false, reason: quotaCheck.reason };
  }

  const reg = getHealthRegistry();
  if (!reg.engines[engine]) {
    reg.engines[engine] = {
      state: 'CLOSED',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      quarantineUntil: 0,
      probeLeaseUntil: 0,
      lastError: null,
      updatedAt: new Date().toISOString()
    };
  }
  const health = reg.engines[engine];
  const now = Date.now();

  if (health.state === 'CLOSED') {
    return { allowed: true, probe: false };
  }

  if (health.state === 'OPEN') {
    if (now >= health.quarantineUntil) {
      // Cooldown doldu -> Tek test (HALF_OPEN) a\u015famas\u0131na ge\u00e7 ve atomik lease al
      health.state = 'HALF_OPEN';
      health.probeLeaseUntil = now + 90000; // 90 saniyelik tek probe rezervasyonu
      health.updatedAt = new Date().toISOString();
      saveJson(HEALTH_FILE, reg);
      console.log(`[AI Factory Circuit-Breaker] "${engine}" cooldown bitti. Tek test (HALF_OPEN probe) izni verildi.`);
      return { allowed: true, probe: true, reason: 'Cooldown doldu, tek probe denemesi' };
    }
    const remainingSec = Math.max(1, Math.round((health.quarantineUntil - now) / 1000));
    return { allowed: false, probe: false, reason: `Motor karantinada (kalan: ${remainingSec}s, son hata: ${health.lastError || 'bilinmiyor'})` };
  }

  if (health.state === 'HALF_OPEN') {
    // E\u015fzamanl\u0131 ba\u015fka bir probe lease'i devam ediyor mu?
    if (health.probeLeaseUntil && now < health.probeLeaseUntil) {
      return { allowed: false, probe: false, reason: 'Ba\u015fka bir test \u00e7a\u011fr\u0131s\u0131 (HALF_OPEN probe) hen\u00fcz s\u00fcr\u00fcyor' };
    }
    // S\u00fcresi ge\u00e7mi\u015fse yeni probe lease ver
    health.probeLeaseUntil = now + 90000;
    health.updatedAt = new Date().toISOString();
    saveJson(HEALTH_FILE, reg);
    return { allowed: true, probe: true, reason: 'Yenilenen probe izni' };
  }

  return { allowed: true, probe: false };
}

function recordEngineSuccess(engine, config) {
  const reg = getHealthRegistry();
  const health = reg.engines[engine] || getEngineHealth(engine);
  const target = config?.circuit_breaker?.recovery_success_target || 2;

  if (health.state === 'HALF_OPEN') {
    health.consecutiveSuccesses = (health.consecutiveSuccesses || 0) + 1;
    health.probeLeaseUntil = 0;
    if (health.consecutiveSuccesses >= target) {
      health.state = 'CLOSED';
      health.consecutiveFailures = 0;
      health.consecutiveSuccesses = 0;
      health.quarantineUntil = 0;
      health.lastError = null;
      console.log(`[AI Factory Circuit-Breaker] "${engine}" motoru ${target} ard\u0131\u015f\u0131k ba\u015far\u0131 ile tamamen kurtar\u0131ld\u0131 (CLOSED).`);
    } else {
      console.log(`[AI Factory Circuit-Breaker] "${engine}" probe ba\u015far\u0131l\u0131 (${health.consecutiveSuccesses}/${target}).`);
    }
  } else if (health.state === 'CLOSED') {
    health.consecutiveFailures = 0;
    health.consecutiveSuccesses = 0;
    health.probeLeaseUntil = 0;
  }

  health.updatedAt = new Date().toISOString();
  reg.engines[engine] = health;
  saveJson(HEALTH_FILE, reg);
}

function recordEngineFailure(engine, classifiedError, config) {
  const reg = getHealthRegistry();
  const health = reg.engines[engine] || getEngineHealth(engine);

  const baseMs = config?.circuit_breaker?.quarantine_base_ms || 45000;
  const maxMs = config?.circuit_breaker?.quarantine_max_ms || 600000;

  health.consecutiveFailures = (health.consecutiveFailures || 0) + 1;
  health.consecutiveSuccesses = 0;
  health.probeLeaseUntil = 0;
  health.lastError = classifiedError.reason || 'Bilinmeyen hata';

  if (classifiedError.quarantine) {
    health.state = 'OPEN';
    const backoff = Math.min(baseMs * Math.pow(2, health.consecutiveFailures - 1), maxMs);
    health.quarantineUntil = Date.now() + backoff;
    console.warn(`[AI Factory Circuit-Breaker] \u26d4 "${engine}" motoru ${Math.round(backoff / 1000)}s s\u00fcreyle karantinaya al\u0131nd\u0131 (OPEN).`);
  }

  health.updatedAt = new Date().toISOString();
  reg.engines[engine] = health;
  saveJson(HEALTH_FILE, reg);
}

// \u2500\u2500 Error Classification \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function classifyError(exitCode, outputText, resMeta = {}) {
  const text = (outputText || '').toLowerCase();

  // 1. Watchdog Zaman A\u015f\u0131m\u0131 Kontrol\u00fc
  if (resMeta.watchdogTimeout) {
    return {
      kind: 'watchdog_timeout',
      fallbackEligible: true,
      quarantine: true,
      reason: resMeta.watchdogReason || (resMeta.initialHang
        ? '30 saniyelik ilk \u00e7\u0131kt\u0131 zaman a\u015f\u0131m\u0131 (H\u0131zl\u0131 Ba\u015flang\u0131\u00e7 Bek\u00e7isi)'
        : 'Sessizlik zaman a\u015f\u0131m\u0131 (Watchdog Timeout)')
    };
  }

  // 2. Kullan\u0131c\u0131 veya Sistem \u0130ptali (Abort) -> ASLA FALLBACK YAPMA!
  if (text.includes('aborted') || text.includes('cancelled') || text.includes('sigint') || resMeta.signal === 'SIGINT') {
    return {
      kind: 'aborted',
      fallbackEligible: false,
      quarantine: false,
      reason: 'Kullan\u0131c\u0131 veya sistem iptali'
    };
  }

  // 3. Desteklenmeyen Model veya Auth Hatas\u0131
  if (text.includes('not supported when using codex with a chatgpt account') || text.includes('model not found') || text.includes('model unavailable') || text.includes('unauthorized')) {
    return {
      kind: 'unsupported_model',
      fallbackEligible: true,
      quarantine: false,
      reason: 'Hesap bu modeli desteklemiyor veya model şu anda kullanılamıyor'
    };
  }

  // 4. Kapasite, Rate-Limit ve A\u011f Zaman A\u015f\u0131m\u0131 (Karantina uygulan\u0131r)
  if (
    text.includes('429') ||
    text.includes('rate limit') ||
    text.includes('quota') ||
    text.includes('overloaded') ||
    text.includes('503') ||
    text.includes('502') ||
    text.includes('504') ||
    text.includes('etimedout') ||
    text.includes('econnreset') ||
    text.includes('econnrefused')
  ) {
    return {
      kind: 'capacity_or_network',
      fallbackEligible: true,
      quarantine: true,
      reason: 'Rate-limit, kota t\u00fckenmesi veya a\u011f ba\u011flant\u0131 hatas\u0131'
    };
  }

  // 5. Ge\u00e7ersiz \u0130stek Parametresi / S\u00f6zdizimi -> Fallback gereksiz
  if (text.includes('invalid_request_error') || text.includes('bad request') || text.includes('maximum context length')) {
    return {
      kind: 'invalid_request',
      fallbackEligible: false,
      quarantine: false,
      reason: 'Ge\u00e7ersiz istek parametresi veya ba\u011flam ta\u015fmas\u0131'
    };
  }

  return {
    kind: 'general_failure',
    fallbackEligible: true,
    quarantine: false,
    reason: `S\u00fcre\u00e7 hatas\u0131 (exit code ${exitCode})`
  };
}

// \u2500\u2500 Process Execution & Watchdog \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /t /f`, { stdio: 'ignore', timeout: 5000 });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch (e) {}
}

async function runCommand(cmdString, cwd, engineName, config) {
  const initialTimeoutMs = config?.watchdog?.initial_timeout_ms || 30000; // \u0130lk 30s hi\u00e7 \u00e7\u0131kt\u0131 gelmezse kilitlenme say\u0131l\u0131r
  const idleTimeoutMs = config?.watchdog?.idle_timeout_ms || 120000; // \u00c7\u0131kt\u0131 sonras\u0131 120s sessizlik zaman a\u015f\u0131m\u0131
  const checkIntervalMs = config?.watchdog?.check_interval_ms || 5000;
  const maxExecutionMs = config?.watchdog?.max_execution_time_ms || 600000;
  const cpuStillLimitMs = config?.watchdog?.cpu_still_limit_ms || idleTimeoutMs;
  const configuredChecks = config?.watchdog?.status_checkpoints_ms;
  const statusCheckpointsMs = Array.isArray(configuredChecks) && configuredChecks.length > 0 &&
    configuredChecks.every((value, index) => Number.isInteger(value) && value > 0 &&
      (index === 0 || value > configuredChecks[index - 1]))
    ? configuredChecks : [30000, 120000, 240000];
  const statusRepeatMs = Number.isInteger(config?.watchdog?.status_repeat_ms) &&
    config.watchdog.status_repeat_ms > 0 ? config.watchdog.status_repeat_ms : 120000;
  const startTime = Date.now();
  let hasReceivedAnyOutput = false;
  let sessionId = null;
  let hasResponse = false;
  let cliError = false;
  let jsonRemainder = '';
  function inspectJsonLine(line) {
    try {
      const event = JSON.parse(line);
      sessionId = event.sessionID || event.session_id || sessionId;
      if (event.type === 'error' || event.is_error) cliError = true;
      if (event.type === 'text' && event.part?.text) {
        hasResponse = true;
        process.stdout.write(event.part.text + '\n');
      }
      if (event.type === 'result' && event.result) {
        hasResponse = true;
        process.stdout.write(event.result + '\n');
      }
      if (event.type === 'error') process.stderr.write(line + '\n');
    } catch (e) {}
  }

  return new Promise((resolve, reject) => {
    console.log(`\n[AI Factory Launcher] Running in ${cwd}:`);
    console.log(`> ${cmdString}\n`);

    const depth = parseInt(process.env.AI_FACTORY_ROUTER_DEPTH || '0', 10);
    const safeDepth = Number.isSafeInteger(depth) && depth >= 0 ? depth : 0;

    const child = spawn(cmdString, [], {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        AI_FACTORY_ROUTER_DEPTH: String(safeDepth + 1),
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let lastActivityAt = Date.now();
    let tailBuffer = [];
    let isFinished = false;
    let previousCpuMs = null;
    let lastCpuProgressAt = Date.now();
    let lastWatchdogNoticeAt = 0;
    let statusCheckIndex = 0;
    let nextStatusAt = statusCheckpointsMs[0];

    console.warn('[AI-FACTORY-WATCHDOG] started: ' + engineName + ' PID ' + child.pid +
      '; checks at ' + statusCheckpointsMs.map(ms => ms / 1000).join('/') +
      's, then every ' + statusRepeatMs / 1000 + 's; hard limit ' + maxExecutionMs / 1000 + 's.');

    function handleData(chunk, streamName) {
      hasReceivedAnyOutput = true;
      lastActivityAt = Date.now();
      previousCpuMs = null;
      lastCpuProgressAt = lastActivityAt;
      const str = chunk.toString('utf8');
      if (streamName === 'stdout' && (engineName === 'opencode' || engineName === 'claude')) {
        jsonRemainder += str;
        const jsonLines = jsonRemainder.split('\n');
        jsonRemainder = jsonLines.pop();
        for (const line of jsonLines) inspectJsonLine(line);
      }
      if (streamName === 'stdout' && engineName !== 'opencode' && engineName !== 'claude') {
        process.stdout.write(str);
      } else if (streamName === 'stderr') {
        process.stderr.write(str);
      }
      const lines = str.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          tailBuffer.push(line);
          if (tailBuffer.length > 100) tailBuffer.shift();
        }
      }
    }

    if (child.stdout) child.stdout.on('data', d => handleData(d, 'stdout'));
    if (child.stderr) child.stderr.on('data', d => handleData(d, 'stderr'));

    function finishWatchdog(reason) {
      clearInterval(watchdogInterval);
      isFinished = true;
      console.warn('\n[AI-FACTORY-WATCHDOG] ' + engineName + ': ' + reason +
        '; elapsed=' + (Date.now() - startTime) + 'ms, idle=' + (Date.now() - lastActivityAt) + 'ms. Terminating process tree.');
      killProcessTree(child.pid);
      resolve({ exitCode: 42, signal: 'SIGKILL', watchdogTimeout: true,
        watchdogReason: reason, initialHang: !hasReceivedAnyOutput, output: tailBuffer.join('\n') });
    }

    const watchdogInterval = setInterval(() => {
      if (isFinished) return;
      let now = Date.now();
      const elapsedMs = now - startTime;
      if (elapsedMs >= nextStatusAt) {
        let processAlive = false;
        try { processAlive = !!child.pid && process.kill(child.pid, 0); } catch {}
        console.warn('[AI-FACTORY-WATCHDOG] status: ' + engineName +
          ' process_alive=' + processAlive + ', elapsed=' + Math.round(elapsedMs / 1000) +
          's, idle=' + Math.round((now - lastActivityAt) / 1000) + 's.');
        statusCheckIndex++;
        nextStatusAt = statusCheckIndex < statusCheckpointsMs.length
          ? statusCheckpointsMs[statusCheckIndex] : nextStatusAt + statusRepeatMs;
      }
      // The hard deadline applies even when the engine keeps emitting output.
      if (now - startTime >= maxExecutionMs) { finishWatchdog('hard_timeout'); return; }
      const thresholdMs = hasReceivedAnyOutput ? idleTimeoutMs : initialTimeoutMs;
      if (now - lastActivityAt < thresholdMs) return;

      const sample = sampleTreeCpuMs(child.pid);
      now = Date.now();
      const cpuKnown = sample.cpuMs !== null;
      const cpuAdvanced = cpuKnown && (previousCpuMs === null || sample.cpuMs !== previousCpuMs);
      // A new sample or changing process tree starts a fresh observation window.
      if (!cpuKnown || cpuAdvanced) lastCpuProgressAt = now;
      previousCpuMs = sample.cpuMs;
      const decision = decideWatchdogAction({
        elapsedMs: now - startTime, idleMs: now - lastActivityAt, thresholdMs,
        maxExecutionMs, treeAlive: sample.alive, cpuKnown, cpuAdvanced,
        cpuStillMs: now - lastCpuProgressAt, cpuStillLimitMs
      });
      if (decision.action === 'kill') { finishWatchdog(decision.reason); return; }
      if (decision.action === 'postpone' && now - lastWatchdogNoticeAt >= 30000) {
        lastWatchdogNoticeAt = now;
        console.warn('[AI-FACTORY-WATCHDOG] ' + engineName + ': checking silent process; CPU ' +
          (cpuKnown ? (cpuAdvanced ? 'progressing' : 'unchanged') : 'unavailable') +
          ', hard deadline in ' + Math.max(0, Math.ceil((maxExecutionMs - (now - startTime)) / 1000)) + 's.');
      }
    }, checkIntervalMs);

    child.on('close', (code, signal) => {
      if (isFinished) return;
      isFinished = true;
      clearInterval(watchdogInterval);
      if (jsonRemainder.trim() && (engineName === 'opencode' || engineName === 'claude')) inspectJsonLine(jsonRemainder);
      // P1 D\u00fczeltmesi: Sinyalle kapat\u0131ld\u0131ysa (signal != null) veya code null ise asla 0 sayma!
      const effectiveCode = signal ? 1 : (code ?? 1);
      resolve({
        exitCode: effectiveCode,
        signal,
        watchdogTimeout: false,
        output: tailBuffer.join('\n'),
        sessionId,
        hasResponse,
        cliError
      });
    });

    child.on('error', err => {
      if (isFinished) return;
      isFinished = true;
      clearInterval(watchdogInterval);
      resolve({
        exitCode: -1,
        signal: null,
        watchdogTimeout: false,
        output: err.message
      });
    });
  });
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    task: '',
    name: '',
    resume: '',
    engine: '',
    model: '',
    quota: false,
    noFallback: false,
    reasoningEffort: '',
    cwd: process.cwd()
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--task' || arg === '-t') {
      options.task = args[++i] || '';
    } else if (arg === '--name' || arg === '-n') {
      options.name = args[++i] || '';
    } else if (arg === '--resume' || arg === '-r') {
      options.resume = args[++i] || '';
    } else if (arg === '--engine' || arg === '-e') {
      options.engine = (args[++i] || '').toLowerCase().trim();
    } else if (arg === '--model' || arg === '-m') {
      options.model = (args[++i] || '').trim();
    } else if (arg === '--quota' || arg === '-q') {
      options.quota = true;
    } else if (arg === '--no-fallback') {
      options.noFallback = true;
    } else if (arg === '--reasoning-effort' || arg === '--effort') {
      options.reasoningEffort = (args[++i] || '').toLowerCase().trim();
    } else if (arg === '--cwd') {
      options.cwd = args[++i] || process.cwd();
    } else if (!options.task && !arg.startsWith('-')) {
      options.task = arg;
    }
  }
  return options;
}

const ENGINES = ['opencode', 'muse', 'codex', 'claude'];

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

// Finds a configured model by key, provider ID or alias; returns { engine, model } or null.
function findModel(rawModel, config, onlyEngine = '') {
  const wanted = normalizeName(rawModel);
  if (!wanted) return null;
  for (const engine of onlyEngine ? [onlyEngine] : ENGINES) {
    const models = config?.engines?.[engine]?.models || {};
    for (const [key, entry] of Object.entries(models)) {
      const names = [key, entry.id, ...(entry.aliases || [])].map(normalizeName);
      if (names.includes(wanted)) return { engine, model: key };
    }
  }
  return null;
}

// Finds the longest configured model alias named in free text ("deepseek ile yap", "Opus 5.5").
function findModelInText(text, config) {
  const lower = text.toLowerCase();
  let best = null;
  for (const engine of ENGINES) {
    for (const [key, entry] of Object.entries(config?.engines?.[engine]?.models || {})) {
      for (const name of [key, entry.id, ...(entry.aliases || [])]) {
        const pattern = name.toLowerCase().split(/[\s-]+/)
          .map(part => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('[\\s-]+');
        if (new RegExp(`(?<![a-z0-9.])${pattern}(?![a-z0-9]|\\.\\d)`).test(lower) &&
          (!best || name.length > best.length)) {
          best = { engine, model: key, length: name.length, alias: name };
        }
      }
    }
  }
  return best;
}

function hasKeyword(lower, kw) {
  const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(lower);
}

function decideEngineAndModel(task, config, forcedEngine, forcedModel) {
  if (forcedEngine) {
    const engine = forcedEngine.toLowerCase();
    if (engine === 'gemini') return { engine, model: 'gemini', reason: 'Kullan\u0131c\u0131 taraf\u0131ndan zorland\u0131' };
    // Muse is hard-locked to the free contributor model regardless of the requested model.
    if (engine === 'muse') return { engine, model: 'muse-spark-1.3-contributor', reason: 'Kullan\u0131c\u0131 taraf\u0131ndan zorland\u0131' };
    const found = forcedModel ? findModel(forcedModel, config, engine) : null;
    if (forcedModel && !found && engine === 'codex') throw new Error(`Unsupported codex model: ${forcedModel}`);
    const model = found ? found.model : (forcedModel || config.engines[engine].default_model);
    return { engine, model, reason: 'Kullan\u0131c\u0131 taraf\u0131ndan zorland\u0131' };
  }

  if (forcedModel) {
    const found = findModel(forcedModel, config);
    if (!found) throw new Error(`Unknown model: ${forcedModel}`);
    return { ...found, reason: `Kullan\u0131c\u0131 modeli se\u00e7ti: ${forcedModel}` };
  }

  // An explicitly named model always wins.
  const named = findModelInText(task, config);
  if (named) return { engine: named.engine, model: named.model, reason: `Model ad\u0131 belirtildi: "${named.alias}"` };

  const lower = task.toLowerCase();
  for (const kw of (config?.routing_rules?.gemini_keywords || [])) {
    if (lower.includes(kw)) {
      return { engine: 'gemini', model: 'gemini', reason: `Gemini do\u011frudan devam anahtar kelimesi: "${kw}"` };
    }
  }

  for (const engine of ENGINES) {
    for (const kw of (config?.routing_rules?.[`${engine}_keywords`] || [])) {
      if (hasKeyword(lower, kw)) {
        return { engine, model: config.engines[engine].default_model, reason: `${engine} anahtar kelimesi: ${kw}` };
      }
    }
  }

  const first = config.fallback_chain[0];
  return { engine: first.engine, model: first.model, reason: 'Varsay\u0131lan \u00fccretsiz zincir' };
}

function resolveCodexModel(rawModel, config) {
  const found = findModel(rawModel, config, 'codex');
  if (!found) throw new Error(`Unsupported codex model: ${rawModel}`);
  return config.engines.codex.models[found.model].id;
}

async function executeCodex(task, model, cwd, resumeSessionId, config) {
  const codexModel = resolveCodexModel(model, config);
  const promptFile = stateFile(`.codex_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
  fs.writeFileSync(promptFile, task, 'utf8');

  let cmd = '';
  if (resumeSessionId) {
    cmd = `codex exec resume ${resumeSessionId} - < "${promptFile}"`;
  } else {
    cmd = `codex -c sandbox_workspace_write.network_access=true exec --skip-git-repo-check --enable prefer_mxc -m ${codexModel} -C "${cwd}" -s workspace-write - < "${promptFile}"`;
  }

  try {
    return await runCommand(cmd, cwd, 'codex', config);
  } finally {
    try { fs.unlinkSync(promptFile); } catch (e) {}
  }
}

function resolveExternalModel(engine, model, config) {
  const models = config?.engines?.[engine]?.models || {};
  const entry = models[model] || Object.values(models).find(item => item.id === model);
  if (!entry || !/^[a-z0-9./-]+$/.test(entry.id)) throw new Error(`Unsupported ${engine} model: ${model}`);
  if (engine === 'opencode' && (entry.cost_input_per_m !== 0 || entry.cost_output_per_m !== 0 ||
    !/^opencode\/(?:big-pickle|[a-z0-9.-]+-free)$/.test(entry.id))) {
    throw new Error(`OpenCode model is not verified free: ${entry.id}`);
  }
  if (engine === 'claude') {
    const opus55 = entry.id === 'claude-opus-5-5';
    if (!opus55 && !/^claude-(?:haiku|sonnet)-[a-z0-9-]+$/.test(entry.id)) {
      throw new Error(`Claude model is outside the configured allowlist: ${entry.id}`);
    }
    if (entry.cost_input_per_m > (opus55 ? 4 : 2) || entry.cost_output_per_m > (opus55 ? 20 : 10) ||
      !Number.isFinite(entry.cost_input_per_m) || !Number.isFinite(entry.cost_output_per_m)) {
      throw new Error(`Claude model exceeds the configured cost ceiling: ${entry.id}`);
    }
  }
  return entry.id;
}

async function executeOpenCode(task, model, cwd, resumeSessionId, config) {
  const promptFile = stateFile(`.opencode_prompt_${Date.now()}_${crypto.randomUUID()}.txt`);
  fs.writeFileSync(promptFile, task, 'utf8');
  let cmd = `opencode run --format json --model ${model}`;
  if (resumeSessionId) cmd += ` --session ${resumeSessionId}`;
  cmd += ` "Follow the instructions in the attached task file." --file "${promptFile}"`;
  try {
    return await runCommand(cmd, cwd, 'opencode', config);
  } finally {
    try { fs.unlinkSync(promptFile); } catch (e) {}
  }
}

const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Picks Claude's --effort: an explicit --reasoning-effort flag wins outright; otherwise a level the
// user names in the task text (e.g. "max effort", "xhigh") also wins, even above the auto cap; absent
// either, complexity keywords raise it to "high", and routine tasks stay at "medium". Auto-selection
// never goes past "high" on its own — xhigh/max require the user to ask for them.
function decideClaudeEffort(task, config, forcedEffort) {
  if (forcedEffort) {
    const level = normalizeName(forcedEffort);
    if (!CLAUDE_EFFORT_LEVELS.includes(level)) throw new Error(`Unsupported reasoning effort: ${forcedEffort}`);
    return { level, reason: 'Kullanıcı tarafından zorlandı (--reasoning-effort)' };
  }

  const lower = (task || '').toLowerCase();
  const effortKeywords = config?.routing_rules?.claude_effort_keywords || {};
  for (const level of ['max', 'xhigh', 'high', 'medium', 'low']) {
    for (const kw of (effortKeywords[level] || [])) {
      if (hasKeyword(lower, kw)) return { level, reason: `Görevde belirtilen effort: "${kw}"` };
    }
  }

  for (const kw of (config?.routing_rules?.complexity_keywords || [])) {
    if (hasKeyword(lower, kw)) return { level: 'high', reason: `Karmaşık görev anahtar kelimesi: ${kw}` };
  }

  return { level: 'medium', reason: 'Standart görev' };
}

async function executeClaude(task, model, cwd, resumeSessionId, config, effort) {
  const promptFile = stateFile(`.claude_prompt_${Date.now()}_${crypto.randomUUID()}.txt`);
  fs.writeFileSync(promptFile, task, 'utf8');
  let cmd = `claude -p --output-format json --model ${model} --fallback-model ${model} --permission-mode acceptEdits --permission-prompts none`;
  if (effort) cmd += ` --effort ${effort}`;
  if (resumeSessionId) cmd += ` --resume ${resumeSessionId}`;
  cmd += ` < "${promptFile}"`;
  try {
    return await runCommand(cmd, cwd, 'claude', config);
  } finally {
    try { fs.unlinkSync(promptFile); } catch (e) {}
  }
}

function resolveMuseModel(rawModel, config) {
  // G\u00dcVENL\u0130K K\u0130L\u0130D\u0130 (HARD-LOCK):
  // Muse her zaman ve istisnas\u0131z 0$ \u00fccretsiz olan 'muse-spark-1.3-contributor' modelini kullanmal\u0131d\u0131r!
  // 'muse-spark-1.3' tek ba\u015f\u0131na \u00fccretli ticari modeldir ve kullan\u0131c\u0131n\u0131n kart\u0131ndan para \u00e7eker!
  // Bu y\u00fczden ne istenirse istensin model daima 'muse-spark-1.3-contributor' olarak \u00e7\u00f6z\u00fcmlenir.
  return {
    model: 'muse-spark-1.3-contributor',
    contributorMode: true,
    id: 'muse-spark-1.3-contributor'
  };
}

async function executeMuse(task, model, cwd, resumeSessionId, config) {
  const resolved = resolveMuseModel(model, config);
  const promptFile = stateFile(`.muse_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
  fs.writeFileSync(promptFile, task, 'utf8');

  const activeSessionId = resumeSessionId || crypto.randomUUID();

  // KES\u0130N G\u00dcVENL\u0130K: Hem --model muse-spark-1.3-contributor hem de --contributor-mode on verilir!
  let cmd = 'muse exec --model muse-spark-1.3-contributor --contributor-mode on ';
  cmd += `--reasoning-effort high --approval-mode never --workspace "${cwd}" --prompt-file "${promptFile}"`;

  if (activeSessionId) {
    cmd += ` --session-id ${activeSessionId}`;
  }

  try {
    const res = await runCommand(cmd, cwd, 'muse', config);
    return { ...res, sessionId: activeSessionId };
  } finally {
    try { fs.unlinkSync(promptFile); } catch (e) {}
  }
}

function extractSessionId(output) {
  if (!output) return null;
  const match = output.match(/session\s*id(?:\s*is|[:=])\s*([0-9a-fA-F-]+)/i)
    || output.match(/session-([0-9a-fA-F-]+)/i)
    || output.match(/\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/i);
  return match ? match[1] : null;
}

// \u2500\u2500 Main Entrypoint \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

async function main() {
  const depth = parseInt(process.env.AI_FACTORY_ROUTER_DEPTH || '0', 10);
  if (Number.isSafeInteger(depth) && depth >= 2) {
    console.warn(`\n[AI Factory Recursion Guard] AI_FACTORY_ROUTER_DEPTH=${depth} s\u0131n\u0131r\u0131na ula\u015f\u0131ld\u0131. \u0130\u00e7 i\u00e7e d\u00f6ng\u00fc engellendi. G\u00f6rev Gemini'ye devrediliyor.\n`);
    console.log('='.repeat(60));
    console.log('[AI FACTORY EXECUTION REPORT]');
    console.log('path: gemini [OK]');
    console.log('choices: gemini');
    console.log('errors: max_recursion_depth_exceeded');
    console.log('succeed_with: handoff_to_gemini');
    console.log('='.repeat(60) + '\n');
    process.exit(0);
  }

  const options = parseCliArgs();
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (options.engine && !['muse', 'codex', 'opencode', 'claude', 'gemini'].includes(options.engine)) throw new Error('Unknown engine: ' + options.engine);
  for (const [key, value] of Object.entries({ model: options.model, cwd: options.cwd })) {
    if (/[\x00-\x1f"%&|<>^!$\x60]/.test(value)) throw new Error('Unsafe shell argument: ' + key);
  }
  const registry = loadJson(REGISTRY_FILE, { sessions: {} });

  if (options.quota) {
    console.log('[AI Factory] Model ve motor kota kullan\u0131m oranlar\u0131 sorgulan\u0131yor...');
    const quotaData = await fetchAllQuotas({ force: true });
    console.log('\n' + formatQuotaTable(quotaData) + '\n');
    process.exit(0);
  }

  if (!options.task && !options.resume) {
    console.log(`
AI Factory Smart Router CLI (v2.1 - Hardened & Supervised)
===========================================================
Kullan\u0131m:
  node router.mjs --task "G\u00f6rev metni" [--name "oturum-adi"] [--cwd "dizin"]
  node router.mjs --resume "oturum-adi" --task "Devam sorusu"
  node router.mjs [--engine opencode|muse|codex|claude] [--model model-adi] --task "..."
  node router.mjs --engine claude --model <model> --reasoning-effort low|medium|high|xhigh|max --task "..."
  node router.mjs --quota   # Codex, Antigravity ve Muse canlı kotalarını listeler
    `);
    process.exit(0);
  }

  let targetEngine = options.engine;
  let targetModel = options.model;
  let resumeSessionId = null;
  const sessionName = options.name || options.resume;

  if (options.resume) {
    const existing = Object.hasOwn(registry.sessions, options.resume) ? registry.sessions[options.resume] : null;
    if (existing) {
      targetEngine = existing.engine;
      targetModel = (targetEngine === 'opencode' || targetEngine === 'claude') && options.model ? options.model : existing.model;
      resumeSessionId = existing.sessionId;
      options.cwd = existing.cwd || options.cwd;
      console.log(`[AI Factory Registry] '${options.resume}' adl\u0131 oturum bulundu -> Motor: ${targetEngine}, Model: ${targetModel}, Session ID: ${resumeSessionId}`);
    } else {
      throw new Error(`Session not found: ${options.resume}`);
    }
  }

  if (targetEngine && !['muse', 'codex', 'opencode', 'claude', 'gemini'].includes(targetEngine)) throw new Error('Unsupported engine in saved session: ' + targetEngine);

  {
    // Always resolve through aliases, even when both engine and model were forced via flags/resume,
    // so "--model haiku" or a session's saved key normalizes the same way a bare model name would.
    const decision = decideEngineAndModel(options.task, config, targetEngine, targetModel);
    targetEngine = decision.engine;
    targetModel = decision.model;
    console.log(`[AI Factory Smart Router] Karar: ${targetEngine.toUpperCase()} (${targetModel}) -> Neden: ${decision.reason}`);
  }

  if (options.resume && (targetEngine === 'opencode' || targetEngine === 'claude')) {
    if (!resumeSessionId) throw new Error(`${targetEngine} session has no ID to resume`);
    if (!(targetEngine === 'opencode' ? /^ses_[A-Za-z0-9]+$/ : /^[0-9a-fA-F-]{36}$/).test(resumeSessionId)) {
      throw new Error(`Invalid ${targetEngine} session ID`);
    }
  }

  if (targetEngine === 'gemini') {
    console.log(`\n[AI Factory Mandate] Görev Antigravity (Gemini)'ye devredildi. Sen devam et.\n`);
    console.log('='.repeat(60));
    console.log('[AI FACTORY EXECUTION REPORT]');
    console.log('path: gemini [OK]');
    console.log('choices: gemini');
    console.log('errors: none');
    console.log('succeed_with: handoff_to_gemini');
    console.log('='.repeat(60) + '\n');
    process.exit(0);
  }

  // The selected model runs first; unless it is Claude or --no-fallback is set,
  // the free chain (OpenCode free models -> Muse Contributor -> Codex free) follows.
  const attempts = [{ engine: targetEngine, model: targetModel, sessionId: resumeSessionId }];
  if (!options.noFallback && targetEngine !== 'claude') {
    for (const step of config.fallback_chain) {
      const sameModel = step.engine === targetEngine &&
        (step.engine === 'muse' || findModel(targetModel, config, step.engine)?.model === step.model);
      if (!sameModel) attempts.push({ engine: step.engine, model: step.model, sessionId: null });
    }
  }
  // Resolve every model before launching anything so a disallowed model never runs.
  for (const attempt of attempts) {
    if (attempt.engine === 'opencode' || attempt.engine === 'claude') {
      attempt.model = resolveExternalModel(attempt.engine, attempt.model, config);
    } else if (attempt.engine === 'codex') {
      resolveCodexModel(attempt.model, config);
      attempt.model = findModel(attempt.model, config, 'codex').model;
    } else {
      attempt.model = resolveMuseModel(attempt.model, config).model;
    }
  }

  const pathSteps = ['gemini'];
  const choices = [];
  const errors = [];
  let succeedWith = null;
  let lastOutput = '';
  let lastSessionId = null;
  const claudeEffort = decideClaudeEffort(options.task, config, options.reasoningEffort);
  if (attempts.some(a => a.engine === 'claude')) {
    console.log(`[AI Factory Claude Effort] Karar: ${claudeEffort.level} -> Neden: ${claudeEffort.reason}`);
  }
  const executors = {
    opencode: executeOpenCode,
    claude: (task, model, cwd, resumeSessionId, cfg) => executeClaude(task, model, cwd, resumeSessionId, cfg, claudeEffort.level),
    muse: executeMuse,
    codex: executeCodex
  };

  for (const [index, attempt] of attempts.entries()) {
    const { engine, model } = attempt;
    if (index > 0) {
      console.warn(`\n[AI Factory Fallback] Önceki model başarısız (${errors.at(-1)}). ${engine}(${model}) deneniyor...`);
    }
    if (!choices.includes(engine)) choices.push(engine);
    // OpenCode models are tracked separately so one rate-limited model does not block the others.
    const healthKey = engine === 'opencode' ? `opencode:${model}` : engine;
    const gate = canExecuteEngine(healthKey, config);
    if (!gate.allowed) {
      console.warn(`[AI Factory Pre-Flight Gate] ⛔ ${engine}(${model}) kullanılamıyor (${gate.reason}).`);
      pathSteps.push(`${engine}(${model}) [QUARANTINED]`);
      errors.push(`${engine}-${model} (quarantined: ${gate.reason})`);
      continue;
    }
    let classified;
    try {
      const res = await executors[engine](options.task, model, options.cwd, attempt.sessionId, config);
      lastOutput = res.output;
      if (res.sessionId) lastSessionId = res.sessionId;
      const jsonEngine = engine === 'opencode' || engine === 'claude';
      const ok = res.exitCode === 0 && !res.watchdogTimeout &&
        (jsonEngine ? !res.cliError && res.hasResponse : res.output.trim().length > 0);
      if (ok) {
        succeedWith = engine === 'muse' ? model : `${engine}-${model}`;
        recordEngineSuccess(healthKey, config);
        pathSteps.push(`${engine}(${model}) [OK]`);
        targetEngine = engine;
        targetModel = model;
        break;
      }
      classified = classifyError(res.exitCode, res.output, res);
    } catch (err) {
      classified = { ...classifyError(1, err.message), reason: err.message };
    }
    recordEngineFailure(healthKey, classified, config);
    errors.push(`${engine}-${model} (${classified.reason})`);
    pathSteps.push(`${engine}(${model}) [FAIL: ${classified.reason}]`);
    if (!classified.fallbackEligible) {
      console.warn(`\n[AI Factory Abort Guard] İstek sonlandırıldı (${classified.reason}). Fallback durduruldu.\n`);
      options.engine = 'aborted';
      break;
    }
  }

  // --no-fallback also prevents reporting a successful Gemini handoff on failure.
  if (!succeedWith && options.engine !== 'aborted' && !options.noFallback) {
    console.warn(`\n[AI Factory Supervisor Fallback] D\u0131\u015f motorlar ba\u015far\u0131s\u0131z veya karantinada (${errors.join(', ')}). G\u00f6rev Gemini (Antigravity)'ye devrediliyor. Sen devam et.\n`);
    pathSteps.push('gemini [OK]');
    succeedWith = 'handoff_to_gemini';
    targetEngine = 'gemini';
    targetModel = 'gemini';
    choices.push('gemini');
  }

  // Oturum kayd\u0131 (\u00c7\u0131kt\u0131dan dinamik session id yakalan\u0131r)
  if (succeedWith && sessionName) {
    const extractedId = lastSessionId || extractSessionId(lastOutput) || resumeSessionId;
    if ((targetEngine === 'opencode' || targetEngine === 'claude') && !extractedId) {
      console.warn(`[AI Factory Registry] ${targetEngine} session ID was not returned; '${sessionName}' was not saved.`);
    } else {
      if (['__proto__', 'constructor', 'prototype'].includes(sessionName)) throw new Error('Invalid session name');
      registry.sessions[sessionName] = {
        engine: targetEngine,
        model: targetModel,
        sessionId: extractedId,
        cwd: options.cwd,
        updated_at: new Date().toISOString()
      };
      saveJson(REGISTRY_FILE, registry);
      console.log(`[AI Factory Registry] Oturum '${sessionName}' ad\u0131yla kaydedildi (${extractedId ? 'ID: ' + extractedId : 'yeni'}).`);
    }
  }

  // Standart Rapor \u00c7\u0131kt\u0131s\u0131 (Path zinciri ile)
  const pathStr = pathSteps.join(' --> ');
  const errorsStr = errors.length > 0 ? errors.join(', ') : 'none';
  const succeedStr = succeedWith || 'none (all engines failed)';

  console.log('\n' + '='.repeat(60));
  console.log('[AI FACTORY EXECUTION REPORT]');
  console.log(`path: ${pathStr}`);
  console.log(`choices: ${choices.join(', ')}`);
  console.log(`errors: ${errorsStr}`);
  console.log(`succeed_with: ${succeedStr}`);
  console.log('='.repeat(60) + '\n');

  process.exit(succeedWith ? 0 : 1);
}

main().catch(err => {
  console.error('[AI Factory Error]', err);
  process.exit(1);
});

