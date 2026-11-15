'use strict';
// Wikipedia-like URL scheme (ROUTES.md). Everything is read-only, so all routes are `raw`
// (no tenant lock, session or savepoint); statements run on the request tenant's
// read-only connection (req.tenant.sql).
const W = require('../lib/wiki');
const { search } = require('../lib/search');

const raw = { config: { raw: true } };
const LIMITS = [20, 50, 100, 250, 500];
const intParam = (v, def, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const one = (v) => (Array.isArray(v) ? v[0] : v);

module.exports = async function routes(app, kit) {
  const T = (req) => req.tenant;

  // ------------------------------------------------------------ articles
  async function article(req, reply, p) {
    const t = T(req);
    if (!p) return reply.redirect(W.wikiUrl(W.MAIN_PAGE));
    const canon = W.toPath(p);
    if (canon !== p) return reply.redirect(W.wikiUrl(canon) + qsTail(req), 301);
    const special = /^Special:(.*)$/i.exec(p);
    if (special) return specialPage(req, reply, special[1]);
    const r = W.resolve(t, p);
    if (!r || !r.article) {
      const near = W.suggest(t, p.replace(/_/g, ' '), 8);
      return reply.render('missing', { title: p.replace(/_/g, ' '), path: p, near }, 404);
    }
    if (r.redirect) {
      if (one(req.query.redirect) === 'no') return reply.render('redirect', { title: r.redirect.title, r: r.redirect, a: r.article });
      return reply.redirect(W.wikiUrl(r.article.path) + '?' + qs({ rdfrom: r.redirect.path }));
    }
    if (r.alias) return reply.redirect(W.wikiUrl(r.article.path) + qsTail(req), 301);
    const a = r.article;
    let rdfrom = null;
    if (req.query.rdfrom) {
      const rd = W.redirectOf(t, W.toPath(one(req.query.rdfrom)));
      if (rd && rd.target === a.id) rdfrom = rd;
    }
    const b = W.body(t, a);
    return reply.render('article', { title: a.title, a, html: b.html, rdfrom, isMain: a.path === W.MAIN_PAGE, pageTools: true, footerEdit: true, canonical: W.wikiUrl(a.path) });
  }
  const qsTail = (req) => { const i = req.url.indexOf('?'); return i < 0 ? '' : req.url.slice(i); };

  app.get('/', raw, async (req, reply) => reply.redirect(W.wikiUrl(W.MAIN_PAGE)));
  app.get('/wiki', raw, async (req, reply) => reply.redirect(W.wikiUrl(W.MAIN_PAGE)));
  app.get('/wiki/*', raw, async (req, reply) => article(req, reply, req.params['*']));

  // /w/index.php: title= (view, action=info), search= (Go / full text)
  app.get('/w/index.php', raw, async (req, reply) => {
    const title = one(req.query.title);
    if (req.query.search != null || (title && /^Special:Search$/i.test(title))) return searchPage(req, reply);
    if (!title) return reply.redirect(W.wikiUrl(W.MAIN_PAGE));
    const p = W.toPath(title);
    const action = one(req.query.action);
    if (action === 'info') return infoPage(req, reply, p);
    if (/^Special:/i.test(p)) return specialPage(req, reply, p.slice(8));
    const extra = req.query.redirect === 'no' ? '?redirect=no' : '';
    return reply.redirect(W.wikiUrl(p) + extra);
  });

  // ------------------------------------------------------------ special pages
  function specialPage(req, reply, name) {
    const [page, ...rest] = name.split('/');
    const sub = rest.join('/');
    switch (page.toLowerCase()) {
      case 'random': case 'randompage': return reply.redirect(W.wikiUrl(W.random(T(req)).path));
      case 'search': return searchPage(req, reply, sub);
      case 'whatlinkshere': return whatLinksHere(req, reply, sub || one(req.query.target) || '');
      case 'pageinfo': return infoPage(req, reply, W.toPath(sub || one(req.query.page) || ''));
      case 'allpages': return allPages(req, reply, sub || one(req.query.from) || '');
      case 'specialpages': return reply.render('specialpages', { title: 'Special pages' });
      default: return reply.render('error', { status: 404, title: 'No such special page', message: `"Special:${page}" is not a special page on this wiki. See Special:SpecialPages.` }, 404);
    }
  }

  // ------------------------------------------------------------ search
  function searchPage(req, reply, sub) {
    const t = T(req);
    const q = String(one(req.query.search) ?? one(req.query.pattern) ?? (sub || '').replace(/_/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 300);
    const kiwix = req.query.pattern != null;
    const fulltext = kiwix || req.query.fulltext != null;
    if (!q) return reply.render('search', { title: 'Search', q: '', res: null });
    if (!fulltext) {
      const a = W.exactMatch(t, q);
      if (a) return reply.redirect(W.wikiUrl(a.path));
    }
    const limit = kiwix ? intParam(req.query.pageLength, 25, 1, 500) : intParam(req.query.limit, 20, 1, 500);
    const offset = kiwix ? intParam(req.query.start, 0, 0, 10000) : intParam(req.query.offset, 0, 0, 10000);
    let res = search(t, q, { offset, limit });
    let alt = null, rewritten = null;
    {
      alt = W.didYouMean(t, q);
      if (alt && !res.total && req.query.nodym == null) {
        const r2 = search(t, alt, { offset, limit });
        if (r2.total) { rewritten = alt; res = r2; }
      }
    }
    const base = { search: rewritten || q, title: 'Special:Search', profile: 'default', fulltext: 1 };
    const link = (o) => '/w/index.php?' + qs({ ...base, limit: limit === 20 ? null : limit, ...o });
    const pager = {
      from: res.results.length ? offset + 1 : 0, to: offset + res.results.length, limit, offset,
      prev: offset > 0 ? link({ offset: Math.max(0, offset - limit) || null }) : null,
      next: offset + limit < res.shown ? link({ offset: offset + limit }) : null,
      sizes: LIMITS.map((n) => ({ n, href: '/w/index.php?' + qs({ ...base, limit: n, offset: offset || null }), current: n === limit })),
    };
    return reply.render('search', { title: `${q} - Search results`, searchValue: q, q, res, alt, rewritten, pager, fulltextHref: '/w/index.php?' + qs({ search: q, title: 'Special:Search', fulltext: 1 }), origHref: '/w/index.php?' + qs({ search: q, title: 'Special:Search', fulltext: 1, nodym: 1 }) });
  }
  app.get('/search', raw, async (req, reply) => searchPage(req, reply)); // ?search= (Wikipedia) | ?pattern=&content=&start=&pageLength= (Kiwix)

  // title autocomplete: OpenSearch (what Wikipedia's search box uses), REST title search, Kiwix /suggest
  const sugg = (req, q, n) => W.suggest(T(req), String(q || '').slice(0, 200), n);
  app.get('/w/api.php', raw, async (req, reply) => {
    const action = one(req.query.action);
    if (action !== 'opensearch') return reply.code(400).send({ error: { code: 'badvalue', info: 'Only action=opensearch is supported.' } });
    const q = String(one(req.query.search) || '');
    const s = sugg(req, q, intParam(req.query.limit, 10, 1, 20));
    const host = `http://${req.headers.host || 'wiki.wa'}`;
    return [q, s.map((x) => x.title), s.map(() => ''), s.map((x) => host + W.wikiUrl(x.article.path))];
  });
  app.get('/w/rest.php/v1/search/title', raw, async (req, reply) => {
    const s = sugg(req, one(req.query.q), intParam(req.query.limit, 10, 1, 20));
    return { pages: s.map((x) => ({ id: x.article.id, key: x.article.path, title: x.title, matched_title: x.title !== x.article.title ? x.title : null, display_title: x.article.title, description: null, thumbnail: x.article.image ? { url: x.article.image } : null })) };
  });
  app.get('/suggest', raw, async (req, reply) => {
    const s = sugg(req, one(req.query.term), intParam(req.query.count, 10, 1, 20));
    return s.map((x) => ({ value: x.title, label: x.title, kind: 'path', path: 'A/' + x.article.path }));
  });

  // ------------------------------------------------------------ what links here
  function whatLinksHere(req, reply, target) {
    const t = T(req);
    const p = W.toPath(target);
    if (!p) return reply.render('whatlinkshere', { title: 'Pages that link to …', target: '', a: null });
    const r = W.resolve(t, p);
    if (!r || !r.article) return reply.render('whatlinkshere', { title: `Pages that link to "${p.replace(/_/g, ' ')}"`, target: p, a: null, missing: true }, 404);
    const a = r.article;
    const limit = intParam(req.query.limit, 50, 1, 5000);
    const from = intParam(req.query.from, 0, 0, 1e12);
    const back = intParam(req.query.back, 0, 0, 1e12);
    const hidelinks = req.query.hidelinks === '1', hideredirs = req.query.hideredirs === '1';
    let links = [];
    let next = null, prev = null;
    const total = t.sql('SELECT count(*) FROM link WHERE dst = ?').pluck().get(a.id);
    if (!hidelinks) {
      if (back && !from) {
        links = t.sql('SELECT a.id, a.path, a.title FROM link l JOIN article a ON a.id = l.src WHERE l.dst = ? AND l.src < ? ORDER BY l.src DESC LIMIT ?').all(a.id, back, limit + 1);
        const more = links.length > limit;
        links = links.slice(0, limit).reverse();
        if (more) prev = links[0].id;
        next = back;
      } else {
        links = t.sql('SELECT a.id, a.path, a.title FROM link l JOIN article a ON a.id = l.src WHERE l.dst = ? AND l.src >= ? ORDER BY l.src LIMIT ?').all(a.id, from, limit + 1);
        if (links.length > limit) next = links.pop().id;
        if (from && links.length) prev = links[0].id;
      }
    }
    const nRedirects = t.sql('SELECT count(*) FROM redirect WHERE target = ?').pluck().get(a.id);
    const redirects = !hideredirs && !from && !back ? t.sql('SELECT path, title FROM redirect WHERE target = ? ORDER BY path LIMIT ?').all(a.id, limit) : [];
    const self = W.wikiUrl('Special:WhatLinksHere/' + a.path);
    const link = (o) => { const s = qs({ limit: limit === 50 ? null : limit, hidelinks: hidelinks ? 1 : null, hideredirs: hideredirs ? 1 : null, ...o }); return self + (s ? '?' + s : ''); };
    return reply.render('whatlinkshere', {
      title: `Pages that link to "${a.title}"`, target: a.path, a, via: r.redirect || null, links, redirects, nRedirects, total, limit, hidelinks, hideredirs,
      nextHref: next ? link({ from: next }) : null, prevHref: prev ? link({ back: prev }) : (from || back ? link({}) : null),
      sizes: LIMITS.map((n) => ({ n, href: self + '?' + qs({ limit: n, hidelinks: hidelinks ? 1 : null, hideredirs: hideredirs ? 1 : null }), current: n === limit })),
      toggle: (k) => link({ [k]: (k === 'hidelinks' ? hidelinks : hideredirs) ? null : 1 }),
      pageTools: true,
    });
  }

  // ------------------------------------------------------------ page information
  function infoPage(req, reply, p) {
    const t = T(req);
    const r = p ? W.resolve(t, p) : null;
    if (!r || !r.article) return reply.render('missing', { title: p.replace(/_/g, ' '), path: p, near: [] }, 404);
    const a = r.article;
    const b = W.body(t, a);
    const out = W.outgoing(b.html);
    const sections = a.sections ? JSON.parse(a.sections) : [];
    const info = {
      linksHere: t.sql('SELECT count(*) FROM link WHERE dst = ?').pluck().get(a.id),
      redirects: t.sql('SELECT count(*) FROM redirect WHERE target = ?').pluck().get(a.id),
      sections: sections.length, out,
    };
    return reply.render('info', { title: `Information for "${a.title}"`, a, info, pageTools: true });
  }

  // ------------------------------------------------------------ all pages
  function allPages(req, reply, from) {
    const t = T(req);
    const f = W.toPath(from);
    const rows = t.sql('SELECT path, title FROM article WHERE path >= ? ORDER BY path LIMIT 346').all(f);
    const next = rows.length > 345 ? rows.pop().path : null;
    const prevRows = f ? t.sql('SELECT path FROM article WHERE path < ? ORDER BY path DESC LIMIT 345').pluck().all(f) : [];
    return reply.render('allpages', { title: 'All pages', from: f.replace(/_/g, ' '), rows,
      nextHref: next ? W.wikiUrl('Special:AllPages') + '?' + qs({ from: next }) : null,
      prevHref: prevRows.length ? W.wikiUrl('Special:AllPages') + '?' + qs({ from: prevRows[prevRows.length - 1] }) : null });
  }

  // ------------------------------------------------------------ Kiwix URL forms (WebArena start URLs)
  for (const pre of [`/${W.KIWIX_BOOK}`, `/content/${W.KIWIX_BOOK}`]) {
    app.get(pre, raw, async (req, reply) => reply.redirect(W.wikiUrl(W.KIWIX_LANDING), 301));
    app.get(pre + '/A/*', raw, async (req, reply) => reply.redirect(W.wikiUrl(W.toPath(req.params['*']) || W.KIWIX_LANDING), 301));
    app.get(pre + '/*', raw, async (req, reply) => {
      const rest = req.params['*'];
      if (/^(I|-|M)\//.test(rest)) throw kit.httpError(404, 'Not found');
      return reply.redirect(W.wikiUrl(W.toPath(rest) || W.KIWIX_LANDING), 301);
    });
  }
  app.get('/random', raw, async (req, reply) => reply.redirect(W.wikiUrl(W.random(T(req)).path)));
  app.get('/favicon.ico', raw, async (req, reply) => reply.redirect('/static/favicon.svg', 301));
  app.get('/robots.txt', raw, async (req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  app.get('/__wiki/stats', raw, async () => ({ cache: W.cache.stats(), rssMB: Math.round(process.memoryUsage().rss / 2 ** 20) }));
};
