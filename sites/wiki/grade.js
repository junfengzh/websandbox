'use strict';
// Wiki grader: the kit grader with wiki URL canonicalisation and section (fragment) checks.
//   grade(task, {answer, url, query, fuzzy}) -> {pass, score, checks}
//   grade.canonicalUrl(u)   '/wikipedia_en_all_maxi_2022-05/A/Foo bar' -> '/wiki/Foo_bar',
//                           '/w/index.php?title=Foo' -> '/wiki/Foo', '?rdfrom=' dropped
// Section checks: a reference URL with a fragment ('/wiki/Pittsburgh#Climate') also requires
// the final URL's fragment to name that section (decoded; spaces = underscores; case-sensitive
// like MediaWiki anchors). Without a fragment in the reference, the final fragment is ignored.
const kit = require('../../kit');

const toPath = (t) => String(t || '').trim().replace(/[\s_]+/g, '_').replace(/^_+|_+$/g, '');
const ucfirst = (p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p);
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

function parts(u) {
  const s = String(u || '').trim().replace(/^__[A-Z_]+__/, 'http://x');
  let url;
  try { url = new URL(s, 'http://x'); } catch { return null; }
  let p = dec(url.pathname).replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const sp = new URLSearchParams(url.search);
  let m;
  if ((m = /^\/(?:content\/)?wikipedia_en_all_maxi_2022-05\/A\/(.+)$/.exec(p))) p = '/wiki/' + m[1];
  if (p === '/w/index.php' && sp.get('title') && !sp.get('action') && !sp.get('search')) { p = '/wiki/' + sp.get('title'); sp.delete('title'); }
  if ((m = /^\/wiki\/(.+)$/.exec(p))) p = '/wiki/' + ucfirst(toPath(m[1]));
  sp.delete('rdfrom');
  const frag = url.hash ? toPath(dec(url.hash.slice(1))) : '';
  return { path: p, qs: sp.toString(), frag };
}
function canonicalUrl(u) {
  const x = parts(u);
  if (!x) return String(u || '');
  return `http://x${x.path}${x.qs ? '?' + x.qs : ''}`;
}

async function grade(task, input = {}) {
  const ev = task.eval || task;
  if (!ev.url) return kit.grader.grade(task, input);
  const refs = [].concat(ev.url);
  const got = input.url ? parts(input.url) : null;
  // references whose fragment (if any) the final URL satisfies; others cannot match
  const usable = refs.filter((r) => { const x = parts(r); return x && (!x.frag || (got && got.frag === x.frag)); });
  const canon = { ...ev, url: usable.length ? usable.map(canonicalUrl) : ['http://x/__no_such_page__'] };
  const t = task.eval ? { ...task, eval: canon } : canon;
  const r = await kit.grader.grade(t, { ...input, url: input.url ? canonicalUrl(input.url) : input.url });
  for (const c of r.checks) if (c.type === 'url') { c.got = input.url; c.reference = refs; }
  return r;
}

module.exports = grade;
module.exports.grade = grade;
module.exports.canonicalUrl = canonicalUrl;
module.exports.urlParts = parts;
