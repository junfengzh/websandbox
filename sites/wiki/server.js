#!/usr/bin/env node
'use strict';
// websandbox wiki (wiki.wa): a Wikipedia/Kiwix-like reader on the websandbox kit over the
// 2022-05 English Wikipedia subset (SCHEMA.md): article pages with infobox, TOC and
// references, redirects, Go/full-text search with did-you-mean, title autocomplete,
// random article, What links here, page information, all pages; WebArena's Kiwix URLs
// redirect to /wiki/<Title>.
// usage: node sites/wiki/server.js --tenants 2 --port 7500 --data $WSB_DATA_ROOT/wiki
// Routes: ROUTES.md. Read-only: shared DB mode (all tenants read base.db through mmap;
// rendered article bodies are cached per process in an LRU, lib/wiki.js).
const kit = require('../../kit');
const W = require('./lib/wiki');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LOCALS = {
  wikiPath: (p) => W.wikiUrl(p).slice(6),               // path part after /wiki/
  longDate: (d) => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || ''); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : d; },
  num: (n) => Number(n).toLocaleString('en-US'),
};

const site = kit.site({
  name: 'wiki',
  title: 'Wikipedia',
  siteIndex: 6,
  dir: __dirname,
  db: { mode: 'shared', file: 'base.db', cacheMB: 16, mmapMB: 4096 },
  clock: { start: '2022-05-01T12:00:00Z' },
  menu: () => [
    { id: 'main', label: 'Main page', href: '/wiki/Main_Page' },
    { id: 'random', label: 'Random article', href: '/wiki/Special:Random' },
    { id: 'allpages', label: 'All pages', href: '/wiki/Special:AllPages' },
    { id: 'special', label: 'Special pages', href: '/wiki/Special:SpecialPages' },
  ],
  skins: {
    default: {},
    dark: { theme: 'dark' },
    compact: { nav: 'top', labels: { 'menu.random': 'Surprise me', 'search.placeholder': 'Search the encyclopedia', 'tools.whatlinkshere': 'Backlinks', 'tools.info': 'About this page' } },
  },
  skinFor: () => 'default',
  locals: () => LOCALS,
  onOpen: (db) => W.warm(db), // did-you-mean vocabulary (once per process, ~0.5 s)
  routes: require('./routes'),
  views: { notFound: 'error', 403: 'error' },
});
module.exports = site;

if (require.main === module) site.main();
