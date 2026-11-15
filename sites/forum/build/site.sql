-- Lite-site additions applied after search.sql (transform.py) or in place on an existing
-- base.db (build.sh site). Idempotent. See docs/NOTES-forum.md "UI build".

-- Visible-submission counts per forum = covering count(*) minus this (tiny) partial index.
CREATE INDEX IF NOT EXISTS submissions_hidden ON submissions(forum_id) WHERE visibility <> 'visible';

-- Forum categories (/forums/by_category, /tag/<name>). The source has none (forum_tags is
-- empty in Postmill's data); these are a lite addition so the category pages have content.
-- Deterministic ids 1..N in this order.
INSERT OR IGNORE INTO forum_tags (id, name, normalized_name, description) VALUES (1, 'Technology', lower('Technology'), 'Gadgets, software, AI and hardware');
INSERT OR IGNORE INTO forum_tags (id, name, normalized_name, description) VALUES (2, 'Gaming', lower('Gaming'), 'Video games and consoles');
INSERT OR IGNORE INTO forum_tags (id, name, normalized_name, description) VALUES (3, 'Science & Learning', lower('Science & Learning'), 'Science, history and explanations');
INSERT OR IGNORE INTO forum_tags (id, name, normalized_name, description) VALUES (4, 'News & Politics', lower('News & Politics'), 'Current events');
INSERT OR IGNORE INTO forum_tags (id, name, normalized_name, description) VALUES (5, 'Entertainment', lower('Entertainment'), 'Movies, TV, books and music');
INSERT OR IGNORE INTO forum_tags (id, name, normalized_name, description) VALUES (6, 'Humor & Memes', lower('Humor & Memes'), 'Funny stuff');
INSERT OR IGNORE INTO forum_tags (id, name, normalized_name, description) VALUES (7, 'Pictures & Art', lower('Pictures & Art'), 'Photos, art and cute animals');
INSERT OR IGNORE INTO forum_tags (id, name, normalized_name, description) VALUES (8, 'Lifestyle & Advice', lower('Lifestyle & Advice'), 'Advice, money, food and DIY');
INSERT OR IGNORE INTO forum_tags (id, name, normalized_name, description) VALUES (9, 'Places', lower('Places'), 'Cities, states and regions');
INSERT OR IGNORE INTO forums_tags (forum_id, tag_id) SELECT id, 1 FROM forums WHERE normalized_name IN ('technology','gadgets','machinelearning','deeplearning','coolgithubprojects','singularity','futurology','iphone','headphones','mechanicalkeyboards','monitor','internetisbeautiful');
INSERT OR IGNORE INTO forums_tags (forum_id, tag_id) SELECT id, 2 FROM forums WHERE normalized_name IN ('gaming','consoles');
INSERT OR IGNORE INTO forums_tags (forum_id, tag_id) SELECT id, 3 FROM forums WHERE normalized_name IN ('science','askscience','space','explainlikeimfive','todayilearned','history','dataisbeautiful','philosophy','documentaries');
INSERT OR IGNORE INTO forums_tags (forum_id, tag_id) SELECT id, 4 FROM forums WHERE normalized_name IN ('news','worldnews','upliftingnews','nottheonion');
INSERT OR IGNORE INTO forums_tags (forum_id, tag_id) SELECT id, 5 FROM forums WHERE normalized_name IN ('movies','television','books','music','listentothis','videos','writingprompts','nosleep','creepy');
INSERT OR IGNORE INTO forums_tags (forum_id, tag_id) SELECT id, 6 FROM forums WHERE normalized_name IN ('funny','memes','jokes','gifs','photoshopbattles','showerthoughts','mildlyinteresting');
INSERT OR IGNORE INTO forums_tags (forum_id, tag_id) SELECT id, 7 FROM forums WHERE normalized_name IN ('pics','art','earthporn','aww','oldschoolcool');
INSERT OR IGNORE INTO forums_tags (forum_id, tag_id) SELECT id, 8 FROM forums WHERE normalized_name IN ('askreddit','iama','relationship_advice','lifeprotips','getmotivated','tifu','personalfinance','buyitforlife','diy','food','sports','wallstreetbets');
INSERT OR IGNORE INTO forums_tags (forum_id, tag_id) SELECT id, 9 FROM forums WHERE normalized_name IN ('bridgeportct','cambridgema','columbiamd','connecticut','hartford','lowellma','maine','manchesternh','newark','pennsylvania','rhodeisland','stamfordct','washington','worcesterma','arlingtonva','baltimore','boston','jerseycity','lakewood','massachusetts','newhampshire','newhaven','newjersey','nyc','philadelphia','pittsburgh','providence','rva','springfieldmo','vermont','washingtondc','yonkers','paterson','allentown','waterburyct');

-- Per-user totals for profile pages (karma = sum of visible scores; counts of visible items).
-- Aggregating on the fly costs seconds for the "[deleted]" user (327k comments). Kept exact by
-- the triggers below for every write path (insert, vote -> net_score, visibility, delete).
CREATE TABLE IF NOT EXISTS user_stats (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id),
  submissions    INTEGER NOT NULL DEFAULT 0,
  comments       INTEGER NOT NULL DEFAULT 0,
  submission_karma INTEGER NOT NULL DEFAULT 0,
  comment_karma  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO user_stats (user_id, submissions, comments, submission_karma, comment_karma)
  SELECT user_id, sum(ns), sum(nc), sum(ks), sum(kc) FROM (
    SELECT user_id, count(*) AS ns, 0 AS nc, sum(net_score) AS ks, 0 AS kc FROM submissions WHERE visibility = 'visible' GROUP BY user_id
    UNION ALL
    SELECT user_id, 0, count(*), 0, sum(net_score) FROM comments WHERE visibility = 'visible' GROUP BY user_id)
  GROUP BY user_id;

CREATE TRIGGER IF NOT EXISTS user_stats_sub_ai AFTER INSERT ON submissions WHEN new.visibility = 'visible' BEGIN
  INSERT INTO user_stats (user_id, submissions, submission_karma) VALUES (new.user_id, 1, new.net_score)
    ON CONFLICT (user_id) DO UPDATE SET submissions = submissions + 1, submission_karma = submission_karma + new.net_score; END;
CREATE TRIGGER IF NOT EXISTS user_stats_sub_au AFTER UPDATE OF net_score, visibility, user_id ON submissions BEGIN
  UPDATE user_stats SET submissions = submissions - 1, submission_karma = submission_karma - old.net_score WHERE user_id = old.user_id AND old.visibility = 'visible';
  INSERT INTO user_stats (user_id, submissions, submission_karma) SELECT new.user_id, 1, new.net_score WHERE new.visibility = 'visible'
    ON CONFLICT (user_id) DO UPDATE SET submissions = submissions + 1, submission_karma = submission_karma + new.net_score; END;
CREATE TRIGGER IF NOT EXISTS user_stats_sub_ad AFTER DELETE ON submissions WHEN old.visibility = 'visible' BEGIN
  UPDATE user_stats SET submissions = submissions - 1, submission_karma = submission_karma - old.net_score WHERE user_id = old.user_id; END;
CREATE TRIGGER IF NOT EXISTS user_stats_com_ai AFTER INSERT ON comments WHEN new.visibility = 'visible' BEGIN
  INSERT INTO user_stats (user_id, comments, comment_karma) VALUES (new.user_id, 1, new.net_score)
    ON CONFLICT (user_id) DO UPDATE SET comments = comments + 1, comment_karma = comment_karma + new.net_score; END;
CREATE TRIGGER IF NOT EXISTS user_stats_com_au AFTER UPDATE OF net_score, visibility, user_id ON comments BEGIN
  UPDATE user_stats SET comments = comments - 1, comment_karma = comment_karma - old.net_score WHERE user_id = old.user_id AND old.visibility = 'visible';
  INSERT INTO user_stats (user_id, comments, comment_karma) SELECT new.user_id, 1, new.net_score WHERE new.visibility = 'visible'
    ON CONFLICT (user_id) DO UPDATE SET comments = comments + 1, comment_karma = comment_karma + new.net_score; END;
CREATE TRIGGER IF NOT EXISTS user_stats_com_ad AFTER DELETE ON comments WHEN old.visibility = 'visible' BEGIN
  UPDATE user_stats SET comments = comments - 1, comment_karma = comment_karma - old.net_score WHERE user_id = old.user_id; END;
