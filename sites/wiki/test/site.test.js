'use strict';
// node --test test/site.test.js   (needs the built data in $WSB_WIKI_DATA or $WSB_DATA_ROOT/wiki)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = process.env.WSB_WIKI_DATA || '$WSB_DATA_ROOT/wiki';
const have = fs.existsSync(path.join(DATA, 'base.db'));
const opt = { skip: !have && 'wiki data not built' };
const site = require('../server.js');
const W = require('../lib/wiki');
let s, base, base1;

const get = async (p, o = {}) => {
  const r = await fetch((o.base || base) + p, { redirect: o.redirect || 'follow', headers: o.headers });
  return { status: r.status, url: r.url, loc: r.headers.get('location'), type: r.headers.get('content-type'), text: await r.text() };
};
const rel = (u) => u.replace(/^https?:\/\/[^/]+/, '');
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

test.before(async () => {
  if (!have) return;
  const tmpRoot = (process.env.WSB_TMP || os.tmpdir());
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'wsb-wiki-test-'));
  s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads: tmp });
  base = s.url(0);
  base1 = s.url(1);
});
test.after(async () => { if (s) await s.close(); });

test('unit: TOC numbering and nesting', () => {
  const h = W.tocHtml([[2, 'A', 'A'], [3, 'A1', 'A one'], [3, 'A2', 'A two'], [2, 'B', 'B'], [4, 'B1', 'deep'], [2, 'C', 'C & D']]);
  assert.match(h, /<span class="tocnumber">1\.2<\/span> <span class="toctext">A two<\/span>/);
  assert.match(h, /<span class="tocnumber">2\.1<\/span> <span class="toctext">deep<\/span>/);
  assert.match(h, /<span class="tocnumber">3<\/span> <span class="toctext">C &amp; D<\/span>/);
  assert.strictEqual((h.match(/<ul>/g) || []).length, (h.match(/<\/ul>/g) || []).length);
  assert.strictEqual(W.tocHtml([[2, 'a', 'a']]), ''); // < 4 headings: no TOC (MediaWiki rule)
  assert.strictEqual(W.wikiUrl("Mister_Rogers'_Neighborhood"), "/wiki/Mister_Rogers'_Neighborhood");
  assert.strictEqual(W.wikiUrl('AC/DC'), '/wiki/AC/DC');
  assert.strictEqual(W.wikiUrl('Washington_&_Jefferson_College'), '/wiki/Washington_%26_Jefferson_College');
  assert.strictEqual(W.norm('Bouvé_Café  x'), 'bouve cafe x');
});

test('article page: lead, infobox first, TOC, sections, references, images, red links, no categories', opt, async () => {
  const r = await get('/wiki/Christopher_Nolan');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /<h1 id="firstHeading" class="firstHeading"><span class="mw-page-title-main">Christopher Nolan<\/span><\/h1>/);
  assert.match(r.text, /<title>Christopher Nolan - Wikipedia<\/title>/);
  const body = r.text.slice(r.text.indexOf('<div class="mw-parser-output">'));
  assert.ok(body.indexOf('<table class="infobox') < body.indexOf('<p>'), 'infobox moved before the lead paragraph');
  assert.ok(body.indexOf('id="toc"') < body.indexOf('<h2 id="Early_life"'), 'TOC before the first section');
  for (const h of ['1993–2003: Early career and breakthrough', '2003–2013: Widespread recognition', '2014–2019: Established Hollywood auteur', '2020–present']) {
    assert.ok(r.text.includes(`<span class="toctext">${h}</span>`), h);
  }
  assert.match(r.text, /<a href="#Filmography"><span class="tocnumber">6<\/span>/);
  assert.match(r.text, /<ol class="mw-references references">/);
  assert.match(r.text, /<li id="cite_note-1">/);
  assert.match(r.text, /href="\/wiki\/Christopher_Nolan_filmography"/);
  assert.match(r.text, /This page was last edited on 26 April 2022 \(revision 1084742452\)/);
  assert.ok(!/id="catlinks"/.test(r.text));
  const img = r.text.match(/<img [^>]*src="(\/media\/[^"]+)"/);
  assert.ok(img, 'an image');
  const im = await fetch(base + img[1]);
  assert.strictEqual(im.status, 200);
  assert.match(im.headers.get('content-type'), /image\//);
  // tools: What links here + Page information
  assert.match(r.text, /<li id="t-whatlinkshere"><a href="\/wiki\/Special:WhatLinksHere\/Christopher_Nolan"/);
  assert.match(r.text, /<li id="t-info"><a href="\/w\/index.php\?title=Christopher_Nolan&amp;action=info"/);
  // red links (articles not in the DB) are plain text
  const red = await get('/wiki/Mackinac_Bridge');
  assert.match(red.text, /<span class="new"[ >]/);
});

test('rendered bodies are cached per process (LRU)', opt, async () => {
  const before = (await (await fetch(base + '/__wiki/stats')).json()).cache;
  await get('/wiki/Turing_Award');
  await get('/wiki/Turing_Award', { base: base1 });
  const after = (await (await fetch(base + '/__wiki/stats')).json()).cache;
  assert.ok(after.hits >= before.hits + 1, JSON.stringify({ before, after }));
});

test('redirects: (Redirected from X), redirect=no, case and space variants', opt, async () => {
  const r = await get('/wiki/Mr._Rogers', { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(rel(r.loc), '/wiki/Fred_Rogers?rdfrom=Mr._Rogers');
  const f = await get('/wiki/Mr._Rogers');
  assert.strictEqual(rel(f.url), '/wiki/Fred_Rogers?rdfrom=Mr._Rogers');
  assert.match(f.text, /\(Redirected from <a href="\/wiki\/Mr\._Rogers\?redirect=no" class="mw-redirect" title="Mr\. Rogers">Mr\. Rogers<\/a>\)/);
  // a forged rdfrom that is not a redirect to this page is ignored
  const forged = await get('/wiki/Fred_Rogers?rdfrom=Christopher_nolan');
  assert.ok(!forged.text.includes('Redirected from'));
  const no = await get('/wiki/Mr._Rogers?redirect=no');
  assert.match(no.text, /Redirect page/);
  assert.match(no.text, /<ul class="redirectText"><li><a href="\/wiki\/Fred_Rogers">Fred Rogers<\/a>/);
  for (const [from, to] of [['/wiki/Christopher%20Nolan', '/wiki/Christopher_Nolan'], ['/wiki/christopher_Nolan', '/wiki/Christopher_Nolan'], ['/', '/wiki/Main_Page'], ['/wiki/', '/wiki/Main_Page']]) {
    const x = await get(from, { redirect: 'manual' });
    assert.ok([301, 302].includes(x.status), from);
    assert.strictEqual(rel(x.loc), to, from);
  }
  // titles with / ' & ( )
  for (const p of ['AC/DC', "Mister_Rogers'_Neighborhood", 'Washington_%26_Jefferson_College', 'The_Chair_(2021_TV_series)']) {
    const x = await get('/wiki/' + p);
    assert.strictEqual(x.status, 200, p);
  }
});

test('WebArena Kiwix URLs redirect to /wiki/', opt, async () => {
  for (const [from, to] of [
    ['/wikipedia_en_all_maxi_2022-05/A/User:The_other_Kiwix_guy/Landing', '/wiki/User:The_other_Kiwix_guy/Landing'],
    ['/wikipedia_en_all_maxi_2022-05/A/Christopher_Nolan', '/wiki/Christopher_Nolan'],
    ['/wikipedia_en_all_maxi_2022-05', '/wiki/User:The_other_Kiwix_guy/Landing'],
    ['/content/wikipedia_en_all_maxi_2022-05/A/Pittsburgh', '/wiki/Pittsburgh'],
  ]) {
    const r = await get(from, { redirect: 'manual' });
    assert.strictEqual(r.status, 301, from);
    assert.strictEqual(rel(r.loc), to, from);
  }
  // the landing page's topic list links to articles
  const l = await get('/wiki/User:The_other_Kiwix_guy/Landing');
  assert.match(l.text, /<a href="\/wiki\/Architecture" title="Architecture">Architecture<\/a>/);
});

test('search: Go to an exact title (case-insensitive, redirects), else results', opt, async () => {
  for (const [q, to] of [['Christopher Nolan', '/wiki/Christopher_Nolan'], ['christopher nolan', '/wiki/Christopher_Nolan'], ['CHRISTOPHER NOLAN', '/wiki/Christopher_Nolan'], ['MIT', '/wiki/Massachusetts_Institute_of_Technology'], ['mackinac bridge', '/wiki/Mackinac_Bridge']]) {
    const r = await get(`/w/index.php?search=${encodeURIComponent(q)}&title=Special%3ASearch&go=Go`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302, q);
    assert.strictEqual(rel(r.loc), to, q);
  }
  // /search?search= and Special:Search?search= behave the same
  assert.strictEqual(rel((await get('/search?search=Pittsburgh', { redirect: 'manual' })).loc), '/wiki/Pittsburgh');
  assert.strictEqual(rel((await get('/wiki/Special:Search?search=Pittsburgh', { redirect: 'manual' })).loc), '/wiki/Pittsburgh');
  // no exact title -> results page
  const r = await get('/w/index.php?search=nolan+inception+dream&title=Special%3ASearch&go=Go');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /<ul class="mw-search-results">/);
  assert.match(r.text, /<span class="searchmatch">/);
});

test('search: full-text results, exact match first, snippets, pagination, limit', opt, async () => {
  const r = await get('/w/index.php?search=Christopher+Nolan&title=Special%3ASearch&fulltext=1');
  const titles = [...r.text.matchAll(/<div class="mw-search-result-heading"><a href="([^"]+)" title="([^"]+)"/g)].map((m) => m[2]);
  assert.strictEqual(titles[0], 'Christopher Nolan');
  assert.strictEqual(titles.length, 20);
  assert.match(r.text, /There is a page named "<a href="\/wiki\/Christopher_Nolan">Christopher Nolan<\/a>"/);
  assert.match(r.text, /Showing results <strong>1<\/strong> – <strong>20<\/strong> of <strong>[\d,]+<\/strong>/);
  const next = r.text.match(/<a href="([^"]+)" class="mw-nextlink"/)[1].replace(/&amp;/g, '&');
  assert.match(next, /offset=20/);
  const p2 = await get(next);
  assert.match(p2.text, /Showing results <strong>21<\/strong> – <strong>40<\/strong>/);
  const t2 = [...p2.text.matchAll(/<div class="mw-search-result-heading"><a href="[^"]+" title="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(!t2.some((x) => titles.includes(x)), 'page 2 does not repeat page 1');
  assert.match(p2.text, /class="mw-prevlink"/);
  const l50 = await get('/w/index.php?search=Christopher+Nolan&title=Special%3ASearch&fulltext=1&limit=50');
  assert.strictEqual((l50.text.match(/class="mw-search-result"/g) || []).length, 50);
  // task-relevant queries
  for (const [q, want] of [['longest bridge western hemisphere', 'Mackinac Bridge'], ['where was mister rogers neighborhood filmed', "Mister Rogers' Neighborhood"], ['turing award', 'Turing Award']]) {
    const x = await get(`/w/index.php?search=${encodeURIComponent(q)}&title=Special%3ASearch&fulltext=1`);
    const top = [...x.text.matchAll(/<div class="mw-search-result-heading"><a href="[^"]+" title="([^"]+)"/g)].slice(0, 3).map((m) => m[1].replace(/&#39;/g, "'"));
    assert.ok(top.includes(want), `${q}: ${top.join(' | ')}`);
  }
  // common words (tiered ranking) still answer
  const common = await get('/w/index.php?search=united+states&title=Special%3ASearch&fulltext=1');
  assert.match(common.text, /title="United States"/);
});

test('search: Kiwix ?pattern= form, did you mean, no results', opt, async () => {
  const k = await get('/search?content=wikipedia_en_all_maxi_2022-05&pattern=mackinac+bridge');
  assert.strictEqual(k.status, 200);
  assert.match(k.text, /<div class="mw-search-result-heading"><a href="\/wiki\/Mackinac_Bridge"/);
  const k2 = await get('/search?content=wikipedia_en_all_maxi_2022-05&pattern=bridge&start=25&pageLength=10');
  assert.match(k2.text, /Showing results <strong>26<\/strong> – <strong>35<\/strong>/);
  const d = await get('/w/index.php?search=christophr+nolan&title=Special%3ASearch&fulltext=1');
  assert.match(d.text, /Showing results for <a [^>]+><em>christopher nolan<\/em><\/a>\. No results found for/);
  assert.match(d.text, /title="Christopher Nolan"/);
  const orig = d.text.match(/<a href="([^"]+)" class="mw-search-orig"/)[1].replace(/&amp;/g, '&');
  assert.match((await get(orig)).text, /There were no results matching the query/);
  const n = await get('/w/index.php?search=zzqxwvjj&title=Special%3ASearch&fulltext=1');
  assert.match(n.text, /There were no results matching the query/);
  const empty = await get('/wiki/Special:Search');
  assert.strictEqual(empty.status, 200);
});

test('autocomplete: OpenSearch, REST title search, Kiwix /suggest', opt, async () => {
  const o = await (await fetch(base + '/w/api.php?action=opensearch&search=christopher+no&limit=5')).json();
  assert.strictEqual(o[0], 'christopher no');
  assert.strictEqual(o[1][0], 'Christopher Nolan');
  assert.match(o[3][0], /\/wiki\/Christopher_Nolan$/);
  const short = await (await fetch(base + '/w/api.php?action=opensearch&search=mi')).json(); // 1-3 chars: suggest_top
  assert.ok(short[1].length >= 5);
  const rest = await (await fetch(base + '/w/rest.php/v1/search/title?q=mackinac&limit=5')).json();
  assert.ok(rest.pages.some((p) => p.key === 'Mackinac_Bridge'), JSON.stringify(rest.pages.map((p) => p.key)));
  const k = await (await fetch(base + '/suggest?content=wikipedia_en_all_maxi_2022-05&term=turing')).json();
  assert.ok(k.some((x) => x.value === 'Turing Award' || x.value === 'Alan Turing'));
  const bad = await fetch(base + '/w/api.php?action=query');
  assert.strictEqual(bad.status, 400);
});

test('random article', opt, async () => {
  for (const p of ['/wiki/Special:Random', '/random?content=wikipedia_en_all_maxi_2022-05']) {
    const r = await get(p, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.match(rel(r.loc), /^\/wiki\/./);
    const a = await get(rel(r.loc));
    assert.strictEqual(a.status, 200);
    assert.match(a.text, /id="firstHeading"/);
  }
});

test('What links here: count, paging by page id, redirects, filters', opt, async () => {
  const r = await get('/wiki/Special:WhatLinksHere/Christopher_Nolan');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /<h1 id="firstHeading" class="firstHeading">Pages that link to &quot;Christopher Nolan&quot;<\/h1>/);
  const total = +r.text.match(/<strong>([\d,]+)<\/strong> articles on this wiki link here/)[1].replace(/,/g, '');
  const viaQuery = (await (await fetch(base + '/__rl/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: "SELECT count(*) n FROM link WHERE dst = (SELECT id FROM article WHERE path = 'Christopher_Nolan')" }) })).json()).rows[0].n;
  assert.strictEqual(total, viaQuery);
  const list = [...r.text.matchAll(/<ul id="mw-whatlinkshere-list">([\s\S]*?)<\/ul>/g)][0][1];
  assert.strictEqual((list.match(/<li>/g) || []).length, 50);
  assert.match(list, /title="Inception"/);
  assert.match(r.text, /<ul id="mw-whatlinkshere-redirects">[\s\S]*Christopher nolan<\/a> \(redirect page\)/);
  const next = r.text.match(/<a href="([^"]+)" rel="next">next 50<\/a>/)[1].replace(/&amp;/g, '&');
  assert.match(next, /from=\d+/);
  const p2 = await get(next);
  const l2 = p2.text.match(/<ul id="mw-whatlinkshere-list">([\s\S]*?)<\/ul>/)[1];
  assert.ok(!l2.includes('title="Inception"') || !list.includes('title="Inception"'));
  const prev = p2.text.match(/<a href="([^"]+)" rel="prev">previous 50<\/a>/)[1].replace(/&amp;/g, '&');
  const back = await get(prev);
  assert.strictEqual(back.text.match(/<ul id="mw-whatlinkshere-list">([\s\S]*?)<\/ul>/)[1], list);
  // filters and the form/target= variant; a redirect target resolves to its article
  const hl = await get('/wiki/Special:WhatLinksHere/Christopher_Nolan?hidelinks=1');
  assert.ok(!hl.text.includes('id="mw-whatlinkshere-list"'));
  assert.match(hl.text, /id="mw-whatlinkshere-redirects"/);
  const tq = await get('/wiki/Special:WhatLinksHere?target=Christopher+nolan&limit=20');
  assert.match(tq.text, /is a redirect to <a href="\/wiki\/Christopher_Nolan">/);
  assert.strictEqual((tq.text.match(/<ul id="mw-whatlinkshere-list">([\s\S]*?)<\/ul>/)[1].match(/<li>/g) || []).length, 20);
  const missing = await get('/wiki/Special:WhatLinksHere/No_such_page_zzq');
  assert.strictEqual(missing.status, 404);
});

test('page information', opt, async () => {
  const r = await get('/w/index.php?title=Christopher_Nolan&action=info');
  assert.strictEqual(r.status, 200);
  const t = text(r.text);
  assert.match(t, /Page ID 36 /);
  assert.match(t, /Date of latest edit 26 April 2022/);
  assert.match(t, /Revision ID 1084742452/);
  assert.match(t, /Number of sections 15 /);
  assert.match(t, /Number of incoming links on the full 2022 English Wikipedia 1,425/);
  assert.strictEqual((await get('/wiki/Special:PageInfo/Christopher_Nolan')).status, 200);
  assert.strictEqual((await get('/w/index.php?title=No_such_zzq&action=info')).status, 404);
});

test('all pages, special pages, missing pages, unknown special pages', opt, async () => {
  const a = await get('/wiki/Special:AllPages?from=Mackinac');
  assert.match(a.text, /<a href="\/wiki\/Mackinac_Bridge">Mackinac Bridge<\/a>/);
  assert.match(a.text, /rel="next">Next page<\/a>/);
  assert.strictEqual((await get('/wiki/Special:SpecialPages')).status, 200);
  const m = await get('/wiki/No_such_article_zzq');
  assert.strictEqual(m.status, 404);
  assert.match(m.text, /does not have an article with this exact name/);
  assert.strictEqual((await get('/wiki/Special:Nope')).status, 404);
  assert.strictEqual((await get('/w/index.php?title=Christopher+Nolan', { redirect: 'manual' })).loc.endsWith('/wiki/Christopher_Nolan'), true);
});

test('tenants: both serve, reset and control API work (shared read-only DB)', opt, async () => {
  const r1 = await get('/wiki/Pittsburgh', { base: base1 });
  assert.strictEqual(r1.status, 200);
  const h = await (await fetch(base1 + '/__rl/health')).json();
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.tenant, 1);
  const rs = await (await fetch(base + '/__rl/reset', { method: 'POST' })).json();
  assert.strictEqual(rs.ok, true);
  const q = await (await fetch(base + '/__rl/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: 'SELECT count(*) n FROM article' }) })).json();
  assert.ok(q.rows[0].n > 100000);
  assert.strictEqual((await get('/wiki/Pittsburgh')).status, 200);
});
