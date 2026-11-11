# ai_factory hafıza katmanı: git tabanlı, sıralı, çok projeli, her sağlayıcıda test edilmiş

## Bağlam

ai_factory'nin router'ı (`src/router.mjs`) bir çağrıdan ötekine bilgi taşımıyor:

- `session_registry.json` global bir sözlük ve projeye bağlı değil. Farklı projelerde aynı adı taşıyan oturumlar birbirinin üzerine yazar (`router.mjs:961`).
- Kayıt kilit olmadan oku-değiştir-yaz yöntemiyle güncelleniyor. Aynı anda çalışan iki router birbirinin değişikliğini siler.
- Fallback motor değiştirdiğinde (Vibe → OpenCode → Muse → Codex → Gemini) önceki denemenin bağlamı kayboluyor.

Hedefler:

- Hafıza git'te dursun ve her projede yazmalar tek bir sırayla dizilsin.
- Proje değiştirme ve aynı projede birden çok oturum desteklensin.
- **Her sağlayıcıyla çalıştığı testle kanıtlansın.**
- **Hafıza katmanı neredeyse sıfır maliyetli olsun:** okuma yolunda hiç git süreci başlatılmasın, yazma yolunda en fazla bir tane başlatılsın, motora gönderilen token sıkı bir bütçeyle sınırlansın.

Kullanıcının verdiği kararlar:

- Hafıza ayrı, merkezi bir bare git deposunda duracak; her projenin kendi ref'i olacak.
- Her projenin tek bir sırası olacak; yeni commit ref'e CAS ile eklenecek.
- Oturum kimliği otomatik üretilecek, `--name` ise yalnızca bir takma ad olacak.

## 0. Benzer projelerden çıkan bulgular (deep-research, wf_6c15ff4f-f95)

Kaynak: 5 açıdan arama, 20 kaynak, 87 iddia, 25'i doğrulandı (12 doğrulandı, 13 çürütüldü). Örneklem küçük: yaklaşık 7 kaynak. Ayrıntılı tablo çalışma çıktısındadır; buradaki maddeler plana etkisi olanlardır.

- **Yerel SQLite varsayılandır, uzak veritabanı isteğe bağlıdır.** Plan bu modelle uyumlu.
- **Yalnızca FTS5 aramasının çalışan bir taban olduğu gösterildi** (fellowgeek/mcp-memory, 222 yıldız, vektörsüz). Vektör katmanı zorunlu olmamalı; FTS5 önce gelir (adım 6), vektör ancak kendi ölçümü kazandırırsa açılır.
- **Mem0 kapsamı üç modla ayırır:** `repo` (varsayılan), `dir` ve `mine`. Proje anahtarı normalize edilmiş git remote'unun hash'idir. Plana eklendi (bkz. bölüm 2).
- **Mem0 yakalamayı toplu yapar:** beş tamamlanmış alışverişte bir ya da 5 dakikalık boşlukta gönderir; oturum sonu ve sıkıştırmada kalanı boşaltır. Enjeksiyon ilk istemde yapılır, en az 20 karakter şartıyla ve en fazla 5 bellek. Plana eklendi (bkz. bölüm 3).
- **Çapraz harness paylaşımı nadirdir.** Yalnızca Cognee'nin belgelediği tasarımı var (`~/.cognee/.env` ve ortak veri kümesi; Claude Code ve Codex). Mem0 bunu açıkça dışarıda bırakıyor. Bu, planın ayırt edici özelliği. Cognee'nin Cursor davranışı belirsiz; bu yüzden plan Cursor'ı kapsamaz.
- **Oturum kimliği `--resume` ile eşleşmiyor.** "Cognee `--resume` ile aynı bellek oturumuna döner" iddiası çürütüldü. Plan zaten iki kimliği ayırıyor (bellek oturumu ve motorun `engine_sessions` kimliği).
- **Bellek dosyaları bir saldırı yüzeyi.** arXiv 2607.14611 (Bad Memory): Claude Code ve Codex'te bellek dosyasına yerleştirilmiş yükler sonraki oturumları etkiledi. Yeni güvenlik bölümü ve bir test bunu ele alıyor (bölüm 5 ve A11).
- **claude-handoff** yalnızca Claude Code içindir: handoff'u elle oluşturur, `SessionStart` ile otomatik enjekte eder. Plana elle `memory handoff begin` komutu eklendi (bölüm 4).

## 1. Depo ve sıralı yazma

```
<DATA_DIR>/memory.git                  bare repo; ref'ler hep gevşek tutulur (packed-refs kullanılmaz)
  refs/heads/p/<project>               projenin tek sıralı zinciri
    project.json                       kimlik, aliases (eski adlar)
    sessions/<sid>.jsonl               oturum günlüğü (yalnız sona eklenir; satırlarda n, ts, engine, kind)
    sessions/<sid>.meta.json           alias, cwd, engine_sessions{engine: id}, last_injected_seq{engine_sid: seq}
    sessions/<sid>.summary.md          oturum kapanınca kural tabanlı özet (LLM kullanılmaz)
    handoffs/<hid>.md                  state open|accepted|expired
    pages/<slug>.md                    version, supersedes, session
<DATA_DIR>/memory-index.sqlite         türetilmiş: metin, FTS5, vektör, graf, last_indexed_commit, pack önbelleği
```

**Git sürecine gerek bırakmayan yazıcı** (`src/memory/gitobj.mjs`). Git'in nesne biçimi basit olduğu için yazıcı JS ile kurulacak:

- blob, tree ve commit nesneleri `sha1` ile adreslenir, `zlib.deflateSync` ile sıkıştırılır ve `objects/xx/yyyy…` altına atomik olarak yazılır (önce tmp, sonra rename).
- CAS, git'in kendi kilit protokolüyle yapılır: `refs/heads/p/<project>.lock` dosyası `O_EXCL` ile açılır, eski sha doğrulanır, yeni sha yazılıp fsync edilir, kilit dosyası ref'in üzerine rename edilir. Kilit alınamazsa ya da sha değişmişse jitter'lı bir yeniden deneme yapılır; en fazla 8 deneme.
- Commit trailer'ları: `Seq:` (zincir yüksekliği, proje içindeki toplam sıra), `Session:`, `Engine:`, `Kind:`.
- Yazar sabittir (`ai-factory <ai-factory@localhost>`) ve imza yoktur. Kullanıcının git yapılandırması devreye girmez.
- Git CLI yalnızca bakım işlerinde çalışır: `git gc`, `git fsck`, proje birleştirme. Testlerde `git fsck --strict` her nesneyi doğrular.
- Hedef, Windows'ta bir yazmanın p95 değerinin 15 ms'nin altında kalması. Plumbing ile 5–6 süreç başlatmak yaklaşık 100 ms sürerdi.

Bir router çağrısı tek bir commit üretir. Her oturum yalnızca kendi `sessions/<sid>.*` dosyalarını değiştirdiği için eşzamanlı oturumlar çakışmaz; yeniden deneme yalnızca ağacı yeni ebeveynin üstünde kurar.

**Sayfalarda sürümleme:** Her düzenleme, okuduğu sürümün blob sha'sını `base` olarak taşır. Bu sha güncel sürümle eşleşmiyorsa yeni içerik `version+1` olarak yazılır ve `supersedes` ile `conflict_with` alanları eklenir. Eski sürüm silinmez.

## 2. Proje ve oturum

- **Proje** (`src/memory/project.mjs`): önce `--project` bayrağına bakılır. Sonra `--cwd` dizininden yukarı doğru `.ai-factory.toml` aranır. O da yoksa normalize edilmiş remote kullanılır: önce `upstream`, sonra `origin` (`github.com/acme/api` → `acme-api`). Hiçbiri yoksa klasör adı alınır. Remote, `.git/config` dosyası doğrudan okunarak bulunur; git süreci başlatılmaz. Proje değiştirmek, başka bir `--cwd` ile çağırmak demektir; global bir "aktif proje" tutulmaz.
- `memory project list|rename|merge` komutları:
  - `rename`: eski ad `aliases` listesine eklenir.
  - `merge`: iki zincir bir merge commit ile birleşir.
- **Arama kapsamı** `--scope` ile seçilir (`repo` varsayılan, `dir`, `mine`). `repo`: proje ref'i. `dir`: yalnızca o `--cwd` altında kaydedilmiş olaylar. `mine`: kullanıcının kendi tercihleri ve kişisel notları; proje ref'inden ayrı bir `personal` ref'inde tutulur, hiçbir zaman proje aramasına karışmaz.
- Proje anahtarı normalize edilmiş remote'un kısa hash'idir; okunabilir ad yalnızca görüntüleme için kullanılır. Böylece farklı klasörler aynı remote'u paylaşınca aynı projeye düşer.
- Projeler arası arama yalnızca `--global` ile yapılır.
- **Oturum** kimlik sırası: `--session`, ardından hook'tan gelen `AI_FACTORY_SESSION_ID`, o da yoksa UUIDv7. `--name`/`--resume` takma adları `(project, alias)` ikilisine göre çözülür.
- **Geçiş:** `session_registry.json` ilk açılışta okunur. Her kayıt, `cwd`'sinden çözülen projeye `legacy-<ad>` kimliğiyle taşınır. Dosya `.migrated` uzantısıyla saklanır. `cwd` değeri olmayan kayıtlar `_unscoped` projesine düşer ve bunun için uyarı ile düzeltme komutu yazılır.

## 3. Ultra verimli bağlam enjeksiyonu

Asıl verim buradan gelir: motora yalnızca gereken bilgi ve yalnızca bir kez gönderilir.

- **Delta enjeksiyonu.** Her motor oturumu için `last_injected_seq` tutulur. `--resume` aynı motor oturumunu sürdürüyorsa motorun önceki bağlamı zaten vardır; bu yüzden yalnızca o seq'ten sonra gelen commit'lerin özeti gönderilir. Değişiklik yoksa hiçbir şey eklenmez. Yeni bir motora (yeni oturum ya da fallback) tam paket gider.
- **Katmanlı paket**, düşük katman önce dolar ve bütçe dolunca durur:
  - L0: açık handoff ve fallback'te önceki denemenin hatası (en fazla 300 token)
  - L1: bu oturumun özeti ve son N olay (en fazla 400 token)
  - L2: aramadan gelen sayfalar (bütçenin kalanı)
- **İlk istem kapısı.** Enjeksiyon yalnızca görev metni en az 20 karakter ise yapılır; en fazla 5 sayfa ya da özet girer. Kısa komutlar (ör. "devam") bütçe harcamaz; bunlar delta ile zaten sürdürülür.
- **Toplu yakalama.** Router çağrısı tek commit üretir (bölüm 1). Hook kaynaklı olaylar (Antigravity) 5 olayda ya da 5 dakikalık boşlukta toplu yazılır; oturum sonu ve sıkıştırma kalanı boşaltır. Yazma sayısı böylece olay sayısına değil oturum sayısına yakın kalır.
- **Model başına bütçe.** `router_config.json` içindeki her modele `memory_budget_tokens` alanı eklenir. Küçük ve ücretsiz modellere (vibe flash, opencode free) 800 civarı, Claude ve Codex'e 2000 civarı token ayrılır. Token sayısı `karakter/4` ile yaklaşık hesaplanır, tokenizer çalıştırılmaz.
- **İçerik adresli önbellek.** Paket, `(project head sha, session, engine, budget, query hash)` anahtarıyla önbelleğe alınır. Proje değişmediyse paket yeniden kurulmaz.
- **Okuma yolunda git süreci yok.** Ref sha'sı doğrudan dosyadan okunur. İndeks bu sha'nın gerisindeyse yalnızca aradaki commit'ler JS ile açılıp işlenir; metin SQLite'tan gelir.
- **Kanal:** her motor görevini zaten bir dosyadan alıyor (codex ve claude stdin'den, opencode `--file` ile, vibe ve muse `--prompt-file` ile). Paket bu dosyanın başına `<retrieved-memory untrusted="true">` bloğu olarak eklenir. Komut satırı uzunluğu sınırına takılma riski yoktur.
- Kopyalar, git'in içerik adreslemesi sayesinde zaten tek nesne olarak saklanır. Özetler kural tabanlı üretilir, LLM çağrısı yapılmaz.

## 3b. Aynı oturumda model değiştirmek: sohbet ve dosya değişiklikleri

Aynı oturumda modeller sırayla kullanılabilir (ör. Claude, ardından Codex, ardından tekrar Claude). Her motorun kendi yerel oturumu yalnızca kendi konuşmasını bilir. Bu yüzden ortak kayıt hafızada tutulur: her router çağrısı bir **tur** olarak yazılır.

**Tur kaydı.** `sessions/<sid>.jsonl` dosyasına her çağrı için bir satır eklenir:

```
{n, ts, engine, model, engine_session, ok, task, response_head, response_ref,
 wt_before, wt_after, files:[{path, status, +add, -del}], patch_ref}
```

- `task` ve yanıtın ilk 2 KB'ı (`response_head`) satırda durur. Yanıtın tamamı, en fazla 256 KB olacak şekilde, `sessions/<sid>/turns/<n>.response.md` dosyasına yazılır.
- Hepsi sanitizer'dan geçer. Aynı commit'e girer, böylece Seq sırası korunur.

**Dosya değişiklikleri** (`src/memory/worktree.mjs`). Her çağrıdan önce ve sonra kullanıcının projesinin anlık görüntüsü alınır:

- Proje git deposuysa: `GIT_INDEX_FILE=<tmp> git add -A` ve ardından `git write-tree` çalıştırılır. Bu yöntem kullanıcının index'ine ve çalışma ağacına dokunmaz, `.gitignore`'a uyar ve izlenmeyen yeni dosyaları da yakalar. Sonuç `wt_before` ve `wt_after` tree sha'larıdır.
- İki tree arasındaki `git diff --numstat` ve patch, **yalnızca bu turda yapılan** değişikliği verir. Kullanıcının daha önce commit etmediği işler bu turun değişikliği sayılmaz.
- Patch sanitize edilir, en fazla 512 KB olacak şekilde sınırlanır ve `sessions/<sid>/turns/<n>.patch` dosyasına yazılır. Binary dosyalar için yalnızca yol ve boyut tutulur.
- Proje git deposu değilse yol, boyut ve mtime ile bir anlık görüntü alınır (en fazla 20 bin dosya). Bu durumda yalnızca değişen dosyaların listesi tutulur, patch tutulmaz.
- Kullanıcının deposuna erişilemiyorsa ya da işlem 2 saniyeyi aşarsa dosya değişikliği kaydı atlanır, tur yine de yazılır ve `files: "unavailable"` olarak işaretlenir. Hafıza hiçbir zaman görevi durdurmaz.
- Hesap yalnızca `memory.track_files=true` olduğunda yapılır (varsayılan açık). Okuma yoluna hiç ek maliyet getirmez. Çağrı başına 4 git süreci başlatır; 10 bin dosyalık bir depoda hedef 300 ms'nin altı.

**Model değişince ne gönderilir.** Yeni bir motora ya da başka bir motordan sonra geri dönen motora, `last_injected_seq` değerinden sonraki turlar gönderilir:

- **L1 sohbet:** son K tur `görev → yanıtın başı` biçiminde aynen, daha eski turlar tek satırlık özetlerle verilir. Bütçe dolunca durulur.
- **L1 dosyalar:** bu turlarda değişen dosyalar ve `+/-` satır sayıları. Patch'in kendisi gönderilmez, çünkü motor güncel dosyayı zaten diskten okuyabilir. Yalnızca dosya silinmişse ya da yeniden adlandırılmışsa bu açıkça yazılır.
- Örnek: Claude 1. turda `a.ts` dosyasını değiştirdi, ardından Codex çağrıldı. Codex'e şu gider: "1. tur (claude/haiku-5.5): <görev> → <yanıtın başı>; değişen: a.ts +12 −3". Ardından Claude tekrar çağrılırsa ona yalnızca Codex'in turu gider.

**Ek komutlar:**

- `memory session show <ad|sid>`: turları, motorları ve dosyaları listeler.
- `memory turn diff <n>`: kayıtlı patch'i gösterir.
- `memory turn revert <n>`: `wt_after` ile `wt_before` arasındaki farkın tersini `git apply -R --3way` ile uygular. Uygulamadan önce kullanıcıya etkilenen dosyaları gösterir ve onay ister.

## 4. Handoff

- Fallback zincirinde motor değiştiğinde (`router.mjs:899` döngüsü) L0 paketi yeni motorun görev dosyasına eklenir.
- Gemini'ye devredildiğinde ya da tüm motorlar başarısız olduğunda `handoffs/<hid>.md` dosyası `state: open` ile yazılır. Rapora `handoff: <hid>` satırı eklenir.
- **Elle handoff:** `memory handoff begin --to <motor|any>` komutu aynı dosyayı kullanıcı isteğiyle oluşturur (claude-handoff'un elle oluşturma deseni). Otomatik ve elle handoff aynı durum makinesini paylaşır.
- Handoff'un alınması, `open → accepted` değişikliğini yapan bir CAS commit'idir; bu yüzden yalnızca bir kez alınabilir.
- Hook (`plugins/ai-factory/hooks/hook_handler.js`), `PreInvocation` sırasında açık handoff'u kural metnine ekler. Yalnızca dosya okur, 50 ms'yi aşmaz, hata olursa `allow` döner.

## 5. Güvenlik

- `src/memory/sanitize.mjs`: yazılan her metin önce buradan geçer. Maskelenen desenler: `sk-…`, `ghp_…`, Telegram bot token, `Bearer`, `.env` atamaları. Olay başına boyut sınırı uygulanır.
- `.ai-factory.toml` içinde `ignore_paths` tanımlanır (`.runtime/`, `telegram-config.json`, watchdog logları).
- Hafızadan okunan içerik talimat olarak değil, veri olarak işaretlenir.
- **Bellek kaynaklı enjeksiyon (Bad Memory bulgusu).** İşaretleme tek başına yetmez; bellek dosyaları oturum açılışında yüksek güvenle yüklenir. Üç katman uygulanır:
  1. Yazma anında: yanıt ve görev metni sanitizer'dan geçer, kalıp dışı talimat benzeri bloklar (`ignore previous`, `system:`, sahte `<retrieved-memory>` etiketleri) etiketlenir ve enjekte edilmez.
  2. Motorlar arası yayılım: bir motorun yanıtı başka bir motora yalnızca "veri" olarak gider; bir sonraki motorun talimat dosyasına (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) hiçbir zaman yazılmaz.
  3. Kayıt: her enjekte edilen bloğun kaynak tur numarası ve hash'i günlüğe düşer; bir yük ortaya çıkarsa hangi turdan geldiği izlenir ve `memory turn revert` ile geri alınabilir.
- Kayıt ayrı izinlerle tutulur (`0700`); bellek deposu hiçbir zaman harness'in otomatik yüklediği bir dizinde durmaz.
- `AI_FACTORY_ROUTER_DEPTH > 0` olduğunda enjeksiyon yapılmaz.
- `memory.enabled=false` olduğunda router'ın davranışı bugünküyle birebir aynı kalır.

## 6. Sağlayıcı uyumluluk matrisi ve testleri

| Motor | Görev kanalı | Oturum kimliğinin kaynağı | Resume | Doğrulanacak |
|---|---|---|---|---|
| vibe | `--prompt-file` | çıktıdan (`extractSessionId`) | `--resume <id>`, model sabit | yeni, resume (delta), fallback girişi |
| opencode | `--file` eki | JSON `ses_…` | `--session` | yeni, resume, fallback girişi, model başına sağlık |
| muse | `--prompt-file` | router üretir (`--session-id`) | aynı id | yeni, resume; kimlik her zaman bilinir |
| codex | stdin | çıktıdan | `exec resume <id>` (cwd `runCommand` ile gelir) | yeni, resume, fallback girişi |
| claude | stdin | JSON `session_id` | `--resume` | yeni, resume, model değişimiyle resume |
| gemini | handoff, prompt yok | Antigravity konuşma kimliği | yok | handoff dosyası, hook enjeksiyonu, tek seferlik alma |

**A. Sözleşme testleri (CI'da her zaman çalışır).** `src/router.engines.test.mjs` içindeki `childProcess.spawn` yakalama deseni genişletilir. Her motor için sahte bir CLI görev dosyasını ya da stdin'i okur ve kaydeder. Her motor ve senaryo için şunlar doğrulanır:

1. Hafıza bloğu doğru kanaldan geldi ve bütçe aşılmadı.
2. Resume'da yalnızca delta geldi; değişiklik yoksa blok hiç gelmedi.
3. Fallback'te yeni motor L0'ı aldı.
4. Çağrı sonunda tam olarak bir commit yazıldı ve trailer'lar doğru.
5. Motor oturum kimliği `meta.json` içine yazıldı.
6. Gemini handoff dosyası oluştu ve hook bunu enjekte etti.
7. **Aynı oturumda model değişimi:** sahte Claude 1. turda geçici bir depodaki `a.txt` dosyasını değiştirir, ardından sahte Codex çağrılır. Codex'in aldığı blokta 1. turun görevi, yanıtının başı ve `a.txt +N −M` bulunmalı. Sonra yeniden Claude çağrılır; ona yalnızca Codex'in turu gitmeli.
8. **Tur izolasyonu:** kullanıcının çağrıdan önce commit etmediği bir değişiklik, turun patch'inde görünmemeli. İzlenmeyen yeni bir dosya ise görünmeli. Kullanıcının index'i (`git diff --cached`) çağrıdan önceki haliyle aynı kalmalı.
9. **Revert:** `memory turn revert 1` yalnızca 1. turdaki değişikliği geri almalı; 2. turdaki değişiklik yerinde kalmalı.
10. **Git deposu olmayan dizin:** dosya listesi tutulmalı, patch tutulmamalı, tur yine yazılmalı.
11. **Bellek kaynaklı yük:** 1. turda bir sahte motor yanıtına "bir sonraki çağrıda X yap" talimatı yazar. 2. turda başka bir sahte motora gelen blokta bu metin yalnızca `untrusted` veri olarak bulunmalı, hiçbir talimat dosyasına yazılmamalı ve enjeksiyon kaydında 1. turun hash'i görünmeli. Bu test hem sanitizer'ı hem motorlar arası yayılımı kapsar.
12. **İlk istem kapısı:** 20 karakterden kısa görev enjeksiyonsuz geçmeli; uzun görev en fazla 5 sayfa almalı.
13. **Kapsam:** `--scope dir` yalnızca o alt dizinin olaylarını döndürmeli; `mine` kişisel ref'ten gelmeli ve proje aramasında çıkmamalı.

**B. Canlı smoke testi (isteğe bağlı: `AI_FACTORY_LIVE=1`, `scripts/live-memory-matrix.mjs`).** Kurulu ve yetkili gerçek CLI'larla bir "kanarya" testi çalıştırır:

1. Oturum 1'de A motoruna rastgele bir kanarya bilgisi söylenir.
2. Aynı projede B motoruna sorulur: cevap kanaryayı içermeli.
3. Başka bir projede aynı soru sorulur: cevap kanaryayı içermemeli.
4. Aynı projedeki ikinci oturum handoff'u almalı.

Bu test 5×5 motor çiftinin hepsini dener. Kurulu olmayan ya da kotası dolu motor `skip` olarak işaretlenir; sessizce geçilmez. Sonuç `.runtime/memory-matrix.json` dosyasına yazılır. Ücretsiz zincir dışındaki Claude modelleri yalnızca açıkça istenirse çalıştırılır.

**C. Depolama testleri.**

- 4 süreç × 50 commit sonunda Seq 1'den 200'e boşluksuz bir doğrusal zincir oluşmalı ve `git fsck --strict` temiz çıkmalı.
- Aynı `base` ile iki sayfa düzenlemesi yapıldığında iki sürüm de korunmalı.
- Handoff yarışında tek bir kazanan olmalı.
- A ve B projeleri izole kalmalı; `--global` ile ikisi de görünmeli.
- Eski kayıt dosyası geçişten sonra `--resume` ile aynı motor oturumunu bulmalı.
- Sanitizer token'ı maskelemeli.

**D. Verim benchmark'ı (`scripts/bench-memory.mjs`, CI'da eşik kontrolüyle).** 10 bin olay ve 1000 sayfalık bir fixture üzerinde ölçülecek hedefler:

| Ölçüm | Hedef |
|---|---|
| Yazma p95 | < 15 ms |
| Paket kurma p95, sıcak | < 10 ms |
| Paket kurma p95, soğuk | < 40 ms |
| Okuma yolunda başlatılan git süreci | 0 |
| Enjekte edilen token | her zaman bütçenin altında |
| Değişiklik yokken resume'da enjekte edilen token | 0 |
| Kanarya eval setinde recall@5 | ≥ 0.95 |

## 7. Geliştirme sırası

Her adım ayrı bir PR olacak ve kendi testleriyle gelecek.

1. `gitobj.mjs` (nesne yazıcı, CAS), `project.mjs`, `sanitize.mjs`; `lib/paths.mjs` içine `MEMORY_REPO` ve `MEMORY_INDEX` eklenir. Testler: C ve D'nin yazma kısmı.
2. Tur kaydı ve dosya izleme: `worktree.mjs`. Her `execute*` çağrısının öncesinde ve sonrasında anlık görüntü alınır (`router.mjs:916`). `main()` sonunda (`router.mjs:954` civarı) her çağrı için tek bir commit yazılır. Testler: A8–A10.
3. Oturumlar: `--session`/`--project` bayrakları (`parseCliArgs`, `router.mjs:466`), proje kapsamlı takma adlar, kayıt geçişi.
4. Enjeksiyon: tüm `execute*` fonksiyonlarındaki prompt dosyası yazımı (`router.mjs:614–756`) tek bir `buildPrompt(task, pack)` yardımcısından geçer. Delta, katmanlar (sohbet ve dosya özeti dahil), bütçe ve önbellek burada kurulur. Testler: A1–A5, A7.
5. Handoff, elle handoff komutu ve hook. Testler: A6, A11, C'deki yarış testi.
6. İndeks: `node:sqlite` ile FTS5, commit'leri JS ile okuyarak senkronizasyon, L2 araması. Testler: D'nin geri kalanı.
7. Proje işlemleri (`rename`, `merge`, `--global`) ve canlı matris (B).
8. Vektör katmanı ve ChunkSplice: eşiğin altında brute-force, eşiğin üstünde graf (önceki plandaki Faz 0–5).

## Açık sorular ve sınırlar

- Benzer repolar (claude-mem, agentmemory, basic-memory, Zep/Letta) bu araştırmada doğrulanmadı. `docs/comparison.md` bu nedenle güncellenmedi; ayrı bir araştırma gerekir.
- Bad Memory makalesinin PDF gövdesi okunmadı; kalıcılık oranları yalnızca özet üzerinden geldi, bu yüzden plan sayısal değerlere dayanmıyor.
- ai-memory hakkında araştırmada çürütülen iki iddia (Markdown kaynak olarak, sıfır LLM varsayılanı) doğrudan kod ve belgeyle kontrol edilmeli. Bu, ai-memory'nin tasarımının yanlış olduğu anlamına gelmez.
- Cognee'nin paylaşımlı modu yalnızca belgelerden okundu, çalışma zamanında doğrulanmadı.

## Doğrulama

- `npm test`: mevcut testler ve A, C testleri geçmeli. `node:sqlite` için Node ≥ 22.13 gerekir; `package.json` içindeki `engines` alanı buna göre güncellenir.
- `node scripts/bench-memory.mjs`: D'deki eşiklerin hepsi geçmeli.
- `AI_FACTORY_LIVE=1 node scripts/live-memory-matrix.mjs`: kurulu her motor için kanarya testi geçmeli, kurulu olmayanlar `skip` olarak raporlanmalı.
- Elle kontrol: `git -C .runtime/memory.git log --format='%H %(trailers)' refs/heads/p/<proje>` komutuyla zincirin sırası ve trailer'lar incelenir.

## Deviations

Code behaviour wins over this plan; each entry says why and what was done instead.

1. **Object writes skip tmp + rename (step 1).** On this Windows host each rename costs about 1.5 ms under the endpoint scanner, so the plan's tmp + rename per object would spend the whole write budget on renames. Objects are created in place with `O_EXCL`. Safety comes from ordering: the ref moves only after every object is written, so a crash leaves unreferenced debris at worst. A crash-truncated object is detected by its size (identical input gives identical zlib output) and rewritten before anything references it. The ref itself still follows git's lock protocol (`.lock` with `O_EXCL`, fsync, rename).
2. **The ref lock is held while the tree is built (step 1).** The plan builds optimistically and retries a failed CAS up to 8 times. Under the 4 × 50 contention test, 8 attempts cannot guarantee that no write is lost, which the design forbids. The writer takes the lock first, re-reads the ref under it, builds the tree on that parent and then renames the lock over the ref. Lock acquisition retries with jittered backoff (capped at 4 ms between polls, so a busy writer cannot starve the others) for up to 20 s instead of a fixed count. Old-value verification still happens under the lock, so it remains compare-and-swap.
3. **Remote-derived project keys are `<name>-<hash8>` (step 1).** The plan uses a bare short hash for the key and the readable name for display only. The key keeps the hash, so two remotes with the same path on different hosts still get different refs, and `refs/heads/p/acme-api-1a2b3c4d` stays readable in `git log`. Keys from `--project` and `.ai-factory.toml` are plain slugs.
4. **No packfile reader (step 1).** The repo is created with `gc.auto = 0` and the read path inflates loose objects only. If someone runs `git gc` on `memory.git` by hand, reads fall back to `git cat-file` (a process on the read path) instead of failing.
5. **Write p95 target not met on this host (step 1).** `scripts/bench-memory.mjs` also measures the raw file-system floor: 8 file creates plus one lock/fsync/rename cycle, with no hashing or compression. On the development machine that floor measured p50 12 ms and p95 113 ms, so a commit, which needs those operations, cannot reach p95 < 15 ms here. The memory write itself measured p50 22 ms and p95 32 ms in the same run. Windows Defender real-time protection is off on this host, so another endpoint agent is the likely cause. Nothing in the code was changed to chase the number. The bench reports both figures so a miss can be attributed.
6. **Lock fairness queue (step 2).** Under a loaded full test run, the 4 × 50 race showed starvation: two writers kept releasing and re-taking the ref lock, and the other two timed out. Besides git's `<ref>.lock`, a writer now takes a ticket (an empty directory under `memory.git/ai-factory-locks/<ref>/`) and tries the lock only after every older ticket is gone or belongs to a dead process. The `.lock` protocol and the old-value check are unchanged.
7. **Turn snapshot cost (step 2).** On the development host one snapshot takes 0.25–1.3 s because each git spawn is slow there, so a router call gains about 0.5–4 s of git work around the engine run. The plan's figure was 300 ms for a 10k-file repo. Calls are still bounded by `memory.file_budget_ms` per step. The existing watchdog tests time the engine phase inside a 5 s process limit, so their fixture config sets `memory.enabled = false`; nothing else in those tests changed.
8. **Alias index file (step 3).** Aliases resolve per `(project, alias)` through `session-aliases.json` on the project ref, so a lookup reads one blob instead of every `meta.json`. Writers rebuild it under the ref lock like every other file. Migrated sessions get the id `legacy-<slug(name)>`.
9. **The legacy registry test runs with memory off (step 3).** With memory enabled, `--name`/`--resume` no longer write `session_registry.json`, which is the point of the migration. The existing test in `src/router.engines.test.mjs` that asserts that file's contents now runs with a config copy where `memory.enabled = false`, so it still covers the legacy path. Memory-mode resume, migration from an old-format registry and per-project aliases are covered in `src/memory/sessions.test.mjs`.
10. **`--scope` searches by term matching until step 6 (step 3).** `memory search` and later L2 use a plain term scan over pages and turns read from git objects. FTS5 replaces the ranking in step 6. `--global` belongs to step 7 and is not exposed yet.
11. **`buildPrompt` sits in the attempts loop, not inside each `execute*` (step 4).** The loop passes `buildPrompt(task, pack)`'s result to the executor as its task argument, so every prompt file, `--file` attachment and stdin redirect carries the block while the five `execute*` functions stay unchanged. The effect matches the plan with fewer router edits.
12. **No `sessions/<sid>.summary.md` (step 4).** Router calls have no "session closed" event to trigger it. L1 builds the session view from the turn log at pack time instead: unseen turns, newest three verbatim, older ones on one line, plus a turn count and the engines used.
13. **Cold pack p95 is above the 40 ms informational target (step 4).** The bench measured cold p95 92 ms and warm (cache hit) p95 8.9 ms. Until the step 6 index exists, L2 reads the 50 most recently updated sessions' logs and every page from git objects. Warm p95, zero read-path processes, zero tokens on a no-change resume and the budget ceiling all meet target.
14. **Pack cache scope (step 4).** The cache key includes the project head sha, so the cache hits within one call (fallback attempts) and between calls with no write in between. Every router call moves the head, so cross-call hits are rare in practice. The cache lives in `DATA_DIR/memory-cache/` and is pruned to 256 entries.
15. **The 20-character gate covers the whole block (step 4).** A12 requires a short task to pass with no injection, so a short task gets no L0 either, including on a fallback attempt.
16. **Warm pack p95 sits on the 10 ms line on this host (step 5 bench).** Five bench runs gave 7.9, 8.1, 9.4, 9.7 and 11.1 ms. A breakdown of one warm build: reading the ref, commit and meta takes about 0.6 ms together. Most of the rest is the host's first-open scan of the cache file the previous build just wrote (cache-file read p95 5.5 ms). Spawn counting used to wrap the timed builds and added its own `child_process` patching to every sample, so it now runs on separate builds.
17. **Who takes a handoff (step 5).** The hook only reads, so it cannot take a handoff. Its notice gives the agent the exact `memory handoff accept <id> --cwd <dir>` command. A router engine that was shown an open handoff in L0 and finished its call takes it in that turn's own commit. Both paths flip the state under the ref lock, so exactly one wins. Handoffs to `gemini` are shown only by the hook. Router engines see handoffs addressed to them or to `any`.
18. **The hook does not pass a session id (step 5).** The plan lists `AI_FACTORY_SESSION_ID` from the hook as the second session source. The router honours that variable, but the Antigravity hook payload's conversation id field is not documented or verified here, so the hook does not turn it into a session id. The hook reads the project from `payload.cwd`, `workspaceRoot`, `workspace_root` or `workspace.path` when one is an absolute path, else from its own working directory. Those field names are unverified.
19. **Neutralise before collapsing (step 5).** The A11 test showed that collapsing whitespace before neutralising hid line-anchored patterns such as `system:`. One greedy match then removed a forged `</retrieved-memory>` instead of escaping it. Text is now neutralised first and clipped second, in both the pack and the hook notice.
20. **The index syncs by file, not by commit (step 6).** The plan reads the commits after `last_indexed_commit`. The index instead compares the blob sha of every `sessions/*.jsonl` and `pages/*.md` on the ref with the sha it indexed last. That reads no commit history, survives merges and renames (step 7), and still only parses files that changed. Each document keeps its row while its content is unchanged, so an appended turn inserts one row. The bench measured a full build of 10k turns and 1000 pages at about 1.2 s and an incremental sync at 9–16 ms.
21. **The ref filter is an indexed FTS5 column (step 6).** Filtering by project after ranking cost about 75 ms per query on the bench fixture, where every document shares the query words. Each document now carries a token derived from its ref in a second FTS5 column, and the query is `refkey : (<refs>) AND body : (<terms>)`. Only the top rows are joined with the document table. Cold pack p95 went from 81 ms to 26 ms, inside the 40 ms target that deviation 13 missed.
22. **Prefix matching and the eval set (step 6).** Query terms of four or more characters match as prefixes, so `dosya` finds `dosyaları`; the porter tokenizer with diacritic folding handles English stems. Every term is quoted, so a query cannot carry FTS syntax. recall@5 is measured on `src/memory/eval-fixture.mjs`: 40 lexical canaries among 2000 distractors built from the same vocabulary. The lexical set reaches 1.0. A second set of Turkish queries with different suffixes and English queries with typos is reported but has no target; FTS5 gets 0.667 there, which is the case step 8 measures vectors against.
23. **`--global` and personal notes in the block (step 6).** `memory search --global` ships with the index in step 6, since it is one more ref list for the same query. In the block, `--scope mine` now reads the personal ref in both the index and the scan path; before, the scan path read the project's pages under that scope.
24. **A moved project keeps its ref (step 7).** The plan adds the old name to `aliases` on rename. Resolution happens before any ref is read (from `--project`, `.ai-factory.toml`, the remote or the folder), so an alias list inside the new ref could never be found from the old key. The old ref instead gets a head commit whose tree holds only `project.json` with `moved_to`, on top of its full history, and `followMoves` follows that pointer (at most 8 hops) wherever a project is resolved: the router, the CLI, the hook and the registry migration. `recordTurn` follows it again just before committing, so a call that was running during a rename still lands on the new key. The old name is also recorded in the new ref's `aliases`.
25. **Merge policy (step 7).** The plan says only that two chains are joined with a merge commit. The merge commit's parents are the target's head and the source's head, and its `Seq` is one more than the larger of the two, so `Seq` stays monotonic along first parents. Nothing is dropped: a page that differs on both sides keeps the target's copy and saves the source's as `pages/<slug>.from-<source>.md` (a kept `.vN` version keeps its suffix, so it stays out of the index); any other differing file goes to `merged/<source>/<path>`; a clashing alias from the source becomes `<alias>@<source>`. Rename and merge take both ref locks in name order so two operations on the same pair cannot deadlock, and both need `--yes` or a confirmation.
26. **Engine pairs in the live matrix (step 7).** The plan asks for all 5×5 engine pairs. The canary step already runs every configured model; the pair step uses one passing model per engine (the cheapest Claude model when Claude is included) and runs each ordered pair of different engines once, in rounds where every engine tells once and recalls once, which keeps calls per engine at a level the free tiers allow. Same-engine pairs are the canary step itself. B4 (a second session in the same project takes the handoff) runs once per engine with a manual handoff addressed to that engine; it passes only if the reply carries the handoff's token and `memory handoff list --all` shows it accepted. A CLI whose npm shim points at a missing folder ("The system cannot find the path specified") is now reported as `skip: CLI missing`.
