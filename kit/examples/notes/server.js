#!/usr/bin/env node
'use strict';
// Toy "notes" site on the websandbox kit. Same layout as a real site:
//   server.js (config), routes/ (handlers), views/ (Eta), build/ (base.db), grade.js.
// usage: node kit/examples/notes/server.js --tenants 4 --port 7110 --data $WSB_TMP/notes
const kit = require('../..');

module.exports = kit.site({
  name: 'notes',
  title: 'Notes',
  siteIndex: 9, // 127.10.<i>.9 (not a WebArena site)
  dir: __dirname,
  db: { mode: 'copy', file: 'base.db', cacheMB: 32 },
  clock: { start: '2023-05-01T09:00:00Z' }, // the site's fixed "today"; running clock
  auth: {
    loginPath: '/login',
    findUser: (db, login) => db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login),
    getUser: (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  },
  skins: {
    default: {},
    dark: { theme: 'dark', labels: { 'menu.notes': 'All notes', 'site.title': 'Notebook' } },
    side: { nav: 'side', menuOrder: ['new', 'notes', 'admin'], labels: { 'menu.new': 'Write' } },
  },
  skinFor: (i) => 'default',
  menu: (req) => [
    { id: 'notes', label: 'Notes', href: '/' },
    { id: 'new', label: 'New note', href: '/notes/new' },
    { id: 'admin', label: 'Admin', href: '/admin', role: 'admin' },
  ],
  jobs: require('./routes/jobs'),
  routes: require('./routes'),
});

if (require.main === module) module.exports.main();
