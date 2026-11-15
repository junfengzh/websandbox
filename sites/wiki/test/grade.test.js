'use strict';
// node --test test/grade.test.js -- wiki grader: URL canonicalisation and section (fragment) checks
const test = require('node:test');
const assert = require('node:assert');
const grade = require('../grade.js');

const urlTask = (url) => ({ eval: { type: 'url', url } });
const pass = async (t, url) => (await grade(t, { url })).pass;

test('canonical URLs: Kiwix, title variants, index.php, rdfrom', () => {
  assert.strictEqual(grade.canonicalUrl('__WIKIPEDIA__/wikipedia_en_all_maxi_2022-05/A/Christopher_Nolan'), 'http://x/wiki/Christopher_Nolan');
  assert.strictEqual(grade.canonicalUrl('http://h/wiki/christopher%20Nolan'), 'http://x/wiki/Christopher_Nolan');
  assert.strictEqual(grade.canonicalUrl('http://h/w/index.php?title=Pittsburgh'), 'http://x/wiki/Pittsburgh');
  assert.strictEqual(grade.canonicalUrl('http://h/wiki/Fred_Rogers?rdfrom=Mr._Rogers'), 'http://x/wiki/Fred_Rogers');
  assert.strictEqual(grade.canonicalUrl('http://h/w/index.php?title=Pittsburgh&action=info'), 'http://x/w/index.php?title=Pittsburgh&action=info');
});

test('article URL checks ignore the fragment; section checks require it', async () => {
  const art = urlTask('__WIKIPEDIA__/wiki/Fred_Rogers');
  assert.strictEqual(await pass(art, 'http://127.10.0.6/wiki/Fred_Rogers?rdfrom=Mr._Rogers'), true);
  assert.strictEqual(await pass(art, 'http://127.10.0.6/wiki/Fred_Rogers#Early_life'), true);
  assert.strictEqual(await pass(art, 'http://127.10.0.6/wiki/Mister_Rogers%27_Neighborhood'), false);
  const sec = urlTask('__WIKIPEDIA__/wiki/Pittsburgh#Regional_identity');
  assert.strictEqual(await pass(sec, 'http://127.10.0.6/wiki/Pittsburgh#Regional_identity'), true);
  assert.strictEqual(await pass(sec, 'http://127.10.0.6/wiki/Pittsburgh#Regional%20identity'), true);
  assert.strictEqual(await pass(sec, 'http://127.10.0.6/wiki/Pittsburgh'), false);
  assert.strictEqual(await pass(sec, 'http://127.10.0.6/wiki/Pittsburgh#Climate'), false);
  assert.strictEqual(await pass(sec, 'http://127.10.0.6/wiki/Boston#Regional_identity'), false);
});

test('answer checks pass through to the kit grader', async () => {
  const t = { eval: { type: 'answer', answer: { numeric: { value: 148, unit: 'min', tol_abs: 1 } } } };
  assert.strictEqual((await grade(t, { answer: '148 minutes' })).pass, true);
  assert.strictEqual((await grade(t, { answer: '2 hours' })).pass, false);
});
