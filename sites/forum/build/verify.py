#!/usr/bin/env python3
"""Verify the forum base.db against the source export, the source DB and the WebArena tasks.

Usage: python3 -I verify.py --db DATA/base.db --export WORK/export --tasks TEST_RAW_JSON
           [--pg-container wsb-forum-pg] [--media DATA/media] [--kit KIT_DIR]

1. Row counts per table vs counts.json written by export.py.
2. Referential integrity (PRAGMA foreign_key_check), FTS row counts, media files present.
3. Every __REDDIT__ URL in the reddit tasks: forum exists, submission id is in that forum,
   slug equals the stored slug, /comment/<id> belongs to the submission, /user/<name> exists.
4. Spot-check facts the tasks depend on, computed both on the source Postgres (if
   --pg-container is given) and on base.db, and compared.
5. Login: MarvelsGrantMan136 / test1234 verifies with the kit (if --kit is given).
Exit status 1 on any failure. Prints a JSON report on stdout.
"""
import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys

TABLE_MAP = {  # lite table -> source table
    'users': 'users', 'forums': 'forums', 'images': 'images', 'submissions': 'submissions', 'comments': 'comments',
    'submission_votes': 'submission_votes', 'comment_votes': 'comment_votes', 'moderators': 'moderators',
    'forum_subscriptions': 'forum_subscriptions', 'forum_bans': 'forum_bans', 'forum_log_entries': 'forum_log_entries',
    'forum_tags': 'forum_tags', 'forums_tags': 'forums_tags', 'hidden_forums': 'hidden_forums',
    'messages': 'messages', 'message_threads': 'message_threads', 'notifications': 'notifications',
    'wiki_pages': 'wiki_pages', 'wiki_revisions': 'wiki_revisions', 'user_bans': 'user_bans', 'user_blocks': 'user_blocks',
}

LATEST_AUTHOR_NEG = """(SELECT count(*) FROM comments c WHERE c.net_score < 0 AND c.user_id =
   (SELECT s.user_id FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE f.normalized_name = '{f}' ORDER BY s.id DESC LIMIT 1))"""
# (name, task ids, Postgres SQL, SQLite SQL). Same answer expected from both.
FACTS = [
    ('latest Showerthoughts author: comments with net<0', '27', LATEST_AUTHOR_NEG.format(f='showerthoughts'), None),
    ('latest WorcesterMA author: comments with net<0', '28', LATEST_AUTHOR_NEG.format(f='worcesterma'), None),
    ('latest DIY author: comments with net<0', '29', LATEST_AUTHOR_NEG.format(f='diy'), None),
    ('latest space author: comments with net<0', '30', LATEST_AUTHOR_NEG.format(f='space'), None),
    ('latest photoshopbattles author: comments with net<0', '31', LATEST_AUTHOR_NEG.format(f='photoshopbattles'), None),
    ('top-10 books by score (ids)', '66-69',
     "SELECT string_agg(id::text, ',') FROM (SELECT s.id FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name='books' ORDER BY net_score DESC, s.id DESC LIMIT 10) t",
     "SELECT group_concat(id, ',') FROM (SELECT s.id FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name='books' ORDER BY net_score DESC, s.id DESC LIMIT 10)"),
    ('newest post in books', '404',
     "SELECT max(s.id) FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name='books'", None),
    ('newest post in DIY / Futurology / deeplearning / explainlikeimfive', '405-408',
     "SELECT string_agg(m::text, ',' ORDER BY n) FROM (SELECT f.name n, max(s.id) m FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name IN ('DIY','Futurology','deeplearning','explainlikeimfive') GROUP BY f.name) t",
     "SELECT group_concat(m, ',') FROM (SELECT f.name n, max(s.id) m FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name IN ('DIY','Futurology','deeplearning','explainlikeimfive') GROUP BY f.name ORDER BY n)"),
    ('5 newest in space', '552',
     "SELECT string_agg(id::text, ',') FROM (SELECT s.id FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name='space' ORDER BY s.id DESC LIMIT 5) t",
     "SELECT group_concat(id, ',') FROM (SELECT s.id FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name='space' ORDER BY s.id DESC LIMIT 5)"),
    ('DIY top-10 by sort=active (last_active, id)', '562-566',
     "SELECT string_agg(id::text, ',') FROM (SELECT s.id FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name='DIY' ORDER BY last_active DESC, s.id DESC LIMIT 10) t",
     "SELECT group_concat(id, ',') FROM (SELECT s.id FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name='DIY' ORDER BY last_active_at DESC, s.id DESC LIMIT 10)"),
    ('top post ever in gadgets', '714',
     "SELECT s.id FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name='gadgets' ORDER BY net_score DESC, s.id DESC LIMIT 1", None),
    ('top-5 in technology', '718',
     "SELECT string_agg(id::text, ',') FROM (SELECT s.id FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name='technology' ORDER BY net_score DESC, s.id DESC LIMIT 5) t",
     "SELECT group_concat(id, ',') FROM (SELECT s.id FROM submissions s JOIN forums f ON f.id=s.forum_id WHERE f.name='technology' ORDER BY net_score DESC, s.id DESC LIMIT 5)"),
    ('ThetaGang_wsb submissions in wallstreetbets', '719',
     "SELECT string_agg(s.id::text, ',' ORDER BY s.id) FROM submissions s JOIN users u ON u.id=s.user_id JOIN forums f ON f.id=s.forum_id WHERE u.username='ThetaGang_wsb' AND f.name='wallstreetbets'",
     "SELECT group_concat(id, ',') FROM (SELECT s.id FROM submissions s JOIN users u ON u.id=s.user_id JOIN forums f ON f.id=s.forum_id WHERE u.username='ThetaGang_wsb' AND f.name='wallstreetbets' ORDER BY s.id)"),
    ('Hrekires submissions in news (count)', '724,730',
     "SELECT count(*) FROM submissions s JOIN users u ON u.id=s.user_id JOIN forums f ON f.id=s.forum_id WHERE u.username='Hrekires' AND f.name='news'", None),
    ('FTorrez81 / jacyanthis submissions in iphone(13) / EarthPorn (N/A tasks)', '723,726',
     "SELECT count(*) FROM submissions s JOIN users u ON u.id=s.user_id JOIN forums f ON f.id=s.forum_id WHERE (u.username='FTorrez81' AND f.normalized_name LIKE 'iphone%') OR (u.username='jacyanthis' AND f.normalized_name='earthporn')", None),
    ('MarvelsGrantMan136: submissions, comments, bio', '399,731-735',
     "SELECT (SELECT count(*) FROM submissions WHERE user_id=13915)||'/'||(SELECT count(*) FROM comments WHERE user_id=13915)||'/'||(SELECT biography FROM users WHERE id=13915)",
     "SELECT (SELECT count(*) FROM submissions WHERE user_id=13915)||'/'||(SELECT count(*) FROM comments WHERE user_id=13915)||'/'||(SELECT biography FROM users WHERE id=13915)"),
    ('submission 1 (Nvidia RTX 4090) body/forum/author', '731',
     "SELECT s.body||'|'||f.name||'|'||u.username FROM submissions s JOIN forums f ON f.id=s.forum_id JOIN users u ON u.id=s.user_id WHERE s.id=1", None),
    ('MarvelsGrantMan136 television posts: ids with empty body', '732-735',
     "SELECT string_agg(s.id::text, ',' ORDER BY s.id) FROM submissions s WHERE s.user_id=13915 AND s.id IN (134868,135152,135156,135201) AND coalesce(s.body,'')=''",
     "SELECT group_concat(id, ',') FROM (SELECT id FROM submissions s WHERE s.user_id=13915 AND s.id IN (134868,135152,135156,135201) AND coalesce(s.body,'')='' ORDER BY id)"),
    ('pics image b02113033af3...jpg: submission id and title', '615',
     "SELECT s.id||'|'||s.title FROM submissions s JOIN images i ON i.id=s.image_id WHERE i.file_name LIKE 'b02113033af3%'", None),
    ('comment 1235250 author and parent (books 59421)', '409',
     "SELECT u.username||'|'||coalesce(c.parent_id::text,'top')||'|'||c.submission_id FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=1235250",
     "SELECT u.username||'|'||coalesce(c.parent_id,'top')||'|'||c.submission_id FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=1235250"),
    ('first reply in singularity 69404 (comment 1042264): author|parent', '410',
     "SELECT u.username||'|'||coalesce(c.parent_id::text,'top') FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=1042264",
     "SELECT u.username||'|'||coalesce(c.parent_id,'top') FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=1042264"),
    ('forums the post tasks target exist', '600-649',
     "SELECT string_agg(name, ',' ORDER BY normalized_name) FROM forums WHERE normalized_name IN ('consoles','nyc','pittsburgh','washington','washingtondc','deeplearning','machinelearning','singularity','books','earthporn','funny','relationship_advice','iphone','movies','headphones','sports','diy','buyitforlife','games','gaming','technology','dataisbeautiful','history','lifeprotips','aww','science')",
     "SELECT group_concat(name, ',') FROM (SELECT name FROM forums WHERE normalized_name IN ('consoles','nyc','pittsburgh','washington','washingtondc','deeplearning','machinelearning','singularity','books','earthporn','funny','relationship_advice','iphone','movies','headphones','sports','diy','buyitforlife','games','gaming','technology','dataisbeautiful','history','lifeprotips','aww','science') ORDER BY normalized_name)"),
    ('totals: submissions score sum, comment score sum', '-',
     "SELECT (SELECT sum(net_score) FROM submissions)||'/'||(SELECT sum(net_score) FROM comments)",
     "SELECT (SELECT sum(net_score) FROM submissions)||'/'||(SELECT sum(net_score) FROM comments)"),
]


def pg(container, sql):
    p = subprocess.run(['docker', 'exec', '-u', 'postgres', container, 'psql', '-X', '-At', '-d', 'postmill', '-c', 'SELECT ' + sql if sql.startswith('(') else sql],
                       capture_output=True, text=True, check=True)
    return p.stdout.strip()


def lite(db, sql):
    v = db.execute('SELECT ' + sql if sql.startswith('(') else sql).fetchone()
    v = v[0] if v else None
    return '' if v is None else str(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--export', required=True)
    ap.add_argument('--tasks', required=True)
    ap.add_argument('--pg-container')
    ap.add_argument('--media')
    ap.add_argument('--kit')
    a = ap.parse_args()
    db = sqlite3.connect(f'file:{a.db}?mode=ro', uri=True)
    rep = {'counts': {}, 'failures': []}
    fail = rep['failures'].append

    src = json.load(open(os.path.join(a.export, 'counts.json')))
    for t, s in TABLE_MAP.items():
        n = db.execute(f'SELECT count(*) FROM {t}').fetchone()[0]
        rep['counts'][t] = {'lite': n, 'source': src.get(s)}
        if n != src.get(s):
            fail(f'count {t}: lite {n} != source {src.get(s)}')
    for t, base in (('submissions_fts', 'submissions'), ('comments_fts', 'comments'), ('forums_fts', 'forums')):
        n = db.execute(f"SELECT count(*) FROM {t}_docsize").fetchone()[0]
        if n != rep['counts'][base]['lite']:
            fail(f'{t}: {n} docs != {base}')
    fk = db.execute('PRAGMA foreign_key_check').fetchall()
    rep['foreign_key_violations'] = len(fk)
    if fk:
        fail(f'foreign keys: {fk[:5]}')
    q = db.execute("SELECT count(*) FROM submissions s WHERE comment_count <> (SELECT count(*) FROM comments c WHERE c.submission_id = s.id)").fetchone()[0]
    if q:
        fail(f'{q} submissions with comment_count != #comments')
    rep['images_without_webp'] = db.execute('SELECT count(*) FROM images WHERE path IS NULL').fetchone()[0]
    if a.media:
        missing = [p for (p,) in db.execute('SELECT path FROM images WHERE path IS NOT NULL UNION ALL SELECT thumb_path FROM images WHERE thumb_path IS NOT NULL')
                   if not os.path.exists(os.path.join(a.media, p))]
        rep['media_missing'] = len(missing)
        if missing:
            fail(f'{len(missing)} media files missing, e.g. {missing[:3]}')

    # task URLs
    tasks = [t for t in json.load(open(a.tasks)) if 'reddit' in t['sites']]
    urls = set()
    for t in tasks:
        urls.update(re.findall(r'__REDDIT__(/[^\s"\',)]*)', json.dumps(t)))
    checked = 0
    for u in sorted(urls):
        m = re.match(r'^/f/([^/]+)(?:/(\d+)(?:/([^/]+))?(?:/comment/(\d+))?)?(/edit)?$', u)
        mu = re.match(r'^/user/([^/]+)$', u)
        if mu:
            if not db.execute('SELECT 1 FROM users WHERE normalized_username = lower(?)', (mu.group(1),)).fetchone():
                fail(f'{u}: no such user')
            checked += 1
            continue
        if not m:
            continue
        forum, sid, slug, cid, edit = m.groups()
        f = db.execute('SELECT id FROM forums WHERE normalized_name = lower(?)', (forum,)).fetchone()
        if edit or not f:
            if not f:
                rep.setdefault('forums_created_by_tasks_or_missing', []).append(forum)
            continue
        checked += 1
        if sid:
            s = db.execute('SELECT forum_id, slug FROM submissions WHERE id = ?', (int(sid),)).fetchone()
            if not s or s[0] != f[0]:
                fail(f'{u}: submission not in forum')
            elif slug and slug != '-' and slug != s[1]:
                fail(f'{u}: slug {s[1]!r} differs')
            if cid and not db.execute('SELECT 1 FROM comments WHERE id = ? AND submission_id = ?', (int(cid), int(sid))).fetchone():
                fail(f'{u}: comment not in submission')
    rep['task_urls_checked'] = checked

    rep['facts'] = []
    for name, tids, psql, lsql in FACTS:
        lv = lite(db, lsql or psql)
        row = {'fact': name, 'tasks': tids, 'lite': lv}
        if a.pg_container:
            row['source'] = pg(a.pg_container, psql)
            row['ok'] = row['source'] == lv
            if not row['ok']:
                fail(f'fact {name}: source {row["source"]!r} != lite {lv!r}')
        rep['facts'].append(row)

    if a.kit:
        h = db.execute("SELECT password_hash FROM users WHERE username = 'MarvelsGrantMan136'").fetchone()[0]
        js = ("const {verifyPassword}=require(process.argv[1]+'/lib/auth');let b='';process.stdin.on('data',d=>b+=d)"
              ".on('end',async()=>{const t=Date.now();const ok=await verifyPassword('test1234',b);"
              "process.stdout.write(JSON.stringify({ok,ms:Date.now()-t}))})")
        r = json.loads(subprocess.run(['node', '-e', js, a.kit], input=h, capture_output=True, text=True, check=True).stdout)
        rep['login_MarvelsGrantMan136'] = r
        if not r['ok']:
            fail('MarvelsGrantMan136/test1234 does not verify')

    print(json.dumps(rep, indent=1, ensure_ascii=False))
    sys.exit(1 if rep['failures'] else 0)


if __name__ == '__main__':
    main()
