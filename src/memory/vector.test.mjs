import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './test-helpers.mjs';
import { commitProject, writePage } from './store.mjs';
import { openIndex, closeIndex, syncRef, stmt } from './fts.mjs';
import { embed, dot, chunkText, spliceChunks, vectorSettings, attachVectors, vectorSearch, annRecall } from './vector.mjs';
import { search } from './search.mjs';
import { buildPack } from './pack.mjs';
import { projectRef } from './project.mjs';
import { writeEvalProject, recallAt } from './eval-fixture.mjs';

function setup(t) {
  const dir = tempDir(t, 'mem-vec-');
  const repo = path.join(dir, 'memory.git');
  const file = path.join(dir, 'memory-index.sqlite');
  t.after(() => closeIndex(file));
  return { dir, repo, file };
}

const ON = vectorSettings({ enabled: true });

test('embeddings are deterministic, unit length, and close for inflected forms and typos', () => {
  const a = embed('veritabanı yedeği her gece alınıyor');
  assert.deepEqual(a, embed('veritabanı yedeği her gece alınıyor'));
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-5);
  const inflected = dot(a, embed('veritabanının yedeklerini ne zaman alıyoruz'));
  const unrelated = dot(a, embed('the router fallback chain starts with vibe'));
  assert.ok(inflected > unrelated + 0.2, `${inflected} vs ${unrelated}`);
  assert.ok(dot(embed('billing exporter'), embed('biling exportr')) > 0.5);
  assert.equal(vectorSettings({ enabled: 'yes', dim: 8 }).enabled, false);
  assert.equal(vectorSettings({ dim: 8 }).dim, 32);
});

test('chunks cover the text exactly and ChunkSplice joins adjacent hits into one span', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about topic ${i % 7}.`).join(' ');
  const chunks = chunkText(text, 200);
  assert.ok(chunks.length > 3);
  assert.equal(chunks.map(c => c.text).join(''), text);
  for (const c of chunks) assert.ok(c.text.length <= 200);
  const spans = spliceChunks(text, [chunks[1], chunks[2], chunks[4]].map(c => ({ ...c, score: 0.5 })));
  assert.equal(spans.length, 2);
  assert.equal(spans[0].text, chunks[1].text + chunks[2].text);
  assert.equal(spans[1].text, chunks[4].text);
});

test('8: vectors lift recall on inflected and misspelled queries without hurting the lexical set', t => {
  const { repo, file } = setup(t);
  const cases = writeEvalProject(repo, 'eval', { distractors: 400 });
  const rank = vector => query => search(repo, { projectKey: 'eval', query, index: { file, vector }, limit: 5 }).map(i => i.id);
  const inflected = cases.filter(c => c.set === 'inflected');
  const lexical = cases.filter(c => c.set === 'lexical');
  const ftsOnly = recallAt(inflected, rank(null));
  const hybrid = recallAt(inflected, rank(ON));
  assert.ok(hybrid.recall > ftsOnly.recall, `hybrid ${hybrid.recall} vs fts ${ftsOnly.recall}`);
  assert.ok(hybrid.recall >= 0.9, JSON.stringify(hybrid.misses));
  assert.ok(recallAt(lexical, rank(ON)).recall >= 0.95);
});

test('above ann_threshold IVF answers close to brute force, keeps new chunks filed, and is robust to duplicates', t => {
  const { repo, file } = setup(t);
  const settings = vectorSettings({ enabled: true, ann_threshold: 50, chunk_chars: 200 });
  const topics = ['billing', 'router', 'deploy', 'parser', 'quota', 'webhook', 'cache', 'schema'];
  commitProject(repo, 'g', { subject: 'pages', trailers: { Kind: 'fixture' } }, view => {
    for (let i = 0; i < 300; i++) {
      view.write(`pages/p${i}.md`, `---\nversion: 1\nseq: 1\n---\nNote ${i} about ${topics[i % 8]} and ${topics[(i * 3) % 8]} with detail ${i * 7}.`);
    }
    // Exact duplicates are what broke a graph index here; IVF files them all under one list.
    for (let i = 0; i < 100; i++) view.write(`pages/dup${i}.md`, '---\nversion: 1\nseq: 1\n---\nThe same boilerplate note about release logistics.');
  });
  const idx = openIndex(file);
  attachVectors(idx, settings);
  syncRef(idx, repo, projectRef('g'));
  const lists = stmt(idx, 'SELECT count(*) AS n FROM centroids WHERE ref = ?').get(projectRef('g')).n;
  assert.equal(lists, Math.round(Math.sqrt(400)));
  assert.equal(stmt(idx, 'SELECT count(*) AS n FROM chunks WHERE list IS NULL').get().n, 0);
  const queries = topics.map(t => `${t} detail`).concat(['deploy the parser', 'quota for webhooks', 'cache schema notes', 'release logistics']);
  assert.ok(annRecall(idx, { ref: projectRef('g'), queries, k: 10 }) >= 0.9);
  assert.ok(vectorSearch(idx, { refs: [projectRef('g')], query: 'billing detail', k: 5 }).length > 0);

  // Rewrite half the pages: their chunks are replaced and filed under the existing centroids.
  commitProject(repo, 'g', { subject: 'rewrite', trailers: { Kind: 'fixture' } }, view => {
    for (let i = 0; i < 300; i += 2) view.write(`pages/p${i}.md`, `---\nversion: 2\nseq: 2\n---\nRewritten note ${i} on ${topics[(i + 1) % 8]}.`);
  });
  syncRef(idx, repo, projectRef('g'));
  assert.equal(stmt(idx, 'SELECT count(*) AS n FROM chunks WHERE list IS NULL').get().n, 0);
  assert.ok(annRecall(idx, { ref: projectRef('g'), queries, k: 10 }) >= 0.9);
});

test('stored vectors follow the settings and are rebuilt after changes made with vectors off', t => {
  const { repo, file } = setup(t);
  writePage(repo, 'demo', { slug: 'a', body: 'Ödeme servisinin zaman aşımı otuz saniye.' });
  const idx = openIndex(file);
  attachVectors(idx, ON);
  syncRef(idx, repo, projectRef('demo'));
  assert.deepEqual(stmt(idx, 'SELECT DISTINCT provider, model, dim FROM chunks').all().map(r => ({ ...r })),
    [{ provider: 'local', model: 'hash-ngram-v1', dim: 256 }]);
  closeIndex(file);

  // A sync without the vector layer leaves chunks behind; the next attach notices and rebuilds.
  writePage(repo, 'demo', { slug: 'b', body: 'Kargo takip bağlantısı yedi gün geçerli.' });
  const plain = openIndex(file);
  syncRef(plain, repo, projectRef('demo'));
  assert.equal(stmt(plain, "SELECT count(*) AS n FROM docs d WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.doc = d.id)").get().n, 1);
  attachVectors(plain, vectorSettings({ enabled: true, dim: 128 }));
  assert.equal(stmt(plain, "SELECT count(*) AS n FROM docs d WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.doc = d.id)").get().n, 0);
  assert.deepEqual(stmt(plain, 'SELECT DISTINCT dim FROM chunks').all().map(r => r.dim), [128]);
});

test('ChunkSplice: the block quotes the part of a long note that matched', t => {
  const { repo, file } = setup(t);
  const filler = Array.from({ length: 30 }, (_, i) => `Background paragraph ${i} on unrelated release logistics.`).join(' ');
  writePage(repo, 'demo', { slug: 'ops', body: `${filler} Kargo takip bağlantıları yedi gün geçerli kalıyor ve sonra siliniyor.` });
  const req = vector => buildPack({ repoDir: repo, project: { key: 'demo' }, sid: 'x', cwd: '', scope: 'repo', indexFile: file, vector,
    task: 'kargonun takip bağlantısı kaç gün geçerli kalıyor', engine: 'vibe', model: 'm', routerConfig: {}, budget: 1200 });
  assert.doesNotMatch(req(null).text, /yedi gün/, 'without vectors the note is quoted from its start');
  assert.match(req(ON).text, /yedi gün geçerli/);
});
