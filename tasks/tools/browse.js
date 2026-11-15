#!/usr/bin/env node
'use strict';
// Step-by-step headless Chrome driver for manual task runs ("do the task like a person"),
// operated from the shell one command at a time. Chrome keeps running between invocations;
// each call connects to it through the WebSocket endpoint saved in the state file.
//
//   browse.js start [--port 7280] [--fresh]     launch headless Chrome (own profile, no password bubbles)
//   browse.js goto URL                          navigate (relative URLs resolve against the current page)
//   browse.js snapshot [--all] [--max N]        compact text view; interactive elements numbered [N]
//   browse.js find REGEX                        snapshot lines matching REGEX (also renumbers)
//   browse.js click N                           click element N (waits for a navigation if one starts)
//   browse.js clickm REGEX [--nth K]            click the K-th element whose description matches REGEX
//   browse.js type N "text" [--append] [--enter] clear the field (unless --append) and type
//   browse.js select N VALUE|LABEL              choose an <option>
//   browse.js check N [on|off]                  set a checkbox / radio
//   browse.js upload N FILE                     set a file input
//   browse.js submit [N]                        submit the form containing N (default: the focused element's form)
//   browse.js press KEY                         keyboard key (Enter, Tab, Escape, ...)
//   browse.js back | forward | reload
//   browse.js text [SELECTOR]                   innerText of every match (default body)
//   browse.js attr SELECTOR NAME                attribute of every match
//   browse.js url | title
//   browse.js cookie NAME VALUE [URL]           set a cookie on the current (or given) origin (e.g. from /__rl/login)
//   browse.js screenshot PATH [--full]
//   browse.js eval "JS expression"              evaluate in the page, print JSON (debugging only)
//   browse.js stop                              kill Chrome, remove the state file
//
// Options/env: --state FILE | WSB_BROWSE_STATE (default $WSB_TMP/wsb-browse/<port>.json),
// --port | WSB_BROWSE_PORT (remote-debugging port, default 7280; use one in your site's range),
// --chrome | WSB_CHROME (default /usr/bin/google-chrome), --timeout ms (default 15000).
// Element numbers come from the last `snapshot` of the current page (stored as data-wsb-n
// attributes in the DOM), so take a new snapshot after every navigation. Anywhere an element
// number N is taken, @REGEX also works: the first element whose snapshot description matches
// (e.g. browse.js type @'textarea "Body"' "text"; browse.js click @'button "Save"').
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['all', 'fresh', 'append', 'enter', 'full'].includes(k)) flags[k] = true;
    else flags[k] = argv[++i];
  } else pos.push(a);
}
const PORT = +(flags.port || process.env.WSB_BROWSE_PORT || 7280);
const DIR = path.join((process.env.WSB_TMP || require('os').tmpdir()), 'wsb-browse');
const STATE = flags.state || process.env.WSB_BROWSE_STATE || path.join(DIR, `${PORT}.json`);
const CHROME = flags.chrome || process.env.WSB_CHROME || '/usr/bin/google-chrome';
const TIMEOUT = +(flags.timeout || 15000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error(m); process.exit(1); };

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function start() {
  const st = readState();
  if (st && alive(st.pid)) { console.log(`already running pid ${st.pid} port ${st.port}`); return; }
  fs.mkdirSync(DIR, { recursive: true });
  const profile = st && st.profile && !flags.fresh ? st.profile : fs.mkdtempSync(path.join(DIR, `profile-${PORT}-`));
  // Prefs that keep the password manager (and its invisible "save password?" / leak-detection
  // bubbles, which swallow input in new headless) out of the way.
  const def = path.join(profile, 'Default');
  fs.mkdirSync(def, { recursive: true });
  const prefsFile = path.join(def, 'Preferences');
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch { /* new profile */ }
  prefs.credentials_enable_service = false;
  prefs.credentials_enable_autosignin = false;
  prefs.profile = { ...(prefs.profile || {}), password_manager_enabled: false, password_manager_leak_detection: false };
  prefs.password_manager = { ...(prefs.password_manager || {}), leak_detection: false };
  prefs.autofill = { ...(prefs.autofill || {}), profile_enabled: false, credit_card_enabled: false };
  fs.writeFileSync(prefsFile, JSON.stringify(prefs));
  const args = [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--password-store=basic', '--use-mock-keychain', '--disable-save-password-bubble',
    '--disable-features=PasswordLeakDetection,PasswordManagerOnboarding,PasswordCheck,AutofillServerCommunication,Translate,OptimizationHints,MediaRouter',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-popup-blocking',
    '--window-size=1280,900', 'about:blank',
  ];
  const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  child.unref();
  let ws = null;
  for (let i = 0; i < 100 && !ws; i++) {
    await sleep(100);
    try { ws = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* not yet */ }
  }
  if (!ws) { try { process.kill(child.pid); } catch { /* gone */ } die(`chrome did not open port ${PORT}`); }
  fs.writeFileSync(STATE, JSON.stringify({ pid: child.pid, port: PORT, ws, profile }, null, 1));
  console.log(`started pid ${child.pid} port ${PORT} profile ${profile}`);
}

async function stop() {
  const st = readState();
  if (!st) { console.log('not running'); return; }
  if (alive(st.pid)) {
    try { process.kill(-st.pid, 'SIGTERM'); } catch { try { process.kill(st.pid, 'SIGTERM'); } catch { /* gone */ } }
    for (let i = 0; i < 30 && alive(st.pid); i++) await sleep(100);
    if (alive(st.pid)) try { process.kill(st.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(STATE, { force: true });
  if (st.profile && st.profile.startsWith(DIR)) fs.rmSync(st.profile, { recursive: true, force: true });
  console.log(`stopped pid ${st.pid}`);
}

async function connect() {
  const st = readState();
  if (!st || !alive(st.pid)) die('chrome is not running: browse.js start');
  const browser = await puppeteer.connect({ browserWSEndpoint: st.ws, defaultViewport: { width: 1280, height: 900 } });
  const pages = (await browser.pages()).filter((p) => !p.url().startsWith('devtools://'));
  const page = pages.length ? pages[pages.length - 1] : await browser.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page.on('dialog', (d) => { console.log(`[dialog ${d.type()}] ${d.message()} -> accepted`); d.accept().catch(() => {}); });
  return { browser, page };
}

// Run fn; if it starts a navigation, wait for it to finish.
async function withNav(page, fn) {
  let navigated = false;
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: TIMEOUT }).then(() => { navigated = true; }).catch(() => {});
  await fn();
  // Give a click-triggered navigation a moment to start.
  const started = await Promise.race([nav.then(() => true), sleep(1500).then(() => false)]);
  if (!started) { /* no navigation (JS action); let XHR settle */ await sleep(300); }
  else await nav;
  return navigated;
}

const SNAPSHOT_JS = () => {
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[contenteditable=true],[onclick]';
  document.querySelectorAll('[data-wsb-n]').forEach((e) => e.removeAttribute('data-wsb-n'));
  let n = 0;
  const out = [];
  const descs = [];
  let line = '';
  const flush = () => { const t = line.replace(/\s+/g, ' ').trim(); if (t) out.push(t); line = ''; };
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|THEAD|TFOOT|TR|UL|BR|LEGEND)$/;
  const vis = (el) => (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.offsetParent !== null || el.tagName === 'BODY');
  const clip = (s, k = 80) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > k ? s.slice(0, k - 1) + '…' : s; };
  const labelFor = (el) => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText; }
    const pl = el.closest('label'); if (pl) return pl.innerText;
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
  };
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      return `link "${clip(el.innerText || aria || el.title || (el.querySelector('img') && el.querySelector('img').alt) || '')}" -> ${clip(href, 100)}`;
    }
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return null;
      if (type === 'submit' || type === 'button' || type === 'reset') return `button "${clip(el.value || aria || '')}"`;
      if (type === 'checkbox' || type === 'radio') return `${type}${el.checked ? ' [x]' : ' [ ]'} "${clip(labelFor(el) || el.value)}" name=${el.name}${type === 'radio' ? ' value=' + el.value : ''}`;
      if (type === 'file') return `file-input "${clip(labelFor(el))}" name=${el.name}${el.files && el.files.length ? ' file=' + el.files[0].name : ''}`;
      return `input[${type}] "${clip(labelFor(el))}" name=${el.name} value="${clip(el.value, 120)}"`;
    }
    if (tag === 'textarea') return `textarea "${clip(labelFor(el))}" name=${el.name} value="${clip(el.value, 200)}"`;
    if (tag === 'select') {
      const opts = [...el.options].map((o) => (o.selected ? `*${clip(o.text, 40)}*` : clip(o.text, 40)));
      const shown = opts.length > 30 ? opts.slice(0, 30).concat(`… (${opts.length} options)`) : opts;
      const cur = el.selectedOptions && el.selectedOptions[0];
      return `select "${clip(labelFor(el))}" name=${el.name} selected="${cur ? clip(cur.text, 40) : ''}" [${shown.join(' | ')}]`;
    }
    if (tag === 'summary') return `summary "${clip(el.innerText)}" (${el.parentElement && el.parentElement.open ? 'open' : 'closed'})`;
    const pressed = el.getAttribute('aria-pressed');
    return `button "${clip(el.innerText || aria || el.title || el.value || '')}"${pressed === 'true' ? ' (pressed)' : ''}`;
  };
  const walk = (node) => {
    if (node.nodeType === 3) { line += node.nodeValue; return; }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|HEAD)$/.test(tag)) return;
    if (!vis(el)) return;
    if (tag === 'IMG') { const alt = el.getAttribute('alt'); if (alt) line += ` [img: ${clip(alt, 60)}]`; return; }
    if (el.matches(INTERACTIVE) && !el.matches('label') && !el.disabled) {
      const d = describe(el);
      if (d) { n++; el.setAttribute('data-wsb-n', String(n)); line += ` [${n}] ${d} `; descs.push(d); }
      return;
    }
    const block = BLOCK.test(tag);
    if (block) flush();
    if (/^H[1-6]$/.test(tag)) line += '#'.repeat(+tag[1]) + ' ';
    if (tag === 'LI') line += '- ';
    if (tag === 'TD' || tag === 'TH') line += ' | ';
    for (const c of el.childNodes) walk(c);
    if (block) flush();
  };
  walk(document.body);
  flush();
  return { url: location.href, title: document.title, n, text: out.join('\n'), descs };
};

// N is an element number from the last snapshot, or @REGEX: the first element (fresh
// snapshot) whose description matches REGEX, e.g. @'textarea "Body"', @'button "Save"'.
async function resolveN(page, n) {
  if (!String(n).startsWith('@')) return n;
  const s = await page.evaluate(SNAPSHOT_JS);
  const re = new RegExp(String(n).slice(1), 'i');
  const i = s.descs.findIndex((d) => re.test(d));
  if (i < 0) die(`no element matches /${String(n).slice(1)}/`);
  return i + 1;
}

async function handleFor(page, n) {
  n = await resolveN(page, n);
  const h = await page.$(`[data-wsb-n="${n}"]`);
  if (!h) die(`no element [${n}] on this page (take a new snapshot)`);
  return h;
}

async function main() {
  const cmd = pos[0];
  if (!cmd || cmd === 'help') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 33).join('\n')); return; }
  if (cmd === 'start') return start();
  if (cmd === 'stop') return stop();
  const { browser, page } = await connect();
  try {
    const report = async (extra = '') => console.log(`${extra}url: ${page.url()}\ntitle: ${await page.title()}`);
    switch (cmd) {
      case 'goto': {
        let u = pos[1];
        if (!u) die('goto URL');
        if (!/^[a-z]+:/i.test(u)) u = new URL(u, page.url()).href;
        const r = await page.goto(u, { waitUntil: 'load' });
        await report(`status: ${r ? r.status() : '?'}\n`);
        break;
      }
      case 'snapshot': {
        const s = await page.evaluate(SNAPSHOT_JS);
        const max = flags.all ? Infinity : +(flags.max || 15000);
        const text = s.text.length > max ? s.text.slice(0, max) + `\n… (${s.text.length - max} more chars; --all or --max N)` : s.text;
        console.log(`url: ${s.url}\ntitle: ${s.title}\nelements: ${s.n}\n---\n${text}`);
        break;
      }
      case 'find': {
        // A snapshot (renumbers elements) filtered to the lines matching a regex (case-insensitive).
        const s = await page.evaluate(SNAPSHOT_JS);
        const re = new RegExp(pos[1] || '.', 'i');
        console.log(`url: ${s.url}\n` + s.text.split('\n').filter((l) => re.test(l)).join('\n'));
        break;
      }
      case 'clickm': case 'click': {
        let n = pos[1];
        if (cmd === 'clickm') {
          // click the k-th (default 1st) element whose description matches REGEX, e.g. clickm 'link "New"'
          const s = await page.evaluate(SNAPSHOT_JS);
          const re = new RegExp(pos[1], 'i');
          const hits = s.descs.map((d, i) => [d, i + 1]).filter(([d]) => re.test(d));
          const k = +(flags.nth || 1);
          if (hits.length < k) die(`no element matches /${pos[1]}/ (${hits.length} hits)`);
          n = hits[k - 1][1];
          console.log(`[${n}] ${hits[k - 1][0]}`);
        }
        const h = await handleFor(page, n);
        await h.evaluate((e) => e.scrollIntoView({ block: 'center' }));
        const nav = await withNav(page, () => h.click());
        await report(nav ? 'navigated\n' : '');
        break;
      }
      case 'type': {
        const h = await handleFor(page, pos[1]);
        const text = pos[2] == null ? '' : pos[2];
        if (!flags.append) await h.evaluate((e) => { if ('value' in e) { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); } else e.textContent = ''; });
        await h.focus();
        if (flags.append) await h.evaluate((e) => { if (typeof e.value === 'string' && e.setSelectionRange) { try { e.setSelectionRange(e.value.length, e.value.length); } catch { /* type=email etc. */ } } });
        await page.keyboard.type(text, { delay: 2 });
        if (flags.enter) { const nav = await withNav(page, () => page.keyboard.press('Enter')); await report(nav ? 'navigated\n' : ''); }
        else console.log(`typed ${JSON.stringify(text)} into [${pos[1]}]: value=${JSON.stringify(await h.evaluate((e) => e.value ?? e.textContent))}`);
        break;
      }
      case 'select': {
        const h = await handleFor(page, pos[1]);
        const want = pos[2];
        const v = await h.evaluate((e, w) => {
          const o = [...e.options].find((x) => x.value === w) || [...e.options].find((x) => x.text.trim().toLowerCase() === String(w).toLowerCase());
          if (!o) return null;
          e.value = o.value; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
          return o.value;
        }, want);
        if (v == null) die(`no option ${JSON.stringify(want)} in [${pos[1]}]`);
        console.log(`selected ${JSON.stringify(v)} in [${pos[1]}]`);
        break;
      }
      case 'check': {
        const h = await handleFor(page, pos[1]);
        const on = pos[2] !== 'off';
        const cur = await h.evaluate((e) => e.checked);
        if (cur !== on) await h.click();
        console.log(`[${pos[1]}] checked=${await h.evaluate((e) => e.checked)}`);
        break;
      }
      case 'upload': {
        const h = await handleFor(page, pos[1]);
        await h.uploadFile(path.resolve(pos[2]));
        console.log(`[${pos[1]}] file=${await h.evaluate((e) => e.files[0] && e.files[0].name)}`);
        break;
      }
      case 'submit': {
        const target = pos[1] ? await resolveN(page, pos[1]) : null;
        const nav = await withNav(page, async () => {
          const ok = await page.evaluate((n) => {
            const el = n ? document.querySelector(`[data-wsb-n="${n}"]`) : document.activeElement;
            const f = el && (el.form || el.closest('form'));
            if (!f) return false;
            f.requestSubmit ? f.requestSubmit() : f.submit();
            return true;
          }, target);
          if (!ok) die('no form to submit');
        });
        await report(nav ? 'navigated\n' : '');
        break;
      }
      case 'press': {
        const nav = await withNav(page, () => page.keyboard.press(pos[1] || 'Enter'));
        await report(nav ? 'navigated\n' : '');
        break;
      }
      case 'back': case 'forward': case 'reload': {
        await (cmd === 'back' ? page.goBack({ waitUntil: 'load' }) : cmd === 'forward' ? page.goForward({ waitUntil: 'load' }) : page.reload({ waitUntil: 'load' }));
        await report();
        break;
      }
      case 'text': {
        const t = await page.$$eval(pos[1] || 'body', (els) => els.map((e) => e.innerText));
        console.log(t.join('\n----\n'));
        break;
      }
      case 'attr': {
        const t = await page.$$eval(pos[1], (els, a) => els.map((e) => e.getAttribute(a)), pos[2]);
        console.log(t.join('\n'));
        break;
      }
      case 'url': console.log(page.url()); break;
      case 'title': console.log(await page.title()); break;
      case 'cookie': {
        const u = pos[3] || page.url();
        await page.setCookie({ name: pos[1], value: pos[2], url: u, path: '/', httpOnly: true, sameSite: 'Lax' });
        console.log(`cookie ${pos[1]} set for ${new URL(u).origin}`);
        break;
      }
      case 'screenshot': {
        if (!pos[1]) die('screenshot PATH');
        await page.screenshot({ path: pos[1], fullPage: !!flags.full });
        console.log(`saved ${pos[1]}`);
        break;
      }
      case 'eval': {
        const r = await page.evaluate((src) => { const v = (0, eval)(src); return v instanceof Promise ? v : v; }, pos[1]);
        console.log(JSON.stringify(r, null, 1));
        break;
      }
      default: die(`unknown command ${cmd} (browse.js help)`);
    }
  } finally {
    await browser.disconnect();
  }
}

main().catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
