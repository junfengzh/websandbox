'use strict';
// Site grader: the kit grader plus any site-specific normalisation (none for the toy).
// grade(task, {answer, url, query, fuzzy}) -> {pass, score, checks}
const kit = require('../..');
module.exports = (task, input) => kit.grader.grade(task, input);
