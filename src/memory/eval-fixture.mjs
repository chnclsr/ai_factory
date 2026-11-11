// Canary eval set for retrieval (docs/memory-plan.md 6D: recall@5 >= 0.95). Not a test file.
//
// A project gets `distractors` generic pages and turns built from the same topic vocabulary, plus
// one canary document per case. Each case has a query; recall@5 is the share of queries whose
// canary document ranks in the top five.
//
//   lexical    queries share the canary's distinctive words (the FTS5 target)
//   inflected  Turkish queries whose words carry different suffixes than the stored text, and
//              English queries with a typo; plain term matching misses most of them

import { commitProject } from './store.mjs';

const ENTITIES = ['pelican', 'zephyr', 'quartz', 'falcon', 'mistral', 'juniper', 'obsidian', 'tundra', 'saffron', 'cobalt',
  'harbor', 'lantern', 'meridian', 'nimbus', 'orchid', 'prism', 'raven', 'sequoia', 'thistle', 'umber'];
const TOPICS = ['router', 'fallback', 'session', 'engine', 'quota', 'watchdog', 'handoff', 'memory', 'commit', 'project',
  'index', 'budget', 'token', 'timeout', 'retry', 'cache', 'config', 'deploy', 'schema', 'parser'];
const VERBS = ['raised', 'lowered', 'moved', 'renamed', 'split', 'merged', 'pinned', 'removed'];

const TR_FACTS = [
  ['Ödeme servisinin zaman aşımı otuz saniyeye çıkarıldı', 'ödeme servisi zaman aşımını kaç saniye yaptık'],
  ['Veritabanı yedeği her gece saat ikide alınıyor', 'veritabanının yedeklerini ne zaman alıyoruz'],
  ['Kullanıcı oturumları Redis kümesinde tutuluyor', 'kullanıcının oturumu hangi kümede saklanıyor'],
  ['Fatura dosyaları sıkıştırılmış arşivde duruyor', 'faturaların dosyası nerede arşivleniyor'],
  ['Günlük raporlar yöneticilere e-postayla gönderiliyor', 'günlük raporu yöneticiye nasıl gönderiyoruz'],
  ['Sipariş kuyruğu tek bir işçiyle işleniyor', 'siparişlerin kuyruğunu kaç işçi işliyor'],
  ['Arama dizini her pazartesi yeniden kuruluyor', 'aramanın dizinini hangi gün kuruyoruz'],
  ['Mobil uygulamanın sürüm numarası derlemede üretiliyor', 'mobil uygulama sürümünü nerede üretiyoruz'],
  ['Kargo takip bağlantıları yedi gün geçerli kalıyor', 'kargonun takip bağlantısı kaç gün geçerli'],
  ['Stok sayımı ay sonunda elle doğrulanıyor', 'stokların sayımını ne zaman doğruluyoruz']
];

const EN_TYPO = [
  ['The billing exporter writes CSV files into the nightly bucket', 'where does the biling exportr write its files'],
  ['Thumbnail generation runs on the background worker pool', 'which pool runs thumbnial generaton'],
  ['Webhook signatures are verified with the shared secret', 'how are webhok signatres verified'],
  ['The invoice renderer uses a fixed monospace typeface', 'what typefase does the invoce renderer use'],
  ['Feature flags are refreshed from the config service every minute', 'how often are feture flags refresed']
];

function pick(list, seed, offset = 0) {
  return list[(seed * 7 + offset * 13) % list.length];
}

function filler(seed, words = 40) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(pick(TOPICS, seed + i, i));
  return out.join(' ');
}

export function evalCases() {
  const lexical = ENTITIES.flatMap((entity, i) => [0, 1].map(variant => {
    const topic = pick(TOPICS, i, variant);
    const verb = pick(VERBS, i, variant);
    const value = 10 + i * 3 + variant;
    return {
      id: `lex-${entity}-${variant}`,
      kind: variant ? 'turn' : 'page',
      text: `The ${entity} ${topic} limit was ${verb} to ${value} after the incident review. ${filler(i * 3 + variant, 30)}`,
      query: `what happened to the ${entity} ${topic} limit`
    };
  }));
  const inflected = [...TR_FACTS.map(([text, query], i) => ({ id: `tr-${i}`, kind: i % 2 ? 'turn' : 'page', text, query })),
    ...EN_TYPO.map(([text, query], i) => ({ id: `typo-${i}`, kind: i % 2 ? 'page' : 'turn', text, query }))];
  return { lexical, inflected };
}

// Writes distractors and canaries into one commit on `project`. Returns the cases with the
// document id each canary was stored under (pages/<slug>.md or <sid>#<n>).
export function writeEvalProject(repoDir, project, { distractors = 400, sets = ['lexical', 'inflected'] } = {}) {
  const all = evalCases();
  const cases = sets.flatMap(set => all[set].map(c => ({ ...c, set })));
  commitProject(repoDir, project, { subject: 'eval fixture', trailers: { Kind: 'fixture' } }, view => {
    view.write('project.json', JSON.stringify({ key: project }));
    let jsonl = '';
    let n = 0;
    const sid = 'eval-distractors';
    for (let d = 0; d < distractors; d++) {
      const text = `The ${pick(TOPICS, d)} ${pick(TOPICS, d, 1)} limit was ${pick(VERBS, d)} again. ${filler(d, 60)}`;
      if (d % 2) view.writeRaw(`pages/distractor-${d}.md`, `---\nversion: 1\nseq: 1\n---\n${text}\n`);
      else jsonl += JSON.stringify({ kind: 'turn', n: ++n, seq: 1, ts: new Date(0).toISOString(), engine: 'vibe', model: 'm', ok: true,
        task: text.slice(0, 80), response_head: text, files: [] }) + '\n';
    }
    view.writeRaw(`sessions/${sid}.jsonl`, jsonl);
    view.writeRaw(`sessions/${sid}.meta.json`, JSON.stringify({ sid, updated: new Date(0).toISOString() }));
    let canaryN = 0;
    let canaryLog = '';
    for (const c of cases) {
      if (c.kind === 'page') {
        view.write(`pages/${c.id}.md`, `---\nversion: 1\nseq: 1\n---\n${c.text}\n`);
        c.docId = `pages/${c.id}.md`;
      } else {
        canaryN++;
        canaryLog += JSON.stringify({ kind: 'turn', n: canaryN, seq: 1, ts: new Date(0).toISOString(), engine: 'claude', model: 'm', ok: true,
          task: c.text, response_head: 'done', files: [] }) + '\n';
        c.docId = `eval-canary#${canaryN}`;
      }
    }
    view.writeRaw('sessions/eval-canary.jsonl', canaryLog);
    view.writeRaw('sessions/eval-canary.meta.json', JSON.stringify({ sid: 'eval-canary', updated: new Date(0).toISOString() }));
  });
  return cases;
}

// recall@k for `rank(query) -> [docId...]` over the given cases, plus the misses.
export function recallAt(cases, rank, k = 5) {
  const misses = [];
  let hits = 0;
  for (const c of cases) {
    const top = rank(c.query).slice(0, k);
    if (top.includes(c.docId)) hits++;
    else misses.push({ id: c.id, query: c.query, top: top.slice(0, 3) });
  }
  return { recall: cases.length ? +(hits / cases.length).toFixed(3) : 1, hits, total: cases.length, misses };
}
