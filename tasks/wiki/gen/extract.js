'use strict';
// Fact extraction from the stored article HTML (the same HTML the site renders):
// infobox rows (label, section header, visible text lines, links, hidden ISO dates) and simple
// wikitables (header + rows of visible cell text, only tables without row/col spans).
// node-html-parser; visible text skips references, display:none spans, styles, noprint.
const { parse } = require('./lib');

const SKIP_CLASS = /(^|\s)(mw-ref|reference|noprint|mw-editsection|sortkey|mw-collapsible-toggle|navbar|plainlinks-print)(\s|$)/;
const BLOCK = new Set(['li', 'div', 'p', 'tr', 'ul', 'ol', 'dl', 'dd', 'dt', 'table', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function hidden(el) {
  if (!el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'style' || tag === 'script' || tag === 'sup' && SKIP_CLASS.test(el.getAttribute('class') || '')) return true;
  const c = el.getAttribute('class') || '';
  if (SKIP_CLASS.test(c)) return true;
  const st = (el.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
  if (st.includes('display:none') || st.includes('visibility:hidden')) return true;
  return false;
}

// visible text with line breaks at <br> and block elements
function vtext(node) {
  let out = '';
  const walk = (n) => {
    if (n.nodeType === 3) { out += n.text; return; }
    if (n.nodeType !== 1) return;
    if (hidden(n)) return;
    const tag = (n.tagName || '').toLowerCase();
    if (tag === 'br') { out += '\n'; return; }
    const blk = BLOCK.has(tag);
    if (blk) out += '\n';
    for (const c of n.childNodes) walk(c);
    if (blk) out += '\n';
    if (tag === 'td' || tag === 'th') out += ' ';
  };
  walk(node);
  return out;
}
const clean1 = (s) => s.replace(/[    ]/g, ' ').replace(/[​‎‏﻿]/g, '').replace(/[ \t]+/g, ' ').trim();
function lines(node) {
  return vtext(node).split('\n').map(clean1).filter((x) => x && x !== '•');
}
const oneLine = (node) => lines(node).join(' ').replace(/\s+/g, ' ').trim();
const linkPath = (href) => {
  if (!href || !href.startsWith('/wiki/')) return null;
  let p = href.slice(6).split('#')[0];
  try { p = decodeURIComponent(p); } catch { /* keep */ }
  return p;
};
function links(node) {
  const out = [];
  for (const a of node.querySelectorAll('a')) {
    if (hidden(a)) continue;
    const p = linkPath(a.getAttribute('href'));
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

// label text: "• Total" -> "Total"; "Alma mater" etc.
const normLabel = (s) => clean1(s.replace(/\s+/g, ' ')).replace(/^[•·\s]+/, '').replace(/\[\d+\]$/, '').trim();

// First infobox of the article: {cls, title, rows: [{h, k, lines, text, links, iso: [...]}]}
function infobox(doc) {
  const ib = doc.querySelector('table.infobox');
  if (!ib) return null;
  const cls = ib.getAttribute('class') || '';
  let h = '';
  const rows = [];
  let above = '';
  // rows of this table only (not nested infoboxes / tables)
  const trs = [];
  const collect = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType !== 1) continue;
      const t = c.tagName.toLowerCase();
      if (t === 'tr') trs.push(c);
      else if (t === 'tbody' || t === 'thead' || t === 'tfoot') collect(c);
    }
  };
  collect(ib);
  for (const tr of trs) {
    const cells = tr.childNodes.filter((c) => c.nodeType === 1 && /^(th|td)$/i.test(c.tagName));
    if (!cells.length) continue;
    const c0 = cells[0];
    const k0 = c0.getAttribute('class') || '';
    if (/infobox-above/.test(k0)) { above = oneLine(c0); continue; }
    if (/infobox-header/.test(k0)) { h = normLabel(oneLine(c0)); continue; }
    if (c0.tagName.toLowerCase() === 'th' && /infobox-label/.test(k0) && cells[1]) {
      const d = cells[1];
      const iso = [];
      for (const s of d.querySelectorAll('span.bday, span.dday, span.published, span.dtstart')) iso.push(clean1(s.text));
      const ls = lines(d);
      rows.push({ h, k: normLabel(oneLine(c0)), lines: ls, text: ls.join(' ').replace(/\s+/g, ' '), links: links(d), iso, bday: (d.querySelector('span.bday') || {}).text || null });
    }
  }
  return { cls, above, rows };
}

// Simple wikitables: [{section, caption, header: [..], rows: [[..]], links: [[path|null]]}]
// Only tables whose header is one row of <th> and whose body rows have exactly that many cells
// and no rowspan/colspan anywhere; cell text one line.
function tables(doc, sectionsOf) {
  const out = [];
  for (const t of doc.querySelectorAll('table.wikitable')) {
    if (t.querySelector('table')) continue; // nested
    if (/\b(rowspan|colspan)=/i.test(t.outerHTML)) continue;
    const trs = t.querySelectorAll('tr');
    if (trs.length < 4) continue;
    const head = trs[0].childNodes.filter((c) => c.nodeType === 1 && /^(th|td)$/i.test(c.tagName));
    if (!head.length || head.some((c) => c.tagName.toLowerCase() !== 'th')) continue;
    const header = head.map((c) => oneLine(c));
    if (header.some((x) => !x) || new Set(header.map((x) => x.toLowerCase())).size !== header.length) continue;
    const rows = []; const lk = [];
    let bad = false;
    for (const tr of trs.slice(1)) {
      const cs = tr.childNodes.filter((c) => c.nodeType === 1 && /^(th|td)$/i.test(c.tagName));
      if (cs.length !== header.length) { bad = true; break; }
      rows.push(cs.map((c) => oneLine(c)));
      lk.push(cs.map((c) => { const l = links(c); return l.length === 1 ? l[0] : null; }));
    }
    if (bad || rows.length < 3) continue;
    const cap = t.querySelector('caption');
    out.push({ section: sectionsOf ? sectionsOf(t) : null, caption: cap ? oneLine(cap) : '', header, rows, links: lk });
  }
  return out;
}

// section (heading text) containing a node: nearest preceding h2..h6 in document order
function sectionFinder(doc) {
  const heads = doc.querySelectorAll('h2, h3, h4, h5, h6');
  return (node) => {
    let best = null;
    const pos = node.range ? node.range[0] : -1; // node-html-parser source offsets
    for (const hd of heads) { if (hd.range && hd.range[0] < pos) best = hd; else break; }
    return best ? { id: best.getAttribute('id'), text: oneLine(best), level: +best.tagName[1] } : null;
  };
}

function parseArticle(html) {
  return parse(html, { comment: false, blockTextElements: { script: false, style: false } });
}

module.exports = { infobox, tables, sectionFinder, parseArticle, lines, oneLine, links, vtext, clean1, linkPath, normLabel };
