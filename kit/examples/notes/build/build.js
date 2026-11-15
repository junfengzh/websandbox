#!/usr/bin/env node
'use strict';
// Build the toy notes site's base.db with deterministic synthetic data.
// usage: node build/build.js --out DIR [--notes 2000] [--words 60]
const path = require('node:path');
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const kit = require('../../..');

const { values: a } = parseArgs({ options: { out: { type: 'string' }, notes: { type: 'string', default: '2000' }, words: { type: 'string', default: '60' }, users: { type: 'string', default: '50' } } });
if (!a.out) { console.error('usage: build.js --out DIR [--notes N] [--words W]'); process.exit(2); }

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const SYL = ['ka', 'lo', 'mi', 'ra', 'ten', 'sol', 'vex', 'dor', 'pi', 'qua', 'zen', 'bru', 'fal', 'gri', 'hon', 'jun', 'mar', 'nel', 'oro', 'tus'];
const REAL = ['quick', 'brown', 'fox', 'zebra', 'garden', 'recipe', 'travel', 'budget', 'meeting', 'project', 'python', 'javascript', 'database', 'coffee', 'mountain', 'river', 'music', 'guitar', 'piano', 'painting', 'running', 'bicycle', 'invoice', 'holiday', 'birthday', 'kitchen', 'window', 'yellow', 'purple', 'ocean'];
const VOCAB = [...REAL];
while (VOCAB.length < 3000) VOCAB.push(pick(SYL) + pick(SYL) + (rnd() < 0.5 ? pick(SYL) : ''));
const TAGS = ['work', 'personal', 'ideas', 'travel', 'food', 'music', 'tech', 'finance'];
const words = (n) => Array.from({ length: n }, () => pick(VOCAB)).join(' ');

fs.mkdirSync(a.out, { recursive: true });
const file = path.join(a.out, 'base.db');
const db = kit.build.open(file);
db.exec(`
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, body TEXT NOT NULL,
  tag TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', likes INTEGER NOT NULL DEFAULT 0, attachment TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT);
CREATE INDEX notes_user ON notes(user_id, created_at);
CREATE INDEX notes_created ON notes(created_at);
CREATE INDEX notes_tag ON notes(tag, created_at);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='notes', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); END;
CREATE TRIGGER notes_au AFTER UPDATE OF title, body ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
CREATE TABLE synonyms (term TEXT NOT NULL, synonym TEXT NOT NULL, PRIMARY KEY (term, synonym)) WITHOUT ROWID;
`);
const names = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy'];
const insU = db.prepare('INSERT INTO users (username, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)');
const pw = kit.auth.hashPassword('Password.123');
for (let i = 0; i < +a.users; i++) {
  const u = i < names.length ? names[i] : `user${i}`;
  insU.run(u, `${u}@example.com`, u[0].toUpperCase() + u.slice(1), pw, i === 0 ? 'admin' : 'user');
}
const insN = db.prepare('INSERT INTO notes (user_id, title, body, tag, status, likes, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const t0 = Date.parse('2023-01-01T00:00:00Z');
const N = +a.notes;
db.transaction(() => {
  for (let i = 0; i < N; i++) {
    const ts = kit.sqlTime(t0 + Math.floor((i / N) * 120 * 86400e3) + Math.floor(rnd() * 3600e3));
    const st = rnd() < 0.7 ? 'published' : 'draft';
    insN.run(1 + Math.floor(rnd() ** 2 * +a.users), words(2 + Math.floor(rnd() * 4)), words(+a.words), pick(TAGS), st, Math.floor(rnd() * 50), ts, ts, st === 'published' ? ts : null);
  }
})();
const syn = db.prepare('INSERT INTO synonyms VALUES (?, ?)');
for (const [t, s] of [['bike', 'bicycle'], ['bicycle', 'bike'], ['cafe', 'coffee'], ['sea', 'ocean'], ['ocean', 'sea'], ['js', 'javascript']]) syn.run(t, s);
kit.build.finalize(db, { fts: ['notes_fts'] });
console.log(`built ${file}: ${N} notes, ${(fs.statSync(file).size / 2 ** 20).toFixed(1)} MB`);
