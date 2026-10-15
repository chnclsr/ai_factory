#!/usr/bin/env node
/**
 * AI Factory - Smart Router Engine (v2.1 - Hardened & Supervised)
 * Antigravity (orkestrasyon) -> Puter (0$ DeepSeek Flash/Pro/R1) / Codex (GPT-6 & GPT-5.6 Serisi) / Gemini (Supervisor)
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
import { ROOT, CONFIG_FILE, BRIDGE_URL, stateFile } from '../lib/paths.mjs';

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
  const quotaCheck = checkEngineQuotaGate(engine);
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
      reason: resMeta.initialHang
        ? '30 saniyelik ilk \u00e7\u0131kt\u0131 zaman a\u015f\u0131m\u0131 (H\u0131zl\u0131 Ba\u015flang\u0131\u00e7 Bek\u00e7isi)'
        : 'Sessizlik zaman a\u015f\u0131m\u0131 (Watchdog Timeout)'
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
        AI_FACTORY_ROUTER_DEPTH: String(safeDepth + 1)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let lastActivityAt = Date.now();
    let tailBuffer = [];
    let isFinished = false;

    function handleData(chunk, streamName) {
      hasReceivedAnyOutput = true;
      lastActivityAt = Date.now();
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

    // Kademeli Liveness / Watchdog Bek\u00e7isi (\u0130lk 30s -> Sonra 120s)
    const watchdogInterval = setInterval(() => {
      if (isFinished) return;
      const now = Date.now();
      const elapsedSinceStart = now - startTime;
      const idleMs = now - lastActivityAt;

      // 1. A\u015fama: \u0130lk 30 saniye i\u00e7inde hi\u00e7 \u00e7\u0131kt\u0131 gelmediyse (Erken Kilitlenme / Sessiz Hata)
      if (!hasReceivedAnyOutput && elapsedSinceStart >= initialTimeoutMs) {
        clearInterval(watchdogInterval);
        isFinished = true;
        console.warn(`\n[AI-FACTORY-WATCHDOG] \u26a0\ufe0f UYARI: "${engineName}" motoru ilk ${Math.round(elapsedSinceStart / 1000)}s boyunca hi\u00e7 \u00e7\u0131kt\u0131 \u00fcretmedi!`);
        console.warn(`[AI-FACTORY-WATCHDOG] Olas\u0131 ba\u015flang\u0131\u00e7 kilitlenmesi/sessizlik nedeniyle s\u00fcre\u00e7 sonland\u0131r\u0131l\u0131yor ve s\u0131radaki motora devrediliyor...\n`);
        killProcessTree(child.pid);
        resolve({
          exitCode: 42,
          signal: 'SIGKILL',
          watchdogTimeout: true,
          initialHang: true,
          output: tailBuffer.join('\n') || `[Watchdog] "${engineName}" ilk ${Math.round(elapsedSinceStart / 1000)}s i\u00e7inde hi\u00e7 \u00e7\u0131kt\u0131 vermedi.`
        });
        return;
      }

      // 2. A\u015fama: \u00c7\u0131kt\u0131 geldikten sonra sessizlik zaman a\u015f\u0131m\u0131 (120 saniye)
      if (idleMs >= idleTimeoutMs) {
        clearInterval(watchdogInterval);
        isFinished = true;
        console.warn(`\n[AI-FACTORY-WATCHDOG] \u26a0\ufe0f UYARI: "${engineName}" motoru ${Math.round(idleMs / 1000)}s boyunca hi\u00e7 \u00e7\u0131kt\u0131 \u00fcretmedi!`);
        console.warn(`[AI-FACTORY-WATCHDOG] Olas\u0131 kilitlenme/sessizlik nedeniyle s\u00fcre\u00e7 sonland\u0131r\u0131l\u0131yor ve s\u0131radaki motora devrediliyor...\n`);
        killProcessTree(child.pid);
        resolve({
          exitCode: 42,
          signal: 'SIGKILL',
          watchdogTimeout: true,
          initialHang: false,
          output: tailBuffer.join('\n')
        });
        return;
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
    } else if (arg === '--cwd') {
      options.cwd = args[++i] || process.cwd();
    } else if (!options.task && !arg.startsWith('-')) {
      options.task = arg;
    }
  }
  return options;
}

function decideEngineAndModel(task, config, forcedEngine, forcedModel) {
  if (forcedEngine) {
    const engine = forcedEngine.toLowerCase();
    let model = forcedModel || config?.engines?.[engine]?.default_model || (engine === 'codex' ? 'gpt-6.1-sol' : engine === 'gemini' ? 'gemini' : engine === 'muse' ? 'muse-spark-1.3-contributor' : 'flash');
    if (engine === 'muse') {
      // G\u00dcVENL\u0130K K\u0130L\u0130D\u0130: Muse i\u00e7in \u00fccretli model ASLA kullan\u0131lamaz, her zaman 0$ muse-spark-1.3-contributor olmal\u0131d\u0131r!
      model = 'muse-spark-1.3-contributor';
    }
    return { engine, model, reason: 'Kullan\u0131c\u0131 taraf\u0131ndan zorland\u0131' };
  }

  const lower = task.toLowerCase();

  // 0. Gemini do\u011frudan devam anahtar kelimeleri
  for (const kw of (config?.routing_rules?.gemini_keywords || [])) {
    if (lower.includes(kw)) {
      return { engine: 'gemini', model: 'gemini', reason: `Gemini do\u011frudan devam anahtar kelimesi: "${kw}"` };
    }
  }

  for (const engine of ['opencode', 'claude']) {
    for (const kw of (config?.routing_rules?.[`${engine}_keywords`] || [])) {
      if (lower.includes(kw)) {
        return { engine, model: config.engines[engine].default_model, reason: `${engine} anahtar kelimesi: ${kw}` };
      }
    }
  }

  // 1. Muse anahtar kelimeleri
  for (const kw of (config?.routing_rules?.muse_keywords || [])) {
    if (lower.includes(kw)) {
      return { engine: 'muse', model: 'muse-spark-1.3-contributor', reason: `Muse/Meta anahtar kelimesi: ${kw}` };
    }
  }

  // 2. Codex anahtar kelimeleri
  for (const kw of (config?.routing_rules?.codex_keywords || [])) {
    if (lower.includes(kw)) {
      let model = 'gpt-6.1-sol';
      if (lower.includes('astra')) model = 'gpt-6-astra';
      else if (lower.includes('terra')) model = 'gpt-5.6-terra';
      else if (lower.includes('luna')) model = 'gpt-6-luna';
      return { engine: 'codex', model, reason: `Codex/OpenAI anahtar kelimesi: ${kw}` };
    }
  }

  // 2. Puter Pro (Derin d\u00fc\u015f\u00fcnme / kompleks g\u00f6revler)
  for (const kw of (config?.routing_rules?.complexity_keywords_pro || [])) {
    if (lower.includes(kw)) {
      return { engine: 'puter', model: 'pro', reason: `Kompleks g\u00f6rev (0$ Puter Pro): ${kw}` };
    }
  }

  // 3. Varsay\u0131lan: Puter Flash (0$ H\u0131zl\u0131 analiz)
  return { engine: 'puter', model: 'flash', reason: 'Rutin h\u0131zl\u0131 analiz (0$ Puter Flash)' };
}

function decideFallbackCodexModel(originalModel, task, errors) {
  const lower = (task || '').toLowerCase();
  const isFrontier = lower.includes('matematik') || lower.includes('ispat') || lower.includes('benchmark');

  if (isFrontier) {
    return {
      model: 'gpt-6.1-sol',
      tier: 'flagship',
      reason: 'A\u011f\u0131r matematik/ispat g\u00f6revi i\u00e7in amiral gemisi gpt-6.1-sol'
    };
  }

  if (originalModel === 'flash' || !originalModel) {
    return {
      model: 'gpt-6-luna',
      tier: 'ultra_cheap',
      reason: 'Rutin g\u00f6rev i\u00e7in ekonomik GPT-6 modeli ($0.10/M)'
    };
  }

  return {
    model: 'gpt-6.1-sol',
    tier: 'flagship',
    reason: 'Kompleks mimari g\u00f6revi i\u00e7in gpt-6.1-sol amiral gemisi'
  };
}

async function ensurePuterBridge() {
  try {
    const res = await fetch(BRIDGE_URL, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return;
  } catch (e) {
    console.log('[AI Factory] Puter K\u00f6pr\u00fcs\u00fc (localhost:8080) kapal\u0131. Arka planda ba\u015flat\u0131l\u0131yor...');
    const serverScript = path.join(__dirname, 'server.mjs');
    const child = spawn(process.execPath, [serverScript], {
      cwd: __dirname,
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.unref();

    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const res2 = await fetch(BRIDGE_URL, { signal: AbortSignal.timeout(500) });
        if (res2.ok) {
          console.log('[AI Factory] Puter K\u00f6pr\u00fcs\u00fc ba\u015far\u0131yla ba\u015flat\u0131ld\u0131 (localhost:8080).');
          return;
        }
      } catch (err) {}
    }
  }
}

async function executePuter(task, model, cwd, resumeSessionId, config) {
  await ensurePuterBridge();
  const patchFile = model === 'pro'
    ? path.join(__dirname, 'pro-patch.yml')
    : null;

  const promptFile = stateFile(`.puter_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
  fs.writeFileSync(promptFile, task, 'utf8');

  let cmd = 'dsh headless';
  if (patchFile && fs.existsSync(patchFile)) {
    cmd += ` --patch "${patchFile}"`;
  }
  if (resumeSessionId) {
    cmd += ` --session-id ${resumeSessionId}`;
  }
  cmd += ` < "${promptFile}"`;

  try {
    return await runCommand(cmd, cwd, 'puter', config);
  } finally {
    try { fs.unlinkSync(promptFile); } catch (e) {}
  }
}

function resolveCodexModel(rawModel, config) {
  if (!rawModel || typeof rawModel !== 'string') return 'gpt-6.1-sol';
  const m = rawModel.trim().toLowerCase();

  const aliases = Object.create(null);
  aliases['luna'] = 'gpt-6-luna';
  aliases['6-luna'] = 'gpt-6-luna';
  aliases['gpt-6-luna'] = 'gpt-6-luna';
  aliases['5.6-luna'] = 'gpt-5.6-luna';
  aliases['gpt-5.6-luna'] = 'gpt-5.6-luna';
  aliases['sol'] = 'gpt-6.1-sol';
  aliases['6.1-sol'] = 'gpt-6.1-sol';
  aliases['gpt-6.1-sol'] = 'gpt-6.1-sol';
  aliases['6-sol'] = 'gpt-6-sol';
  aliases['gpt-6-sol'] = 'gpt-6-sol';
  aliases['5.6-sol'] = 'gpt-5.6-sol';
  aliases['gpt-5.6-sol'] = 'gpt-5.6-sol';
  aliases['terra'] = 'gpt-5.6-terra';
  aliases['5.6-terra'] = 'gpt-5.6-terra';
  aliases['gpt-5.6-terra'] = 'gpt-5.6-terra';
  aliases['astra'] = 'gpt-6-astra';
  aliases['6-astra'] = 'gpt-6-astra';
  aliases['gpt-6-astra'] = 'gpt-6-astra';
  aliases['5.5'] = 'gpt-5.5';
  aliases['gpt-5.5'] = 'gpt-5.5';

  if (aliases[m]) return aliases[m];
  if (config?.engines?.codex?.models && Object.hasOwn(config.engines.codex.models, rawModel)) {
    return config.engines.codex.models[rawModel].id;
  }
  return rawModel;
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
  if (engine === 'claude' && !/^claude-(?:haiku|sonnet)-[a-z0-9-]+$/.test(entry.id)) {
    throw new Error(`Claude model is outside the low-cost allowlist: ${entry.id}`);
  }
  if (engine === 'claude' && (entry.cost_input_per_m > 2 || entry.cost_output_per_m > 10 ||
    !Number.isFinite(entry.cost_input_per_m) || !Number.isFinite(entry.cost_output_per_m))) {
    throw new Error(`Claude model exceeds the configured cost ceiling: ${entry.id}`);
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

async function executeClaude(task, model, cwd, resumeSessionId, config) {
  const promptFile = stateFile(`.claude_prompt_${Date.now()}_${crypto.randomUUID()}.txt`);
  fs.writeFileSync(promptFile, task, 'utf8');
  let cmd = `claude -p --output-format json --model ${model} --fallback-model ${model} --permission-mode acceptEdits --permission-prompts none`;
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
  if (options.engine && !['puter', 'muse', 'codex', 'opencode', 'claude', 'gemini'].includes(options.engine)) throw new Error('Unknown engine: ' + options.engine);
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
  node router.mjs --engine codex|puter|muse|opencode|claude [--model model-adi] --task "..."
  node router.mjs --quota   # Puter, Codex, Antigravity ve Muse canl\u0131 kotalar\u0131n\u0131 listeler
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

  if (!targetEngine || !targetModel) {
    const decision = decideEngineAndModel(options.task, config, targetEngine, targetModel);
    targetEngine = targetEngine || decision.engine;
    targetModel = targetModel || decision.model;
    console.log(`[AI Factory Smart Router] Karar: ${targetEngine.toUpperCase()} (${targetModel}) -> Neden: ${decision.reason}`);
  }

  if (targetEngine === 'opencode' || targetEngine === 'claude') {
    const resolvedModel = resolveExternalModel(targetEngine, targetModel, config);
    if (options.resume && !resumeSessionId) throw new Error(`${targetEngine} session has no ID to resume`);
    if (resumeSessionId && !(targetEngine === 'opencode' ? /^ses_[A-Za-z0-9]+$/ : /^[0-9a-fA-F-]{36}$/).test(resumeSessionId)) {
      throw new Error(`Invalid ${targetEngine} session ID`);
    }
    targetModel = resolvedModel;
  }

  if (targetEngine === 'gemini') {
    console.log(`\n[AI Factory Mandate] G\u00f6rev Antigravity (Gemini)'ye devredildi. Sen devam et.\n`);
    console.log('='.repeat(60));
    console.log('[AI FACTORY EXECUTION REPORT]');
    console.log('path: gemini [OK]');
    console.log('choices: gemini');
    console.log('errors: none');
    console.log('succeed_with: handoff_to_gemini');
    console.log('='.repeat(60) + '\n');
    process.exit(0);
  }

  const pathSteps = ['gemini'];
  const choices = [];
  const errors = [];
  let succeedWith = null;
  let lastOutput = '';
  let lastSessionId = null;

  // \u2500\u2500 1. Hedef Motor Puter ise: Puter -> Muse -> Codex -> Gemini \u2500\u2500
  if (targetEngine === 'opencode' || targetEngine === 'claude') {
    choices.push(targetEngine);
    const gate = canExecuteEngine(targetEngine, config);
    if (!gate.allowed) {
      pathSteps.push(`${targetEngine}(${targetModel}) [QUARANTINED]`);
      errors.push(`${targetEngine} (quarantined: ${gate.reason})`);
    } else {
      try {
        const execute = targetEngine === 'opencode' ? executeOpenCode : executeClaude;
        const res = await execute(options.task, targetModel, options.cwd, resumeSessionId, config);
        lastOutput = res.output;
        lastSessionId = res.sessionId;
        if (res.exitCode === 0 && !res.watchdogTimeout && !res.cliError && res.hasResponse) {
          succeedWith = `${targetEngine}-${targetModel}`;
          recordEngineSuccess(targetEngine, config);
          pathSteps.push(`${targetEngine}(${targetModel}) [OK]`);
        } else {
          const classified = classifyError(res.exitCode, res.output, res);
          recordEngineFailure(targetEngine, classified, config);
          errors.push(`${targetEngine}-${targetModel} (${classified.reason})`);
          pathSteps.push(`${targetEngine}(${targetModel}) [FAIL: ${classified.reason}]`);
          if (!classified.fallbackEligible) options.engine = 'aborted';
        }
      } catch (err) {
        const classified = classifyError(1, err.message);
        recordEngineFailure(targetEngine, classified, config);
        errors.push(`${targetEngine} (${err.message})`);
        pathSteps.push(`${targetEngine}(${targetModel}) [FAIL: ${err.message}]`);
      }
    }
  } else if (targetEngine === 'puter') {
    if (!choices.includes('puter')) choices.push('puter');
    const gate = canExecuteEngine('puter', config);
    if (!gate.allowed) {
      console.warn(`[AI Factory Pre-Flight Gate] \u26d4 Puter motoru karantinada (${gate.reason}). S\u0131radaki motora ge\u00e7iliyor...`);
      pathSteps.push(`puter(${targetModel}) [QUARANTINED]`);
      errors.push(`puter (quarantined: ${gate.reason})`);
    } else {
      try {
        const res = await executePuter(options.task, targetModel, options.cwd, resumeSessionId, config);
        lastOutput = res.output;
        if (res.exitCode === 0 && !res.watchdogTimeout && res.output.trim().length > 0) {
          succeedWith = `puter-${targetModel}`;
          recordEngineSuccess('puter', config);
          pathSteps.push(`puter(${targetModel}) [OK]`);
        } else {
          const classified = classifyError(res.exitCode, res.output, res);
          recordEngineFailure('puter', classified, config);
          errors.push(`puter-${targetModel} (${classified.reason})`);
          pathSteps.push(`puter(${targetModel}) [FAIL: ${classified.reason}]`);

          if (!classified.fallbackEligible) {
            console.warn(`\n[AI Factory Abort Guard] \u0130stek sonland\u0131r\u0131ld\u0131 (${classified.reason}). Fallback zinciri durduruldu.\n`);
            options.engine = 'aborted';
          }
        }
      } catch (err) {
        const classified = classifyError(1, err.message);
        recordEngineFailure('puter', classified, config);
        errors.push(`puter (${err.message})`);
        pathSteps.push(`puter(${targetModel}) [FAIL: ${err.message}]`);
      }
    }

    // 1. Fallback: Muse (0$ muse-spark-1.3-contributor)
    if (!succeedWith && options.engine !== 'aborted' && !options.noFallback) {
      if (!choices.includes('muse')) choices.push('muse');
      console.warn(`\n[AI Factory Fallback] Puter ba\u015far\u0131s\u0131z oldu veya atland\u0131 (${errors.join(', ')}).`);
      console.warn(`[AI Factory Fallback] S\u0131radaki motor: Muse (0$ muse-spark-1.3-contributor)...`);

      const museGate = canExecuteEngine('muse', config);
      if (!museGate.allowed) {
        console.warn(`[AI Factory Pre-Flight Gate] \u26d4 Muse motoru karantinada (${museGate.reason}).`);
        pathSteps.push('muse(muse-spark-1.3-contributor) [QUARANTINED]');
        errors.push(`muse (quarantined: ${museGate.reason})`);
      } else {
        try {
          const resMuse = await executeMuse(options.task, 'muse-spark-1.3-contributor', options.cwd, null, config);
          lastOutput = resMuse.output;
          if (resMuse.sessionId) lastSessionId = resMuse.sessionId;
          if (resMuse.exitCode === 0 && !resMuse.watchdogTimeout && resMuse.output.trim().length > 0) {
            succeedWith = 'muse-spark-1.3-contributor';
            recordEngineSuccess('muse', config);
            targetEngine = 'muse';
            targetModel = 'muse-spark-1.3-contributor';
            pathSteps.push('muse(muse-spark-1.3-contributor) [OK]');
          } else {
            const classifiedMuse = classifyError(resMuse.exitCode, resMuse.output, resMuse);
            recordEngineFailure('muse', classifiedMuse, config);
            errors.push(`muse-spark-1.3-contributor (${classifiedMuse.reason})`);
            pathSteps.push(`muse(muse-spark-1.3-contributor) [FAIL: ${classifiedMuse.reason}]`);

            if (!classifiedMuse.fallbackEligible) {
              console.warn(`\n[AI Factory Abort Guard] \u0130stek sonland\u0131r\u0131ld\u0131 (${classifiedMuse.reason}). Fallback durduruldu.\n`);
              options.engine = 'aborted';
            }
          }
        } catch (err) {
          const classifiedMuse = classifyError(1, err.message);
          recordEngineFailure('muse', classifiedMuse, config);
          errors.push(`muse (${err.message})`);
          pathSteps.push(`muse(muse-spark-1.3-contributor) [FAIL: ${err.message}]`);
        }
      }
    }

    // 2. Fallback: Codex (GPT-6 Luna -> Sol)
    if (!succeedWith && options.engine !== 'aborted' && !options.noFallback) {
      if (!choices.includes('codex')) choices.push('codex');
      const fallback = decideFallbackCodexModel(targetModel, options.task, errors);
      console.warn(`\n[AI Factory Fallback] Muse de ba\u015far\u0131s\u0131z oldu (${errors.join(', ')}).`);
      console.warn(`[AI Factory Fallback] Dinamik maliyet tercihi: ${fallback.reason} -> Model: ${fallback.model}`);

      const codexGate = canExecuteEngine('codex', config);
      if (!codexGate.allowed) {
        console.warn(`[AI Factory Pre-Flight Gate] \u26d4 Codex motoru da karantinada (${codexGate.reason}).`);
        pathSteps.push(`codex(${fallback.model}) [QUARANTINED]`);
        errors.push(`codex (quarantined: ${codexGate.reason})`);
      } else {
        try {
          const res = await executeCodex(options.task, fallback.model, options.cwd, null, config);
          lastOutput = res.output;
          if (res.exitCode === 0 && !res.watchdogTimeout && res.output.trim().length > 0) {
            succeedWith = `codex-${fallback.model}`;
            recordEngineSuccess('codex', config);
            targetEngine = 'codex';
            targetModel = fallback.model;
            pathSteps.push(`codex(${fallback.model}) [OK]`);
          } else {
            const classified = classifyError(res.exitCode, res.output, res);
            recordEngineFailure('codex', classified, config);
            errors.push(`codex-${fallback.model} (${classified.reason})`);
            pathSteps.push(`codex(${fallback.model}) [FAIL: ${classified.reason}]`);

            if (fallback.model !== 'gpt-6.1-sol' && classified.fallbackEligible) {
              const highTierModel = 'gpt-6.1-sol';
              const solGate = canExecuteEngine('codex', config);
              if (solGate.allowed) {
                console.warn(`\n[AI Factory Escalation] ${fallback.model} yetersiz kald\u0131. Amiral gemisi (${highTierModel}) deneniyor...`);
                const resHigh = await executeCodex(options.task, highTierModel, options.cwd, null, config);
                lastOutput = resHigh.output;
                if (resHigh.exitCode === 0 && !resHigh.watchdogTimeout && resHigh.output.trim().length > 0) {
                  succeedWith = `codex-${highTierModel}`;
                  recordEngineSuccess('codex', config);
                  targetEngine = 'codex';
                  targetModel = highTierModel;
                  pathSteps.push(`codex(${highTierModel}) [OK]`);
                } else {
                  const classifiedHigh = classifyError(resHigh.exitCode, resHigh.output, resHigh);
                  recordEngineFailure('codex', classifiedHigh, config);
                  errors.push(`codex-${highTierModel} (${classifiedHigh.reason})`);
                  pathSteps.push(`codex(${highTierModel}) [FAIL: ${classifiedHigh.reason}]`);
                }
              }
            }
          }
        } catch (err) {
          const classified = classifyError(1, err.message);
          recordEngineFailure('codex', classified, config);
          errors.push(`codex-${fallback.model} (${err.message})`);
          pathSteps.push(`codex(${fallback.model}) [FAIL: ${err.message}]`);
        }
      }
    }
  } else if (targetEngine === 'muse') {
    if (!choices.includes('muse')) choices.push('muse');
    // \u2500\u2500 2. Hedef Motor Muse ise: Muse -> Codex -> Puter -> Gemini \u2500\u2500
    const museGate = canExecuteEngine('muse', config);
    if (!museGate.allowed) {
      console.warn(`[AI Factory Pre-Flight Gate] \u26d4 Muse motoru karantinada (${museGate.reason}).`);
      pathSteps.push(`muse(${targetModel}) [QUARANTINED]`);
      errors.push(`muse (quarantined: ${museGate.reason})`);
    } else {
      try {
        const res = await executeMuse(options.task, targetModel, options.cwd, resumeSessionId, config);
        lastOutput = res.output;
        if (res.sessionId) lastSessionId = res.sessionId;
        if (res.exitCode === 0 && !res.watchdogTimeout && res.output.trim().length > 0) {
          succeedWith = targetModel.startsWith('muse') ? targetModel : `muse-${targetModel}`;
          recordEngineSuccess('muse', config);
          pathSteps.push(`muse(${targetModel}) [OK]`);
        } else {
          const classified = classifyError(res.exitCode, res.output, res);
          recordEngineFailure('muse', classified, config);
          errors.push(`muse-${targetModel} (${classified.reason})`);
          pathSteps.push(`muse(${targetModel}) [FAIL: ${classified.reason}]`);

          if (!classified.fallbackEligible) {
            console.warn(`\n[AI Factory Abort Guard] \u0130stek sonland\u0131r\u0131ld\u0131 (${classified.reason}). Fallback durduruldu.\n`);
            options.engine = 'aborted';
          }
        }
      } catch (err) {
        const classified = classifyError(1, err.message);
        recordEngineFailure('muse', classified, config);
        errors.push(`muse (${err.message})`);
        pathSteps.push(`muse(${targetModel}) [FAIL: ${err.message}]`);
      }
    }

    // Muse ba\u015far\u0131s\u0131zsa -> Codex'e devret
    if (!succeedWith && options.engine !== 'aborted' && !options.noFallback) {
      if (!choices.includes('codex')) choices.push('codex');
      console.warn(`\n[AI Factory Fallback] Muse ba\u015far\u0131s\u0131z oldu (${errors.join(', ')}). Codex motoruna devrediliyor...`);
      const codexGate = canExecuteEngine('codex', config);
      if (!codexGate.allowed) {
        pathSteps.push('codex(gpt-6-luna) [QUARANTINED]');
        errors.push(`codex (quarantined: ${codexGate.reason})`);
      } else {
        try {
          const res = await executeCodex(options.task, 'gpt-6-luna', options.cwd, null, config);
          lastOutput = res.output;
          if (res.exitCode === 0 && !res.watchdogTimeout && res.output.trim().length > 0) {
            succeedWith = 'codex-gpt-6-luna';
            recordEngineSuccess('codex', config);
            targetEngine = 'codex';
            targetModel = 'gpt-6-luna';
            pathSteps.push('codex(gpt-6-luna) [OK]');
          } else {
            const classified = classifyError(res.exitCode, res.output, res);
            recordEngineFailure('codex', classified, config);
            errors.push(`codex-gpt-6-luna (${classified.reason})`);
            pathSteps.push(`codex(gpt-6-luna) [FAIL: ${classified.reason}]`);
          }
        } catch (err) {
          const classified = classifyError(1, err.message);
          recordEngineFailure('codex', classified, config);
          errors.push(`codex (${err.message})`);
          pathSteps.push(`codex(gpt-6-luna) [FAIL: ${err.message}]`);
        }
      }
    }

    // Codex de ba\u015far\u0131s\u0131z olursa -> Puter (0$ Flash)'a devret
    if (!succeedWith && options.engine !== 'aborted' && !options.noFallback) {
      if (!choices.includes('puter')) choices.push('puter');
      console.warn(`\n[AI Factory Fallback] Codex de ba\u015far\u0131s\u0131z oldu. Puter (0$ Flash) deneniyor...`);
      const puterGate = canExecuteEngine('puter', config);
      if (!puterGate.allowed) {
        pathSteps.push('puter(flash) [QUARANTINED]');
        errors.push(`puter (quarantined: ${puterGate.reason})`);
      } else {
        try {
          const res = await executePuter(options.task, 'flash', options.cwd, null, config);
          lastOutput = res.output;
          if (res.exitCode === 0 && !res.watchdogTimeout && res.output.trim().length > 0) {
            succeedWith = 'puter-flash';
            recordEngineSuccess('puter', config);
            targetEngine = 'puter';
            targetModel = 'flash';
            pathSteps.push('puter(flash) [OK]');
          } else {
            const classified = classifyError(res.exitCode, res.output, res);
            recordEngineFailure('puter', classified, config);
            errors.push(`puter-flash (${classified.reason})`);
            pathSteps.push(`puter(flash) [FAIL: ${classified.reason}]`);
          }
        } catch (err) {
          const classified = classifyError(1, err.message);
          recordEngineFailure('puter', classified, config);
          errors.push(`puter (${err.message})`);
          pathSteps.push(`puter(flash) [FAIL: ${err.message}]`);
        }
      }
    }
  } else if (targetEngine === 'codex') {
    if (!choices.includes('codex')) choices.push('codex');
    // \u2500\u2500 3. Hedef Motor Codex ise: Codex -> Muse -> Puter -> Gemini \u2500\u2500
    const codexGate = canExecuteEngine('codex', config);
    if (!codexGate.allowed) {
      console.warn(`[AI Factory Pre-Flight Gate] \u26d4 Codex motoru karantinada (${codexGate.reason}).`);
      pathSteps.push(`codex(${targetModel}) [QUARANTINED]`);
      errors.push(`codex (quarantined: ${codexGate.reason})`);
    } else {
      try {
        const res = await executeCodex(options.task, targetModel, options.cwd, resumeSessionId, config);
        lastOutput = res.output;
        if (res.exitCode === 0 && !res.watchdogTimeout && res.output.trim().length > 0) {
          succeedWith = `codex-${targetModel}`;
          recordEngineSuccess('codex', config);
          pathSteps.push(`codex(${targetModel}) [OK]`);
        } else {
          const classified = classifyError(res.exitCode, res.output, res);
          recordEngineFailure('codex', classified, config);
          errors.push(`codex-${targetModel} (${classified.reason})`);
          pathSteps.push(`codex(${targetModel}) [FAIL: ${classified.reason}]`);

          if (!classified.fallbackEligible) {
            console.warn(`\n[AI Factory Abort Guard] \u0130stek sonland\u0131r\u0131ld\u0131 (${classified.reason}). Fallback durduruldu.\n`);
            options.engine = 'aborted';
          }
        }
      } catch (err) {
        const classified = classifyError(1, err.message);
        recordEngineFailure('codex', classified, config);
        errors.push(`codex (${err.message})`);
        pathSteps.push(`codex(${targetModel}) [FAIL: ${err.message}]`);
      }
    }

    // Codex ba\u015far\u0131s\u0131z olursa -> Muse'a devret
    if (!succeedWith && options.engine !== 'aborted' && !options.noFallback) {
      if (!choices.includes('muse')) choices.push('muse');
      console.warn(`\n[AI Factory Fallback] Codex ba\u015far\u0131s\u0131z oldu (${errors.join(', ')}). Muse (0$ Contributor) motoruna devrediliyor...`);
      const museGate = canExecuteEngine('muse', config);
      if (!museGate.allowed) {
        pathSteps.push('muse(muse-spark-1.3-contributor) [QUARANTINED]');
        errors.push(`muse (quarantined: ${museGate.reason})`);
      } else {
        try {
          const res = await executeMuse(options.task, 'muse-spark-1.3-contributor', options.cwd, null, config);
          lastOutput = res.output;
          if (res.sessionId) lastSessionId = res.sessionId;
          if (res.exitCode === 0 && !res.watchdogTimeout && res.output.trim().length > 0) {
            succeedWith = 'muse-spark-1.3-contributor';
            recordEngineSuccess('muse', config);
            targetEngine = 'muse';
            targetModel = 'muse-spark-1.3-contributor';
            pathSteps.push('muse(muse-spark-1.3-contributor) [OK]');
          } else {
            const classified = classifyError(res.exitCode, res.output, res);
            recordEngineFailure('muse', classified, config);
            errors.push(`muse-spark-1.3-contributor (${classified.reason})`);
            pathSteps.push(`muse(muse-spark-1.3-contributor) [FAIL: ${classified.reason}]`);
          }
        } catch (err) {
          const classified = classifyError(1, err.message);
          recordEngineFailure('muse', classified, config);
          errors.push(`muse (${err.message})`);
          pathSteps.push(`muse(muse-spark-1.3-contributor) [FAIL: ${err.message}]`);
        }
      }
    }

    // Muse de ba\u015far\u0131s\u0131z olursa -> Puter 0$ Flash'a devret
    if (!succeedWith && options.engine !== 'aborted' && !options.noFallback) {
      if (!choices.includes('puter')) choices.push('puter');
      console.warn(`\n[AI Factory Fallback] Muse de ba\u015far\u0131s\u0131z oldu. Puter (0$ Flash) deneniyor...`);
      const puterGate = canExecuteEngine('puter', config);
      if (!puterGate.allowed) {
        pathSteps.push('puter(flash) [QUARANTINED]');
        errors.push(`puter (quarantined: ${puterGate.reason})`);
      } else {
        try {
          const res = await executePuter(options.task, 'flash', options.cwd, null, config);
          lastOutput = res.output;
          if (res.exitCode === 0 && !res.watchdogTimeout && res.output.trim().length > 0) {
            succeedWith = 'puter-flash';
            recordEngineSuccess('puter', config);
            targetEngine = 'puter';
            targetModel = 'flash';
            pathSteps.push('puter(flash) [OK]');
          } else {
            const classified = classifyError(res.exitCode, res.output, res);
            recordEngineFailure('puter', classified, config);
            errors.push(`puter-flash (${classified.reason})`);
            pathSteps.push(`puter(flash) [FAIL: ${classified.reason}]`);
          }
        } catch (err) {
          const classified = classifyError(1, err.message);
          recordEngineFailure('puter', classified, config);
          errors.push(`puter (${err.message})`);
          pathSteps.push(`puter(flash) [FAIL: ${err.message}]`);
        }
      }
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

