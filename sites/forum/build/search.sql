-- Run after the bulk load: FTS5 indexes (external content, kept current by triggers)
-- and the triggers that keep submissions' stored aggregates in step with writes.

CREATE VIRTUAL TABLE submissions_fts USING fts5(
  title, body, url, content='submissions', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE comments_fts USING fts5(
  body, content='comments', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE forums_fts USING fts5(
  name, title, description, sidebar, content='forums', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2');
INSERT INTO submissions_fts(submissions_fts) VALUES ('rebuild');
INSERT INTO comments_fts(comments_fts) VALUES ('rebuild');
INSERT INTO forums_fts(forums_fts) VALUES ('rebuild');

CREATE TRIGGER submissions_fts_ai AFTER INSERT ON submissions BEGIN
  INSERT INTO submissions_fts(rowid, title, body, url) VALUES (new.id, new.title, new.body, new.url); END;
CREATE TRIGGER submissions_fts_ad AFTER DELETE ON submissions BEGIN
  INSERT INTO submissions_fts(submissions_fts, rowid, title, body, url) VALUES ('delete', old.id, old.title, old.body, old.url); END;
CREATE TRIGGER submissions_fts_au AFTER UPDATE OF title, body, url ON submissions BEGIN
  INSERT INTO submissions_fts(submissions_fts, rowid, title, body, url) VALUES ('delete', old.id, old.title, old.body, old.url);
  INSERT INTO submissions_fts(rowid, title, body, url) VALUES (new.id, new.title, new.body, new.url); END;

CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts(rowid, body) VALUES (new.id, new.body); END;
CREATE TRIGGER comments_fts_ad AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body) VALUES ('delete', old.id, old.body); END;
CREATE TRIGGER comments_fts_au AFTER UPDATE OF body ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO comments_fts(rowid, body) VALUES (new.id, new.body); END;

CREATE TRIGGER forums_fts_ai AFTER INSERT ON forums BEGIN
  INSERT INTO forums_fts(rowid, name, title, description, sidebar) VALUES (new.id, new.name, new.title, new.description, new.sidebar); END;
CREATE TRIGGER forums_fts_ad AFTER DELETE ON forums BEGIN
  INSERT INTO forums_fts(forums_fts, rowid, name, title, description, sidebar) VALUES ('delete', old.id, old.name, old.title, old.description, old.sidebar); END;
CREATE TRIGGER forums_fts_au AFTER UPDATE OF name, title, description, sidebar ON forums BEGIN
  INSERT INTO forums_fts(forums_fts, rowid, name, title, description, sidebar) VALUES ('delete', old.id, old.name, old.title, old.description, old.sidebar);
  INSERT INTO forums_fts(rowid, name, title, description, sidebar) VALUES (new.id, new.name, new.title, new.description, new.sidebar); END;

-- Votes adjust the stored net_score by the vote's delta (the source scores come from
-- Reddit and have no per-vote rows; see SCHEMA.md "Scores and votes").
CREATE TRIGGER submission_votes_ai AFTER INSERT ON submission_votes BEGIN
  UPDATE submissions SET net_score = net_score + (CASE WHEN new.upvote THEN 1 ELSE -1 END) WHERE id = new.submission_id; END;
CREATE TRIGGER submission_votes_ad AFTER DELETE ON submission_votes BEGIN
  UPDATE submissions SET net_score = net_score - (CASE WHEN old.upvote THEN 1 ELSE -1 END) WHERE id = old.submission_id; END;
CREATE TRIGGER submission_votes_au AFTER UPDATE OF upvote ON submission_votes WHEN new.upvote <> old.upvote BEGIN
  UPDATE submissions SET net_score = net_score + (CASE WHEN new.upvote THEN 2 ELSE -2 END) WHERE id = new.submission_id; END;
CREATE TRIGGER comment_votes_ai AFTER INSERT ON comment_votes BEGIN
  UPDATE comments SET net_score = net_score + (CASE WHEN new.upvote THEN 1 ELSE -1 END) WHERE id = new.comment_id; END;
CREATE TRIGGER comment_votes_ad AFTER DELETE ON comment_votes BEGIN
  UPDATE comments SET net_score = net_score - (CASE WHEN old.upvote THEN 1 ELSE -1 END) WHERE id = old.comment_id; END;
CREATE TRIGGER comment_votes_au AFTER UPDATE OF upvote ON comment_votes WHEN new.upvote <> old.upvote BEGIN
  UPDATE comments SET net_score = net_score + (CASE WHEN new.upvote THEN 2 ELSE -2 END) WHERE id = new.comment_id; END;

-- New comments bump the submission's comment_count and last_active_at (Postmill semantics).
CREATE TRIGGER comments_count_ai AFTER INSERT ON comments BEGIN
  UPDATE submissions SET comment_count = comment_count + 1,
    last_active_at = max(last_active_at, new.created_at) WHERE id = new.submission_id; END;
CREATE TRIGGER comments_count_ad AFTER DELETE ON comments BEGIN
  UPDATE submissions SET comment_count = comment_count - 1 WHERE id = old.submission_id; END;

-- 'hot' ranking (Postmill Submission::updateRanking): created + clamp(score*1800 + comments*k, -43200, 86400),
-- k = 5000 if net_score > -5 else 500.
CREATE TRIGGER submissions_ranking_au AFTER UPDATE OF net_score, comment_count ON submissions BEGIN
  UPDATE submissions SET ranking = CAST(strftime('%s', new.created_at) AS INTEGER) +
    max(min(new.net_score * 1800 + new.comment_count * (CASE WHEN new.net_score > -5 THEN 5000 ELSE 500 END), 86400), -43200)
  WHERE id = new.id; END;
CREATE TRIGGER submissions_ranking_ai AFTER INSERT ON submissions BEGIN
  UPDATE submissions SET ranking = CAST(strftime('%s', new.created_at) AS INTEGER) +
    max(min(new.net_score * 1800 + new.comment_count * (CASE WHEN new.net_score > -5 THEN 5000 ELSE 500 END), 86400), -43200)
  WHERE id = new.id; END;
