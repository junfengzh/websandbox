'use strict';
// Private messages: find the right recipient through the listings, then compose.
const L = require('./lib');
const { state, uid, lit } = require('./evals');

const ORDER = { 'highest-scoring': 'net_score DESC, id DESC', 'most commented': 'comment_count DESC, id DESC', newest: 'id DESC' };
const KEY = { 'highest-scoring': 'net_score', 'most commented': 'comment_count', newest: 'id' };

module.exports = [
  {
    name: 'message-post-author', kind: 'write', skills: ['filter-sort', 'multi-step', 'create'], difficulty: 2,
    phrasings: [
      'Send a private message to the author of the {{which}} post in /f/{{forum}} with the subject "{{subject}}" and the text "{{message}}".',
      'Whoever submitted the {{which}} post in the {{forum}} forum: message them privately. Subject: "{{subject}}". Message: "{{message}}".',
      'Find who posted the {{which}} submission on /f/{{forum}} and send them a message titled "{{subject}}" that says "{{message}}".',
    ],
    *generate(r) {
      for (const f of r.shuffle(L.forums()).filter((x) => x.n >= 10)) {
        for (const which of r.sample(Object.keys(ORDER), 2)) {
          const [a, b] = L.all(`SELECT s.id, s.net_score, s.comment_count, s.user_id, u.username, u.allow_private_messages pm FROM submissions s JOIN users u ON u.id = s.user_id
            WHERE s.forum_id = ? AND s.visibility = 'visible' ORDER BY s.${ORDER[which].replace(', id', ', s.id')} LIMIT 2`, f.id);
          if (!a || (b && a[KEY[which]] === b[KEY[which]]) || a.user_id === L.DELETED_USER || !L.cleanName(a.username) || !a.pm) continue;
          const subject = r.pick(L.PHRASES.subjects); const message = r.pick(L.PHRASES.messages);
          const me = L.loginFor(r, [a.username]);
          yield { slots: { which, forum: f.name, subject, message }, login_user: me,
            eval: state(`SELECT (SELECT count(*) FROM messages m JOIN message_threads t ON t.id = m.thread_id WHERE m.sender_id = ${uid(me)}
                AND lower(trim(t.subject)) = lower(${lit(subject)}) AND ${L.ci('m.body', message)}
                AND EXISTS (SELECT 1 FROM message_thread_participants p WHERE p.thread_id = t.id AND p.user_id = ${uid(a.username)})) >= 1 AS sent,
              (SELECT count(DISTINCT p.user_id) FROM messages m JOIN message_thread_participants p ON p.thread_id = m.thread_id WHERE m.sender_id = ${uid(me)} AND p.user_id <> ${uid(me)}) AS recipients`,
              [{ sent: 1, recipients: 1 }]),
            changes: [`recipient: ${a.username} (submission ${a.id}); messages to anyone else fail`] };
        }
      }
    },
  },
];
