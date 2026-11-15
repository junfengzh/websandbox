'use strict';
// Eval builders (CONVENTIONS.md eval format) shared by the templates.
const { lit, uid, fid, ci, eqci, AFTER } = require('./lib');

// A title used as an answer reference: the page shows the stored title; accept ASCII quotes for
// typographic ones. Titles with entities / markup are rejected by answerTitleOk.
const answerTitleOk = (t) => typeof t === 'string' && /^[\x20-\x7E\u00A0-\u00FF\u2010-\u2027]+$/.test(t) && t.length >= 8 && t.length <= 150 && !/[&<>|]/.test(t) && t === t.trim() && !/\s{2}/.test(t) && /[A-Za-z]{3}/.test(t);
const titleRef = (t) => { const a = t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"'); return a === t ? t : `${t} |OR| ${a}`; };

const answer = (refs, sql, { exact = false } = {}) => ({
  type: 'answer',
  answer: exact ? { exact: refs } : { must_include: [].concat(refs) },
  answer_sql: sql,
});
const state = (sql, expect, extra = {}) => ({ type: 'state', state_sql: sql, state_expect: expect, ...extra });

// The login user's newest submission made during the task (the rollout's own post).
const myNewPost = (me) => `SELECT s.*, f.normalized_name AS fname FROM submissions s JOIN forums f ON f.id = s.forum_id
  WHERE s.user_id = ${uid(me)} AND s.visibility = 'visible' AND s.created_at >= '${AFTER}' ORDER BY s.id DESC LIMIT 1`;
// Visible comments by the login user made during the task.
const myNewComments = (me) => `SELECT * FROM comments WHERE user_id = ${uid(me)} AND visibility = 'visible' AND created_at >= '${AFTER}'`;

module.exports = { answer, state, answerTitleOk, titleRef, myNewPost, myNewComments, lit, uid, fid, ci, eqci, AFTER };
