'use strict';
// Background jobs. Each runs on the tenant's connection with now() == its run_at.
module.exports = {
  // scheduled publish: POST /notes/:id/publish enqueues this with a delay
  'note.publish': ({ payload, db, now }) => {
    const r = db.prepare("UPDATE notes SET status = 'published', published_at = now() WHERE id = ? AND status = 'scheduled'").run(payload.id);
    return { published: r.changes, at: now.toISOString() };
  },
  // a job that fails, to show failed jobs don't leak partial writes
  'note.fail': ({ payload, db }) => {
    db.prepare('UPDATE notes SET likes = likes + 1000 WHERE id = ?').run(payload.id);
    throw new Error('simulated job failure');
  },
};
