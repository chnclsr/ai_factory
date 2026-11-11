#!/usr/bin/env node
/**
 * Command Code (commandcode.ai) Usage & Quota Checker
 * API Key Konumu: ~/.commandcode/auth.json
 *
 * Sorgulanan API Uçları:
 * 1. /alpha/whoami?limits=1        -> Kullanıcı profili ve genel limitler
 * 2. /alpha/billing/credits       -> Kalan bakiye ve 5 saatlik / haftalık pencereler
 * 3. /alpha/usage/summary         -> Harcanan token sayısı, istek adedi ve maliyet
 * 4. /alpha/billing/subscriptions -> Aktif plan ve yenilenme/iptal tarihleri
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

export function getAuthFilePath() {
  const homeDir = os.homedir() || process.env.USERPROFILE || process.env.HOME;
  return path.join(homeDir, '.commandcode', 'auth.json');
}

export function readApiKey() {
  const authPath = getAuthFilePath();
  if (!fs.existsSync(authPath)) {
    throw new Error(`Command Code kimlik doğrulama dosyası bulunamadı: ${authPath}`);
  }
  const content = fs.readFileSync(authPath, 'utf8');
  const parsed = JSON.parse(content);
  if (!parsed.apiKey) {
    throw new Error(`auth.json içinde apiKey alanı bulunamadı (${authPath}).`);
  }
  return parsed.apiKey;
}

export async function fetchCommandCodeUsage() {
  const apiKey = readApiKey();
  const headers = {
    'Authorization': 'Bearer ' + apiKey,
    'Content-Type': 'application/json'
  };

  const [whoamiRes, creditsRes, summaryRes, subRes] = await Promise.all([
    fetch('https://api.commandcode.ai/alpha/whoami?limits=1', { headers }),
    fetch('https://api.commandcode.ai/alpha/billing/credits', { headers }),
    fetch('https://api.commandcode.ai/alpha/usage/summary', { headers }),
    fetch('https://api.commandcode.ai/alpha/billing/subscriptions', { headers })
  ]);

  const [whoami, credits, summary, sub] = await Promise.all([
    whoamiRes.json(),
    creditsRes.json(),
    summaryRes.json(),
    subRes.json()
  ]);

  // The report is often pasted or logged; keep the account email out of both text and --json output.
  if (whoami?.user) delete whoami.user.email;

  return {
    observedAt: new Date().toISOString(),
    whoami,
    credits,
    summary,
    sub
  };
}

export function formatCommandCodeReport(data) {
  const lines = [];
  const u = data.whoami?.user || {};
  const c = data.credits?.credits || {};
  const w = data.credits?.windowLimits || {};
  const s = data.summary || {};
  const subData = data.sub?.data || {};

  const fmtDate = (msOrIso) => {
    if (!msOrIso) return '-';
    const d = new Date(typeof msOrIso === 'number' ? msOrIso : msOrIso);
    return isNaN(d.getTime()) ? String(msOrIso) : d.toLocaleString('tr-TR');
  };

  const fmtUsd = (num) => {
    if (num == null) return '$0.00';
    return '$' + Number(num).toFixed(4);
  };

  lines.push('='.repeat(78));
  lines.push('  COMMAND CODE (commandcode.ai) - KULLANIM & KOTA RAPORU');
  lines.push(`  Sorgulanma Zamanı: ${new Date(data.observedAt).toLocaleString('tr-TR')}`);
  lines.push('='.repeat(78));

  // 1. Kullanıcı Profili & Plan
  lines.push('[1] KULLANICI & PLAN');
  lines.push(`  Kullanıcı Adı: ${u.userName || '-'} (${u.name || '-'})`);
  lines.push(`  Plan ID      : ${subData.planId || 'Bilinmiyor'} (Durum: ${subData.status || '-'})`);
  if (subData.cancelAt) {
    lines.push(`  Plan Bitiş   : ${fmtDate(subData.cancelAt)} (İptal/Sonlanma)`);
  } else if (subData.currentPeriodEnd) {
    lines.push(`  Dönem Bitiş  : ${fmtDate(subData.currentPeriodEnd)}`);
  }
  lines.push('');

  // 2. Krediler ve Kalan Bakiye
  lines.push('[2] KREDİLER & BAKİYE');
  lines.push(`  Aylık Kredi Bakiyesi : ${fmtUsd(c.monthlyCredits)}`);
  lines.push(`  Satın Alınan Kredi   : ${fmtUsd(c.purchasedCredits)}`);
  lines.push(`  Ücretsiz Kredi       : ${fmtUsd(c.freeCredits)}`);
  lines.push('');

  // 3. Kullanım Limit Pencereleri
  lines.push('[3] LİMİT PENCERELERİ');
  const fiveH = w.fiveHour || {};
  const week = w.weekly || {};
  lines.push(`  5 Saatlik Pencere    : ${fmtUsd(fiveH.used)} / ${fmtUsd(fiveH.cap)}  [Aşıldı: ${fiveH.exceeded ? 'EVET' : 'HAYIR'}]`);
  lines.push(`    Sıfırlanma Zamanı  : ${fmtDate(fiveH.resetAt)}`);
  lines.push(`  Haftalık Pencere     : ${fmtUsd(week.used)} / ${fmtUsd(week.cap)}  [Aşıldı: ${week.exceeded ? 'EVET' : 'HAYIR'}]`);
  lines.push(`    Sıfırlanma Zamanı  : ${fmtDate(week.resetAt)}`);
  lines.push('');

  // 4. Harcama ve Token İstatistikleri
  lines.push('[4] DÖNEMLİK KULLANIM İSTATİSTİKLERİ');
  lines.push(`  Toplam İstek Sayısı  : ${s.totalCount || 0} (Başarı: %${s.successRate ?? 100})`);
  lines.push(`  Toplam Harcanan      : ${fmtUsd(s.totalCost)}`);
  lines.push(`  Ortalama İstek Maliyeti: ${fmtUsd(s.averageCost)}`);
  lines.push(`  Giriş Token (In)     : ${(s.totalTokensIn || 0).toLocaleString('tr-TR')}`);
  lines.push(`  Çıkış Token (Out)    : ${(s.totalTokensOut || 0).toLocaleString('tr-TR')}`);
  lines.push(`  Toplam Token         : ${(s.totalTokens || 0).toLocaleString('tr-TR')}`);
  lines.push('='.repeat(78));

  return lines.join('\n');
}

// CLI doğrudan çalıştırılırsa
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const asJson = process.argv.includes('--json') || process.argv.includes('-j');
  fetchCommandCodeUsage()
    .then(data => {
      if (asJson) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log('\n' + formatCommandCodeReport(data) + '\n');
      }
      process.exit(0);
    })
    .catch(err => {
      console.error('[Command Code Usage Error]', err.message || err);
      process.exit(1);
    });
}
