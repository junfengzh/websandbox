#!/usr/bin/env python3
"""Convert the 106 WebArena reddit-only tasks to the forum lite site.

    python3 -I tasks/forum/convert.py [--src .../test.raw.json] [--out tasks/forum/webarena.jsonl]

Writes one task per line (docs/CONVENTIONS.md "WebArena tasks"). Evaluators:
string_match -> answer (+ answer_sql where data-derived); url_match -> url with
url_match 'prefix' (WebArena's reddit url check is `ref in pred`, see sites/forum/grade.js);
program_html -> state_sql/state_expect on the tenant DB. Every reference was checked
against base.db and by a manual UI run (verify.jsonl).
"""
import argparse
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get('WEBARENA_TASKS', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '3rd-party', 'webarena', 'config_files', 'test.raw.json'))
ME = 'MarvelsGrantMan136'  # WebArena's reddit storage_state user


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def uid(name):
    return f'(SELECT id FROM users WHERE normalized_username = lower({lit(name)}))'


def fid(name):
    return f'(SELECT id FROM forums WHERE normalized_name = lower({lit(name)}))'


ME_ID = uid(ME)
# Rows that existed before the rollout: the imported data ends 2023-06-12 (submission 1);
# the site clock starts at 2023-07-11. Used to keep data-derived answers from moving when
# the agent writes, and to recognise the rollout's own new rows.
BASE_END = '2023-06-13'


NUMERIC_NEEDLES = []  # numeric needles used by the task being converted (regrade note)


def has_all(expr, needles):
    """SQL: expr contains every needle (case-insensitive, like WebArena's must_include). A plain
    number needle is matched with thousands separators removed ("$1,000" contains 1000)."""
    def one(n):
        if re.fullmatch(r'\d+', str(n)):
            NUMERIC_NEEDLES.append(n)
            return f"instr(replace(lower({expr}), ',', ''), {lit(n)}) > 0"
        return f'instr(lower({expr}), lower({lit(n)})) > 0'
    return ' AND '.join(one(n) for n in needles) or '1'


def latest_new_post(forums, needles):
    """state_sql: the user's newest new submission is in one of `forums` and its title/url/body
    contains every needle (WebArena: reddit_get_post_url(last url) + .submission__inner text)."""
    text = "s.title || ' ' || coalesce(s.url, '') || ' ' || coalesce(s.body, '')"
    flist = ', '.join(f'lower({lit(f)})' for f in forums)
    return (f"SELECT (f.normalized_name IN ({flist}) AND {has_all(text, needles)}) AS ok, f.name AS forum, s.id, s.title, s.body "
            f"FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.user_id = {ME_ID} AND s.visibility = 'visible' "
            f"AND s.created_at >= '{BASE_END}' ORDER BY s.id DESC LIMIT 1")


def votes(ids, up):
    """state_sql: how many of `ids` carry the user's up (1) / down (0) vote."""
    idl = ', '.join(str(i) for i in ids)
    return (f"SELECT count(*) AS total, (SELECT count(*) FROM submission_votes v WHERE v.user_id = {ME_ID} AND v.upvote = {1 if up else 0} "
            f"AND v.submission_id IN ({idl})) AS voted FROM submissions WHERE id IN ({idl}) AND visibility = 'visible'")


def url_forum(u):
    m = re.search(r'/f/([^/|\s]+)', u)
    return m.group(1) if m else None


def ref_urls(ev):
    r = (ev.get('reference_url') or '').strip()
    return [x.strip() for x in r.split('|OR|') if x.strip()] if r else []


def ids_in(ev):
    return [int(re.search(r'/f/[^/]+/(\d+)', p['url']).group(1)) for p in ev['program_html']]


# ---- per-task fixes (verified against base.db; see verify.jsonl)
FIXES = {
    28: 'Reference "0" corrected to the data: mineinhusdson (latest WorcesterMA post 123052) has 1 comment with '
        'net_score < 0 (comment 2555253, score -2). WebArena annotation was wrong (docs/NOTES-forum.md).',
    407: 'Reference post 124993 is the hot/top post of deeplearning, not the newest; corrected to the newest post '
         '125036 ("Should I continue with this?", newest by id and by date).',
    408: 'Reference post 39244 is the hot/top post of explainlikeimfive, not the newest; corrected to the newest post '
         '125342 (newest by id = Postmill "new").',
    644: 'There is no /f/games forum (WebArena reference /f/games could never match); intent changed from "games '
         'subreddit" to "gaming subreddit" and the URL to /f/gaming (the forum the other "games subreddit" tasks use).',
    584: 'WebArena read #forum_description/#forum_sidebar on /f/Karaoke (the forum page, which has no such fields: '
         'unpassable); now a SQL check of the forum row like 580-583.',
    68: 'Reference required "Levar Burton" as the "author" of A Christmas Carol (he narrates the audiobook); '
        'accepted "Charles Dickens" as an alternative, and "Tolkien" instead of the exact spelling "J. R. R. Tolkien".',
}
NEWEST = {404: 124260, 405: 119019, 406: 119517, 407: 125036, 408: 125342}


def convert(t):
    tid = t['task_id']
    ev0 = t['eval']
    tpl = t['intent_template_id']
    intent = t['intent']
    changes = []
    NUMERIC_NEEDLES.clear()
    out = {
        'task_id': tid, 'site': 'forum', 'intent': intent, 'intent_template': t['intent_template'],
        'intent_template_id': tpl, 'instantiation_dict': t.get('instantiation_dict'),
        'start_url': t['start_url'], 'require_login': True, 'login_user': ME,
    }
    ev = {}
    types = ev0['eval_types']

    if tpl == 33:  # count of downvoted comments of the latest poster in a forum
        forum = {'Worcester': 'WorcesterMA'}.get(t['instantiation_dict']['forum'], t['instantiation_dict']['forum'])
        ev = {'type': 'answer', 'answer': {'must_include': '$sql'},
              'answer_sql': (f"WITH p AS (SELECT user_id FROM submissions WHERE forum_id = {fid(forum)} AND visibility = 'visible' "
                             f"AND created_at < '{BASE_END}' ORDER BY id DESC LIMIT 1) SELECT count(*) FROM comments c, p "
                             f"WHERE c.user_id = p.user_id AND c.net_score < 0 AND c.visibility = 'visible' AND c.created_at < '{BASE_END}'")}
        changes.append('Answer derived by answer_sql: latest post = Postmill "new" (id DESC); "more downvotes than upvotes" = '
                       'net_score < 0 (no per-vote rows in the data).')
        if forum != t['instantiation_dict']['forum']:
            changes.append(f'"{t["instantiation_dict"]["forum"]}" forum = /f/{forum}.')
    elif tpl == 17:  # top-10 books posts, read & judge
        refs = {
            66: ['/f/books/59396', '/f/books/17445'],
            67: ['A Christmas Carol', 'The Hobbit'],
            68: ['A Christmas Carol', 'Charles Dickens |OR| LeVar Burton', 'The Hobbit', 'Tolkien'],
            69: ['bookshop.org'],
        }[tid]
        ev = {'type': 'answer', 'answer': {'must_include': refs}}
        if tid == 66:
            changes.append('Reference URLs (http://www.reddit.com/f/books/...) reduced to host-independent paths '
                           '/f/books/59396 and /f/books/17445 (any host or slug passes).')
    elif tpl == 6:  # bio
        bio = t['instantiation_dict']['content']
        ev = {'type': 'state', 'state_sql': f"SELECT lower(trim(biography)) = lower({lit(bio)}) AS ok, biography FROM users WHERE id = {ME_ID}",
              'state_expect': 1}
        changes.append('program_html .user-bio__biography exact_match -> SQL on users.biography (trimmed, case-insensitive like WebArena clean()).')
    elif tpl == 22:  # upvote newest post
        sid = NEWEST[tid]
        orig = ids_in(ev0)[0]
        ev = {'type': 'state', 'state_sql': votes([sid], True), 'state_expect': [{'total': 1, 'voted': 1}]}
        changes.append('vote--user-upvoted class -> submission_votes row (upvote=1) of the user (vote rows, not net_score).')
        if orig != sid:
            changes.append(FIXES[tid])
    elif tpl == 23 and tid in (409, 410):  # reply to a comment
        cid = int(re.search(r'/comment/(\d+)', ev0['program_html'][0]['url']).group(1))
        text = ev0['program_html'][0]['required_contents']['must_include'][0]
        ev = {'type': 'state', 'state_sql': (f"SELECT count(*) FROM comments WHERE user_id = {ME_ID} AND parent_id = {cid} AND visibility = 'visible' "
                                             f"AND {has_all('body', [text])}"), 'state_expect': {'min': 1}}
        changes.append(f'Comment permalink page text must_include -> SQL: a visible comment by the user replying to comment {cid} that contains the text.')
    elif tpl == 23:  # reply to the post
        sid = int(re.search(r'/f/[^/]+/(\d+)', t['start_url']).group(1))
        text = ev0['program_html'][0]['required_contents']['exact_match']
        ev = {'type': ['url', 'state'], 'url': ref_urls(ev0), 'url_match': 'prefix',
              'state_sql': (f"SELECT lower(trim(body)) = lower({lit(text)}) AS ok, body FROM comments WHERE user_id = {ME_ID} AND submission_id = {sid} "
                            f"AND parent_id IS NULL AND visibility = 'visible' ORDER BY id DESC LIMIT 1"), 'state_expect': 1}
        changes.append('First .comment__body on the last page exact_match -> SQL: the user\'s newest top-level comment on the post equals the text '
                       '(trimmed, case-insensitive). URL check: final URL on the post (prefix: the comment permalink also passes).')
    elif tpl == 7:  # create forum
        d = t['instantiation_dict']
        side = d['sidebar_list'] if isinstance(d['sidebar_list'], list) else eval(d['sidebar_list'], {})  # noqa: S307 literal list from the task file
        ev = {'type': 'state', 'state_sql': (f"SELECT ({has_all('description', [d['description']])}) AND ({has_all('sidebar', side)}) AS ok, name, description, sidebar "
                                             f"FROM forums WHERE normalized_name = lower({lit(d['name'])})"), 'state_expect': 1}
        changes.append('#forum_description / #forum_sidebar values on /f/<name>/edit -> SQL on the forums row (name case-insensitive like Postmill).')
        if tid in FIXES:
            changes.append(FIXES[tid])
    elif tpl == 4:  # open trending thread and subscribe
        forum = url_forum(ev0['reference_url'])
        ev = {'type': ['url', 'state'], 'url': ref_urls(ev0), 'url_match': 'prefix',
              'state_sql': f"SELECT count(*) FROM forum_subscriptions WHERE user_id = {ME_ID} AND forum_id = {fid(forum)}", 'state_expect': 1}
        changes.append('Front-page #sidebar section text -> SQL: forum_subscriptions row. URL: final page in the forum (WebArena "GOLD in PRED" = prefix).')
    elif tpl in (3765, 5, 9, 12, 13, 15, 6100, 16, 19):  # new posts
        refs = ref_urls(ev0)
        needles = ev0['program_html'][0]['required_contents']['must_include']
        if tid == 644:
            out['intent'] = intent.replace('in the games subreddit', 'in the gaming subreddit')
            refs = ['__REDDIT__/f/gaming']
            changes.append(FIXES[644])
        forums = [url_forum(r) for r in refs]
        ev = {'type': ['url', 'state'], 'url': refs, 'url_match': 'prefix', 'state_sql': latest_new_post(forums, needles), 'state_expect': 1}
        changes.append('reddit_get_post_url(last URL) .submission__inner must_include -> SQL: the user\'s newest new submission is in the '
                       f'reference forum ({" or ".join(forums)}) and its title/url/body contains {needles} (case-insensitive). '
                       'URL: final page under the forum (prefix).')
    elif tpl == 11:  # re-post image from /f/pics
        refs = ref_urls(ev0)
        fname = ev0['program_html'][1]['required_contents']['must_include'][0]
        stem = fname.rsplit('.', 1)[0]
        forum = url_forum(refs[0])
        text = "s.title || ' ' || coalesce(s.body, '')"
        img = (f"(instr(coalesce(s.url, ''), {lit(stem)}) > 0 OR instr(coalesce(s.body, ''), {lit(stem)}) > 0 "
               f"OR coalesce(s.image_id, '') = (SELECT id FROM images WHERE file_name = {lit(fname)}))")
        ev = {'type': ['url', 'state'], 'url': refs, 'url_match': 'prefix',
              'state_sql': (f"SELECT (f.normalized_name = lower({lit(forum)}) AND {has_all(text, ['from /f/pics'])} AND {img}) AS ok, f.name AS forum, s.id, s.title, s.url, s.image_id "
                            f"FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.user_id = {ME_ID} AND s.visibility = 'visible' "
                            f"AND s.created_at >= '{BASE_END}' ORDER BY s.id DESC LIMIT 1"), 'state_expect': 1}
        changes.append(f'Image file name in .submission__inner href/src -> SQL: the newest new submission is in /f/{forum}, says "from /f/pics", '
                       f'and links the original image (url/body contains its sha256 {stem[:12]}..., e.g. the /submission_images/{fname[:12]}... link '
                       'copied from the /f/pics post, or image_id is the original image).')
    elif tpl == 24 or (tpl in (25, 1510) and 'program_html' in types):
        ids = ids_in(ev0)
        up = tpl == 25
        ev = {'type': 'state', 'state_sql': votes(ids, up), 'state_expect': [{'total': len(ids), 'voted': len(ids)}]}
        changes.append(f'vote--user-{"upvoted" if up else "downvoted"} class on {len(ids)} post page(s) -> SQL: submission_votes rows '
                       f'(upvote={1 if up else 0}) of the user on posts {ids} (vote rows, not net_score).')
        if tpl == 25 and 'new york' in intent:
            changes.append('"new york" = /f/nyc.')
    elif tpl in (25, 1510):  # N/A
        ev = {'type': 'answer', 'answer': {'fuzzy': 'N/A'}}
        changes.append('Kept fuzzy "N/A" (LLM judge): ' + ev0.get('string_note', ''))
    elif tpl == 27:  # edit own post body
        p = ev0['program_html'][0]
        sid = ids_in(ev0)[0]
        rc = p['required_contents']
        if 'exact_match' in rc:
            cond = f"lower(trim(body)) = lower({lit(rc['exact_match'])})"
        else:
            cond = has_all("coalesce(body, '')", rc['must_include'])
        ev = {'type': 'state', 'state_sql': f"SELECT {cond} AS ok, body FROM submissions WHERE id = {sid} AND user_id = {ME_ID} AND visibility = 'visible'",
              'state_expect': 1}
        changes.append(f'.submission__body text -> SQL on submissions.body of post {sid} '
                       f'({"exact, trimmed, case-insensitive" if "exact_match" in rc else "contains all, case-insensitive"}).')
    else:
        raise SystemExit(f'unhandled task {tid} template {tpl}')

    if tid in FIXES and not any(FIXES[tid] == c for c in changes):
        changes.append(FIXES[tid])
    if NUMERIC_NEEDLES:
        changes.append('regrade 2026-11-15: number needles (' + ', '.join(sorted(set(map(str, NUMERIC_NEEDLES)))) + ') are matched '
                       'with thousands separators removed, so "$1,000" counts as 1000.')
    out['eval'] = ev
    out['changes'] = changes
    out['status'] = 'verified'
    out['drop_reason'] = None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=SRC)
    ap.add_argument('--out', default=os.path.join(HERE, 'webarena.jsonl'))
    ap.add_argument('--status', default=os.path.join(HERE, 'verify.jsonl'), help='verify log; tasks without an ok run are written as status "unverified"')
    a = ap.parse_args()
    with open(a.src) as f:
        src = [t for t in json.load(f) if t['sites'] == ['reddit']]
    ok = {}
    if os.path.exists(a.status):
        with open(a.status) as f:
            for line in f:
                if line.strip():
                    v = json.loads(line)
                    if not v.get('negative'):
                        ok[v['task_id']] = v['ok']  # last positive run wins
    tasks = [convert(t) for t in sorted(src, key=lambda t: t['task_id'])]
    for t in tasks:
        if t['status'] == 'verified' and ok.get(t['task_id']) is not True:
            t['status'] = 'unverified'
    with open(a.out, 'w') as f:
        for t in tasks:
            f.write(json.dumps(t, ensure_ascii=False) + '\n')
    n = {}
    for t in tasks:
        n[t['status']] = n.get(t['status'], 0) + 1
    print(f'{len(tasks)} tasks -> {a.out}: {n}')


if __name__ == '__main__':
    main()
