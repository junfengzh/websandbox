'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NOTES = path.join(__dirname, '..', 'examples', 'notes');

function tmpdir(prefix = 'wsb-kit-test-') {
  const root = (process.env.WSB_TMP || os.tmpdir());
  return fs.mkdtempSync(path.join(root, prefix));
}

// Build the toy DB once per test file.
function buildNotes(notes = 600) {
  const dir = tmpdir();
  execFileSync(process.execPath, [path.join(NOTES, 'build', 'build.js'), '--out', dir, '--notes', String(notes), '--words', '40', '--users', '20']);
  return dir;
}

async function startNotes(dir, opts = {}) {
  // fresh module instance per server so tests don't share runtime state
  delete require.cache[require.resolve(path.join(NOTES, 'server.js'))];
  const site = require(path.join(NOTES, 'server.js'));
  return site.start({ tenants: 2, port: 0, data: dir, bind: 'ports', uploads: path.join(dir, 'uploads'), jobTickMs: 50, ...opts });
}

// Minimal browser-ish client: cookie jar, CSRF scraping, no redirects followed.
class Client {
  constructor(base) { this.base = base; this.jar = new Map(); }
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, p, { form, json, headers = {}, body } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = this.cookie();
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const r = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i); const v = kv.slice(i + 1);
      if (!v || /expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    const text = await r.text();
    return { status: r.status, text, location: r.headers.get('location'), json: () => JSON.parse(text), headers: r.headers };
  }
  get(p, o) { return this.req('GET', p, o); }
  post(p, o) { return this.req('POST', p, o); }
  async csrf(p = '/') {
    const r = await this.get(p);
    const m = /name="csrf-token" content="([^"]+)"/.exec(r.text);
    return m && m[1];
  }
  async login(user, password = 'Password.123') {
    const _csrf = await this.csrf('/login');
    const r = await this.post('/login', { form: { login: user, password, _csrf } });
    if (r.status !== 302) throw new Error(`login failed: ${r.status}`);
    return r;
  }
  async createNote(fields) {
    const _csrf = await this.csrf('/notes/new');
    return this.post('/notes', { form: { tag: 'personal', ...fields, _csrf } });
  }
}

const rl = (base, p, body, method = body === undefined ? 'GET' : 'POST') =>
  fetch(base + '/__rl' + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const q = async (base, sql) => (await rl(base, '/query', { sql })).rows;

module.exports = { tmpdir, buildNotes, startNotes, Client, rl, q, NOTES };
