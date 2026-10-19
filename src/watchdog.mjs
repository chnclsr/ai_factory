/**
 * AI Factory - Watchdog Liveness Helpers (Windows uyumlu)
 *
 * Idle watchdog tetiklendiğinde süreci hemen öldürmek yerine önce
 * "Process Liveness" denetimi yapılır: kök PID ve alt süreç ağacı
 * (process tree) hâlâ yaşıyor mu, CPU süresi ilerliyor mu?
 *
 * stdout akmasa bile (derin muhakeme / web araması yapan CLI motorları
 * gibi) süreç çalışıyorsa öldürme ertelenir; sonlandırma yalnızca
 * sert toplam tavan (max_execution_time_ms) aşıldığında veya ağaç
 * tamamen zombi/yanıtsız kaldığında yapılır.
 */

import { execSync } from 'child_process';

function execQuiet(cmd) {
  try {
    return execSync(cmd, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
      windowsHide: true
    }).toString('utf8');
  } catch (e) {
    return null;
  }
}

/** Tek PID hayatta mı? (Windows'ta process.kill(pid, 0) ile çalışır.) */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/** Doğrudan alt süreç PID'leri. Desteklenmiyorsa / hata olursa []. */
export function listChildPids(parentPid) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return [];
  try {
    if (process.platform === 'win32') {
      const out = execQuiet(
        `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Select-Object -ExpandProperty ProcessId"`
      );
      if (out == null) return [];
      return out
        .split(/[\r\n]+/)
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isInteger(n) && n > 0);
    }
    const out = execQuiet(`pgrep -P ${parentPid}`);
    if (out == null) return [];
    return out
      .split('\n')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isInteger(n) && n > 0);
  } catch (e) {
    return [];
  }
}

function queryWindowsCpuMs(pids) {
  const out = execQuiet(
    `powershell -NoProfile -NonInteractive -Command "Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.TotalProcessorTime.TotalMilliseconds }"`
  );
  if (out == null) return null;
  let sum = 0;
  let seen = false;
  for (const line of out.split(/[\r\n]+/)) {
    const v = parseFloat(line.trim());
    if (Number.isFinite(v)) {
      sum += v;
      seen = true;
    }
  }
  return seen ? sum : null;
}

function parsePsCpuTime(s) {
  const parts = s.trim().split(':');
  let secs = NaN;
  if (parts.length === 3) secs = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + parseFloat(parts[2]);
  else if (parts.length === 2) secs = Number(parts[0]) * 60 + parseFloat(parts[1]);
  return Number.isFinite(secs) ? Math.round(secs * 1000) : null;
}

function queryPosixCpuMs(pids) {
  const out = execQuiet(`ps -p ${pids.join(',')} -o cputime=`);
  if (out == null) return null;
  let sum = 0;
  let seen = false;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const ms = parsePsCpuTime(line);
    if (ms != null) {
      sum += ms;
      seen = true;
    }
  }
  return seen ? sum : null;
}

/**
 * Kök PID + canlı alt süreçlerin toplam CPU süresini örnekler.
 * Dönüş: { alive, cpuMs } — cpuMs örneklenemezse null olur.
 */
export function sampleTreeCpuMs(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return { alive: false, cpuMs: null };
  let tree;
  try {
    tree = [rootPid, ...listChildPids(rootPid)];
  } catch (e) {
    tree = [rootPid];
  }
  const alivePids = tree.filter(isPidAlive);
  if (alivePids.length === 0) return { alive: false, cpuMs: null };
  try {
    const cpuMs = process.platform === 'win32'
      ? queryWindowsCpuMs(alivePids)
      : queryPosixCpuMs(alivePids);
    return { alive: true, cpuMs };
  } catch (e) {
    return { alive: true, cpuMs: null };
  }
}

/**
 * Kök veya alt süreçlerden herhangi biri yaşıyor mu?
 * child verilirse ve çoktan kapanmışsa (exitCode/signalCode set) false.
 */
export function isProcessTreeAlive(rootPid, child = null) {
  if (child && (child.exitCode !== null || child.signalCode !== null)) return false;
  if (isPidAlive(rootPid)) return true;
  try {
    return listChildPids(rootPid).some(isPidAlive);
  } catch (e) {
    return false;
  }
}

/**
 * Saf watchdog kararı: 'wait' | 'postpone' | 'kill'.
 *
 * - elapsedMs >= maxExecutionMs → 'kill' (hard_timeout; liveness bunu aşamaz)
 * - idleMs < thresholdMs → 'wait'
 * - ağaç ölü → 'wait' (kapanış 'close' olayıyla çözülecek)
 * - ağaç canlı + (CPU ilerliyor | CPU örneklenemiyor | donma süresi limit altı)
 *   → 'postpone' (grace period / liveness ertelemesi)
 * - ağaç canlı + CPU donma süresi >= limit → 'kill' (zombie_tree)
 */
export function decideWatchdogAction({
  elapsedMs,
  idleMs,
  thresholdMs,
  maxExecutionMs,
  treeAlive,
  cpuKnown,
  cpuAdvanced,
  cpuStillMs,
  cpuStillLimitMs
}) {
  if (elapsedMs >= maxExecutionMs) return { action: 'kill', reason: 'hard_timeout' };
  if (idleMs < thresholdMs) return { action: 'wait', reason: 'within_budget' };
  if (!treeAlive) return { action: 'wait', reason: 'tree_dead_await_close' };
  if (!cpuKnown || cpuAdvanced || cpuStillMs < cpuStillLimitMs) {
    return { action: 'postpone', reason: 'tree_alive' };
  }
  return { action: 'kill', reason: 'zombie_tree' };
}
