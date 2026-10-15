# AI Factory

> **Global Smart Token Offloading & Multi-Engine Orchestrator for Antigravity**

AI Factory, Google Antigravity ve Gemini orkestrasyon ortamında context window'u ve model kotalarını tüketmeden, tüm ağır repo analizlerini, kod incelemelerini, dosya okumalarını ve derin optimizasyonları sıfır maliyetli (0$) motorlara devreden akıllı bir yönlendirme (routing) ve yük boşaltma (token offloading) sistemidir.

---

## 🌟 Temel Özellikler

- **Sıfır Maliyetli Öncelik Sıralaması (Zero-Cost Hierarchy):**
  1. **Puter Flash (DeepSeek Flash - $0):** Rutin kod, doküman, GitHub repo ve web analizleri.
  2. **Puter Pro (DeepSeek R1/Pro - $0):** Derin akıl yürütme, matematiksel analiz ve karmaşık refactoring.
  3. **Muse Agent (muse-spark-1.3-contributor - $0):** Meta otonom kodlama modeli (ücretsiz contributor modu kilitli).
  4. **Codex (OpenAI GPT-6 / 5.6):** İleri seviye planlama ve sandbox çalıştırma.
  5. **Antigravity / Gemini:** Nihai cerrahi uygulama ve orkestrasyon.

- **Kademeli Bekçi Protokolü (Staged Watchdog: 30s -> 120s -> 240s):**
  Arka planda çalışan alt motorların takılmasını, oturum beklemesini veya askıda kalmasını dinamik olarak denetler; erken iptalleri önlemek için `TimerCondition='never'` protokolüyle çalışır.

- **Dinamik Yürütme Raporu (Dynamic Path Reporting):**
  Her işlem sonunda sadece fiilen çalışan motorları raporlar:
  ```text
  path: gemini --> puter(deepseek-flash) [OK]
  succeed_with: puter
  ```

- **Global Hook & Sistem Entegrasyonu:**
  Antigravity CLI ve IDE üzerinde global olarak devrededir (`hooks.json`, `hook_handler.js`). Herhangi bir proje dizininde veya yeni oturumda kullanıcı müdahalesine gerek kalmadan arka planda çalışır.

- **Canlı Kota ve Kullanım Takibi (Live Quota Tracker):**
  Puter, Muse, Codex ve Antigravity kalan kotalarını tek merkezden canlı izler.

---

## 📂 Proje Yapısı

```text
ai_factory/
├── router.mjs                 # Ana giriş noktası (CLI wrapper)
├── server.mjs                 # Puter RPC / local köprü servisi
├── quota_tracker.mjs          # Çoklu motor kota izleme motoru
├── check_quotas.ps1           # PowerShell hızlı kota kontrol scripti
├── deploy_skill.mjs           # Beceriyi global Antigravity dizinlerine dağıtma scripti
├── router_config.json         # Motor ve watchdog konfigürasyonu
├── src/                       # Çekirdek modüller
│   ├── router.mjs
│   ├── server.mjs
│   └── quota_tracker.mjs
├── lib/                       # Yardımcı kütüphaneler
│   ├── paths.mjs
│   └── plugin.mjs
├── scripts/
│   └── setup.mjs              # Otomatik ortam kurulumu
└── plugins/ai-factory/        # Global Antigravity Eklentisi
    ├── plugin.json            # Eklenti manifesti
    ├── hooks.json             # Olay kancaları (PreInvocation, PreToolUse)
    ├── hooks/
    │   ├── hook_handler.js    # Otomatik yönlendirme ve context koruma kancası
    │   └── inject.js          # Sistem enjeksiyonu
    ├── rules/
    │   ├── AGENTS.md          # Global ajan ve watchdog kuralları
    │   ├── GEMINI.md          # Gemini senkronizasyon kuralları
    │   └── ai_factory_router.md
    └── skills/ai-factory/
        └── SKILL.md           # Antigravity beceri dokümantasyonu
```

---

## 🚀 Kurulum

### 1. Gereksinimler
- Node.js 18+
- Antigravity CLI (`agy`) veya Antigravity IDE

### 2. Bağımlılıkları Yükleme
```powershell
npm install
```

### 3. Global Beceriyi ve Kuralları Dağıtma
Tüm Antigravity ve Gemini dizinlerine kuralları ve becerileri senkronize etmek için:
```powershell
node deploy_skill.mjs
```

---

## 💻 Kullanım

### Temel Görev Devri (Varsayılan: 0$ Puter Flash)
```powershell
node router.mjs --task "GitHub reposunu analiz et ve mimariyi özetle"
```

### Derin Akıl Yürütme (0$ Puter Pro / R1)
```powershell
node router.mjs --engine puter --model pro --task "Verilen algoritmanın karmaşıklığını optimize et"
```

### Meta Muse Modeli (0$ Contributor Modu)
```powershell
node router.mjs --engine muse --task "Bağımlılıkları güncelle ve birim testleri yaz"
```

### OpenAI / Codex Modeli
```powershell
node router.mjs --engine codex --model gpt-6.1-sol --task "Proje için mimari refactoring planı çıkar"
```

### Canlı Kota Durumunu Görüntüleme
```powershell
node router.mjs --quota
# veya PowerShell üzerinden:
.\check_quotas.ps1
```

---

## 🔒 Güvenlik

- `puter_token.txt` ve kimlik doğrulama anahtarları `.gitignore` ile korunmaktadır ve depoya dahil edilmez.
- Muse entegrasyonu yalnızca ücretsiz olan `muse-spark-1.3-contributor` modeline kilitlenmiştir, ücretli API çağrıları engellenmiştir.

---

## 📄 Lisans
MIT License