-- websandbox forum: lite schema (see ../SCHEMA.md for semantics).
-- Ids of users, forums, submissions and comments are the Postmill ids (task URLs use them).
-- Timestamps: 'YYYY-MM-DD HH:MM:SS' UTC text. Booleans: 0/1. No DEFAULT CURRENT_TIMESTAMP (kit rule 2).
PRAGMA foreign_keys = ON;

CREATE TABLE site_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
) WITHOUT ROWID;

CREATE TABLE users (
  id                    INTEGER PRIMARY KEY,
  username              TEXT NOT NULL,
  normalized_username   TEXT NOT NULL UNIQUE,          -- lower(username); login + /user/<name> lookups
  email                 TEXT,
  normalized_email      TEXT,
  password_hash         TEXT NOT NULL,                 -- kit.auth.verifyPassword format (scrypt$ or $2y$ bcrypt)
  role                  TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'admin' (Postmill users.admin)
  trusted               INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  last_seen_at          TEXT,
  biography             TEXT,                          -- raw; WebArena filled it with the Reddit account id (t2_...)
  locale                TEXT NOT NULL DEFAULT 'en',
  timezone              TEXT NOT NULL DEFAULT 'America/New_York',
  night_mode            TEXT NOT NULL DEFAULT 'auto',
  front_page            TEXT NOT NULL DEFAULT 'subscribed',   -- featured | subscribed | all | moderated
  front_page_sort_mode  TEXT NOT NULL DEFAULT 'hot',
  show_thumbnails       INTEGER NOT NULL DEFAULT 1,
  open_external_links_in_new_tab INTEGER NOT NULL DEFAULT 0,
  notify_on_reply       INTEGER NOT NULL DEFAULT 1,
  notify_on_mentions    INTEGER NOT NULL DEFAULT 1,
  allow_private_messages INTEGER NOT NULL DEFAULT 1,
  auto_fetch_submission_titles INTEGER NOT NULL DEFAULT 1,
  enable_post_previews  INTEGER NOT NULL DEFAULT 1,
  show_custom_stylesheets INTEGER NOT NULL DEFAULT 1,
  poppers_enabled       INTEGER NOT NULL DEFAULT 1,
  full_width_display_enabled INTEGER NOT NULL DEFAULT 0,
  submission_link_destination TEXT NOT NULL DEFAULT 'url',
  preferred_fonts       TEXT
);

CREATE TABLE forums (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL,
  normalized_name       TEXT NOT NULL UNIQUE,          -- lower(name); /f/<name> is case-insensitive
  title                 TEXT NOT NULL,
  description           TEXT,
  sidebar               TEXT,                          -- raw; WebArena put the Reddit subreddit id (t5_...) here
  created_at            TEXT NOT NULL,
  featured              INTEGER NOT NULL DEFAULT 0,
  moderation_log_public INTEGER NOT NULL DEFAULT 1,
  background_image_mode TEXT NOT NULL DEFAULT 'tile'
);

CREATE TABLE forum_tags (                              -- forum categories
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  description     TEXT
);
CREATE TABLE forums_tags (
  forum_id INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES forum_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (forum_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX forums_tags_tag ON forums_tags(tag_id);

CREATE TABLE moderators (
  id         INTEGER PRIMARY KEY,
  forum_id   INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (forum_id, user_id)
);
CREATE INDEX moderators_user ON moderators(user_id);

CREATE TABLE forum_subscriptions (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  forum_id      INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
  subscribed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, forum_id)
) WITHOUT ROWID;
CREATE INDEX forum_subscriptions_forum ON forum_subscriptions(forum_id);

CREATE TABLE hidden_forums (
  user_id  INTEGER NOT NULL REFERENCES users(id),
  forum_id INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, forum_id)
) WITHOUT ROWID;

CREATE TABLE forum_bans (                              -- a ban or an unban event (banned=0) in one forum
  id           INTEGER PRIMARY KEY,
  forum_id     INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  banned_by_id INTEGER NOT NULL REFERENCES users(id),
  reason       TEXT NOT NULL,
  banned       INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);
CREATE INDEX forum_bans_forum_user ON forum_bans(forum_id, user_id, created_at);

CREATE TABLE user_bans (                               -- site-wide ban events
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  banned_by_id INTEGER NOT NULL REFERENCES users(id),
  reason       TEXT NOT NULL,
  banned       INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);
CREATE INDEX user_bans_user ON user_bans(user_id, created_at);

CREATE TABLE user_blocks (
  id         INTEGER PRIMARY KEY,
  blocker_id INTEGER NOT NULL REFERENCES users(id),
  blocked_id INTEGER NOT NULL REFERENCES users(id),
  comment    TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (blocker_id, blocked_id)
);

CREATE TABLE images (
  id          TEXT PRIMARY KEY,                        -- Postmill image uuid
  file_name   TEXT NOT NULL UNIQUE,                    -- original '<sha256>.<ext>' (tasks look for it)
  sha256      TEXT NOT NULL,                           -- hex
  width       INTEGER,                                 -- original size
  height      INTEGER,
  path        TEXT,                                    -- under media/: 'submission_images/<sha256>.webp' (NULL if unconvertible)
  thumb_path  TEXT,                                    -- 'submission_images/thumb/<sha256>.webp'
  media_width INTEGER,                                 -- size of the stored webp
  media_height INTEGER,
  bytes       INTEGER
) WITHOUT ROWID;

CREATE TABLE submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  forum_id      INTEGER NOT NULL REFERENCES forums(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  slug          TEXT NOT NULL,                         -- Postmill Slugger::slugify(title); URLs /f/<forum>/<id>/<slug>
  url           TEXT,                                  -- link posts
  body          TEXT,                                  -- markdown; '' or NULL when none
  media_type    TEXT NOT NULL DEFAULT 'url',           -- 'url' (link or text post) | 'image'
  image_id      TEXT REFERENCES images(id),
  created_at    TEXT NOT NULL,
  edited_at     TEXT,
  last_active_at TEXT NOT NULL,                        -- newest comment or created_at (sort=active)
  sticky        INTEGER NOT NULL DEFAULT 0,
  locked        INTEGER NOT NULL DEFAULT 0,
  moderated     INTEGER NOT NULL DEFAULT 0,
  visibility    TEXT NOT NULL DEFAULT 'visible',       -- 'visible' | 'soft_deleted' | 'trashed'
  user_flag     TEXT NOT NULL DEFAULT 'none',          -- 'none' | 'moderator' | 'admin' (author's flag)
  net_score     INTEGER NOT NULL DEFAULT 0,            -- stored score (source value; votes adjust it, see triggers)
  comment_count INTEGER NOT NULL DEFAULT 0,
  ranking       INTEGER NOT NULL,                      -- 'hot' rank: unixtime(created_at) + clamp(score/comment advantage)
  reddit_id     TEXT                                   -- original Reddit fullname t3_... (WebArena stored it in user_flag)
);
CREATE INDEX submissions_forum_new ON submissions(forum_id, id);
CREATE INDEX submissions_forum_hot ON submissions(forum_id, ranking, id);
CREATE INDEX submissions_forum_top ON submissions(forum_id, net_score, id);
CREATE INDEX submissions_forum_active ON submissions(forum_id, last_active_at, id);
CREATE INDEX submissions_forum_comments ON submissions(forum_id, comment_count, id);
CREATE INDEX submissions_forum_created ON submissions(forum_id, created_at);
CREATE INDEX submissions_hot ON submissions(ranking, id);
CREATE INDEX submissions_top ON submissions(net_score, id);
CREATE INDEX submissions_active ON submissions(last_active_at, id);
CREATE INDEX submissions_comments ON submissions(comment_count, id);
CREATE INDEX submissions_created ON submissions(created_at);
CREATE INDEX submissions_user ON submissions(user_id, id);
CREATE INDEX submissions_image ON submissions(image_id) WHERE image_id IS NOT NULL;

CREATE TABLE comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  parent_id     INTEGER REFERENCES comments(id),      -- NULL = top-level reply to the submission
  user_id       INTEGER NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,                         -- markdown
  created_at    TEXT NOT NULL,
  edited_at     TEXT,
  visibility    TEXT NOT NULL DEFAULT 'visible',       -- 'visible' | 'soft_deleted' (shown as [deleted], replies kept) | 'trashed'
  moderated     INTEGER NOT NULL DEFAULT 0,
  user_flag     TEXT NOT NULL DEFAULT 'none',
  net_score     INTEGER NOT NULL DEFAULT 0,
  reddit_id     TEXT                                   -- original Reddit fullname t1_...
);
CREATE INDEX comments_submission ON comments(submission_id, parent_id, net_score);
CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX comments_user ON comments(user_id, id);

CREATE TABLE submission_votes (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  upvote        INTEGER NOT NULL,                      -- 1 = up, 0 = down (Postmill)
  created_at    TEXT NOT NULL,
  UNIQUE (user_id, submission_id)
);
CREATE INDEX submission_votes_submission ON submission_votes(submission_id);

CREATE TABLE comment_votes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  upvote     INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, comment_id)
);
CREATE INDEX comment_votes_comment ON comment_votes(comment_id);

-- Moderation log (Postmill forum_log_entries). action_type:
-- 'ban' | 'submission_deletion' | 'submission_restored' | 'submission_lock' | 'comment_deletion' | 'comment_restored'
CREATE TABLE forum_log_entries (
  id            INTEGER PRIMARY KEY,
  forum_id      INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id), -- the moderator who acted
  author_id     INTEGER REFERENCES users(id),          -- author of the affected content
  submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
  comment_id    INTEGER REFERENCES comments(id) ON DELETE SET NULL,
  ban_id        INTEGER REFERENCES forum_bans(id),
  was_admin     INTEGER NOT NULL DEFAULT 0,
  action_type   TEXT NOT NULL,
  title         TEXT,                                  -- title of the affected submission at the time
  locked        INTEGER,                               -- for submission_lock: 1 locked, 0 unlocked
  reason        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX forum_log_forum ON forum_log_entries(forum_id, created_at);

CREATE TABLE message_threads (
  id         INTEGER PRIMARY KEY,
  subject    TEXT,                                     -- lite addition (Postmill threads have no subject)
  created_at TEXT
);
CREATE TABLE message_thread_participants (
  thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (thread_id, user_id)
) WITHOUT ROWID;
CREATE INDEX message_thread_participants_user ON message_thread_participants(user_id);
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  thread_id  INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_thread ON messages(thread_id, id);

-- Notifications: 'comment' (reply to your submission/comment), 'submission_mention',
-- 'comment_mention', 'message'. Postmill deletes a notification when it is cleared;
-- read_at is a lite addition for UIs that mark instead of delete.
CREATE TABLE notifications (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  notification_type TEXT NOT NULL,
  submission_id     INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
  comment_id        INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  message_id        INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL,
  read_at           TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);

CREATE TABLE wiki_pages (
  id              INTEGER PRIMARY KEY,
  path            TEXT NOT NULL,
  normalized_path TEXT NOT NULL UNIQUE,
  locked          INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE wiki_revisions (
  id         INTEGER PRIMARY KEY,
  page_id    INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX wiki_revisions_page ON wiki_revisions(page_id, created_at);

-- ---------------------------------------------------------------- derived views
-- Postmill has no karma; the lite site shows the sum of the user's scores.
CREATE VIEW user_karma AS
  SELECT u.id AS user_id,
         (SELECT coalesce(sum(net_score), 0) FROM submissions s WHERE s.user_id = u.id AND s.visibility = 'visible') AS submission_karma,
         (SELECT coalesce(sum(net_score), 0) FROM comments c WHERE c.user_id = u.id AND c.visibility = 'visible') AS comment_karma
  FROM users u;
CREATE VIEW forum_stats AS
  SELECT f.id AS forum_id,
         (SELECT count(*) FROM submissions s WHERE s.forum_id = f.id AND s.visibility = 'visible') AS submission_count,
         (SELECT count(*) FROM forum_subscriptions fs WHERE fs.forum_id = f.id) AS subscriber_count
  FROM forums f;
