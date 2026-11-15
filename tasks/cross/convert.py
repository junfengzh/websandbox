#!/usr/bin/env python3
"""Convert the 48 WebArena cross-site tasks (more than one entry in `sites`) to the lite sites.

    python3 -I tasks/cross/convert.py [--src .../test.raw.json] [--out tasks/cross/webarena.jsonl]

Writes one task per line (docs/CONVENTIONS.md "WebArena tasks", "Cross-site tasks"):
`site` = "cross", `sites` = every site the task uses (shopping, shopping_admin, gitlab, forum,
wiki, map), `grade_site` = the site whose grader handles url / map checks and whose DB answers
checks without a site, `login_user` = {site: user}. State checks on several sites are
`eval.state = [{site, sql, expect}]`; `reference_sql` = [{site, sql, expect}] records how the
reference was re-derived on our data (checked at conversion / verification time, not graded).
Every task is checked by a manual run through the UIs (verify.jsonl).
"""
import argparse
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get('WEBARENA_TASKS', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '3rd-party', 'webarena', 'config_files', 'test.raw.json'))

GITLAB_USER = 'byteblaze'
FORUM_USER = 'MarvelsGrantMan136'
SHOP_USER = 'emma.lopez@gmail.com'
ADMIN_USER = 'admin'
# rows that existed before the rollout (site data ends): forum 2023-06-12, gitlab 2023-04-26
FORUM_NEW = '2023-06-13'
GITLAB_NEW = '2023-04-27'
SITE_NAMES = {'reddit': 'forum', 'wikipedia': 'wiki'}  # WebArena -> lite site names
MAP_START = '__MAP__/#map=15/40.4443/-79.9436'  # as tasks/map: the default CMU view, explicit


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def norm_q(s):
    """typographic quotes -> ASCII (agents type ' where the page shows ’)"""
    return s.replace('’', "'").replace('‘', "'").replace('“', '"').replace('”', '"')


def norm_sql(expr):
    """SQL: lower(expr) with typographic quotes and en/em dashes folded to ASCII"""
    e = f'lower({expr})'
    for a, b in (('’', "'"), ('‘', "'"), ('“', '"'), ('”', '"'), ('–', '-'), ('—', '-')):
        e = f'replace({e}, {lit(a)}, {lit(b)})'
    return e


def has_all(ne, needles):
    """SQL: the normalized text column `ne` (norm_sql) contains every needle (case-insensitive,
    quotes/dashes folded; WebArena must_include)"""
    out = []
    for n in needles:
        n = norm_q(n).replace('–', '-').replace('—', '-').lower()
        out.append(f'instr({ne}, {lit(n)}) > 0')
    return ' AND '.join(out) or '1'


# ---------------------------------------------------------------- gitlab
def gl_project(path):
    return f'(SELECT id FROM projects WHERE lower(full_path) = lower({lit(path)}))'


def gl_file_has(project, file_path, needles, new_project=False):
    """state: the file on the project's default branch (written through the web UI: temp.repo_files)
    contains every needle. new_project: the project must have been created by the rollout."""
    extra = f" AND p.created_at >= '{GITLAB_NEW}'" if new_project else ''
    return (f"SELECT ({has_all('t', needles)}) AS ok, full_path, path, substr(content, 1, 300) AS head FROM "
            f"(SELECT p.full_path, rf.path, rf.content, {norm_sql('rf.content')} AS t FROM projects p "
            f'JOIN repo_files rf ON rf.project_id = p.id AND rf.branch = p.default_branch AND lower(rf.path) = lower({lit(file_path)}) '
            f'WHERE lower(p.full_path) = lower({lit(project)}){extra} AND rf.content IS NOT NULL)')


# ---------------------------------------------------------------- forum
def f_uid(name):
    return f'(SELECT id FROM users WHERE normalized_username = lower({lit(name)}))'


def latest_new_post(forums, needles, title=None, body_only=False, repo=None):
    """state on forum: the user's newest new submission is in one of `forums`, its title equals
    `title` (if given, case-insensitive) and its text (title/url/body, or body only) contains every needle.
    repo: '/ns/proj' that must be linked on the code site: the text contains it other than as a
    github.com link (the host varies per tenant: gitlab.wa, 127.10.<i>.5, ...)."""
    text = 'coalesce(s.body, \'\')' if body_only else "s.title || ' ' || coalesce(s.url, '') || ' ' || coalesce(s.body, '')"
    flist = ', '.join(f'lower({lit(f)})' for f in forums)
    conds = [f'fname IN ({flist})', has_all('t', needles)]
    if repo:
        r = repo.lower()
        conds.append(f"instr(replace(t, {lit('github.com' + r)}, ''), {lit(r)}) > 0")
    if title is not None:
        conds.append(f"tt = {lit(norm_q(title).lower())}")
    return (f"SELECT ({' AND '.join(conds)}) AS ok, forum, id, title, url, substr(body, 1, 300) AS body FROM "
            f"(SELECT f.normalized_name AS fname, f.name AS forum, s.id, s.title, s.url, s.body, {norm_sql(text)} AS t, {norm_sql('trim(s.title)')} AS tt "
            f"FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.user_id = {f_uid(FORUM_USER)} AND s.visibility = 'visible' "
            f"AND s.created_at >= '{FORUM_NEW}' ORDER BY s.id DESC LIMIT 1)")


def forum_posts_sql(forum, order, n):
    return (f"SELECT s.id FROM submissions s WHERE s.forum_id = (SELECT id FROM forums WHERE normalized_name = lower({lit(forum)})) "
            f"AND s.visibility = 'visible' AND s.created_at < '{FORUM_NEW}' ORDER BY {order} LIMIT {n}")


def ids_from_urls(urls):
    return [int(re.search(r'/f/[^/]+/(\d+)', u).group(1)) for u in urls]


def post_paths(urls):
    """'__REDDIT__/f/space/134164/slug' -> '/f/space/134164' (host-free; the slug is optional)"""
    return [re.search(r'(/f/[^/]+/\d+)', u).group(1).lower() for u in urls]


# ---------------------------------------------------------------- store
def low_reviews_sql(product_id, max_stars):
    return (f"SELECT r.title FROM reviews r JOIN review_votes v ON v.review_id = r.id WHERE r.product_id = {product_id} "
            f"AND r.status = 'approved' AND v.value <= {max_stars} GROUP BY r.title ORDER BY min(r.id)")


def base(t, sites, grade_site, logins, start_url=None, intent=None):
    out = {
        'task_id': t['task_id'], 'site': 'cross', 'sites': sites, 'grade_site': grade_site,
        'intent': intent or t['intent'], 'intent_template': t['intent_template'],
        'intent_template_id': t['intent_template_id'], 'instantiation_dict': t['instantiation_dict'],
        'start_url': start_url or t['start_url'], 'require_login': bool(logins), 'login_user': logins or None,
    }
    return out


def convert(t):
    tid = t['task_id']
    tpl = t['intent_template_id']
    ev = t['eval']
    changes = []
    status, drop = 'verified', None

    # ---- 84: folder + urls.txt of the 5 newest posts of a forum (gitlab + forum)
    if tpl == 84:
        out = base(t, ['gitlab', 'forum'], 'gitlab', {'gitlab': GITLAB_USER, 'forum': FORUM_USER})
        if tid == 791:
            out['eval'] = {'type': 'answer', 'answer': {'fuzzy': ['N/A']}}
            out['reference_sql'] = [{'site': 'forum', 'sql': "SELECT name FROM forums WHERE normalized_name LIKE '%car%'", 'expect': {'empty': True}}]
            changes.append('Kept: there is no "cars" forum (no forum name contains "car"), so the task is unachievable and the answer is graded by the LLM judge against "N/A" (WebArena fuzzy_match N/A).')
        else:
            p = ev['program_html'][0]
            folder = re.search(r'/raw/main/(.+)/urls\.txt', p['url']).group(1)
            urls = p['required_contents']['must_include']
            forum = re.search(r'/f/([^/]+)/', urls[0]).group(1)
            ids = ids_from_urls(urls)
            out['eval'] = {'type': 'state', 'state': [
                {'site': 'gitlab', 'sql': gl_file_has('byteblaze/gimmiethat.space', f'{folder}/urls.txt', post_paths(urls)), 'expect': 1}]}
            out['reference_sql'] = [{'site': 'forum', 'sql': forum_posts_sql(forum, 's.id DESC', 5), 'expect': {'rows': [[i] for i in ids], 'ordered': True}}]
            changes.append(f'program_html (raw {folder}/urls.txt must_include the 5 post URLs) -> SQL on gitlab: temp.repo_files {folder}/urls.txt on '
                           f'byteblaze/gimmiethat.space\'s default branch (main) contains each post path {", ".join(post_paths(urls))} '
                           '(case-insensitive; host-free, the slug may follow, as in the URL copied from the forum).')
            changes.append(f'Reference re-derived on the forum: the 5 newest /f/{forum} posts (Postmill "new" = id DESC) are {ids} = WebArena\'s (reference_sql).')
            if tid == 553:
                out['intent'] = t['intent'].replace('the news related subreddits', 'the news subreddit')
                out['instantiation_dict'] = {**t['instantiation_dict'], 'subreddit': 'news subreddit'}
                changes.append('Intent "the news related subreddits" -> "the news subreddit": news, worldnews and UpliftingNews are all news related; the reference is /f/news only.')
        out['changes'] = changes

    # ---- 87: repo with a README from Wikipedia facts about Christopher Nolan (gitlab + wiki)
    elif tpl == 87:
        out = base(t, ['gitlab', 'wiki'], 'gitlab', {'gitlab': GITLAB_USER})
        p = ev['program_html'][0]
        repo = re.search(r'__GITLAB__/(.+?)/-/raw/', p['url']).group(1)
        needles = p['required_contents']['must_include']
        out['eval'] = {'type': 'state', 'state': [{'site': 'gitlab', 'sql': gl_file_has(repo, 'README.md', needles, new_project=True), 'expect': 1}]}
        changes.append(f'program_html (raw README.md must_include) -> SQL on gitlab: a project {repo} created by the rollout whose README.md on the default '
                       f'branch (temp.repo_files) contains {needles} (case-insensitive; typographic quotes and en dashes match their ASCII forms).')
        if tid == 558:
            out['intent'] = t['intent'].replace('after 2010', 'since 2010')
            changes.append('Intent "after 2010" -> "since 2010": the reference includes Inception (2010).')
        if tid == 559:
            changes.append('The four headings are the Career subsections of the wiki\'s Christopher_Nolan article (sections JSON); an ASCII hyphen for the en dash passes.')
        if tid in (560, 561):
            changes.append('Reference = the "Accolades" table of the wiki\'s Christopher_Nolan article (Academy Award wins: The Dark Knight, Inception, Interstellar, Dunkirk, Tenet; '
                           'BAFTA nominations: Batman Begins, The Dark Knight, Inception, The Dark Knight Rises, Interstellar, Dunkirk, Tenet).')
        if tid == 556:
            changes.append('Oppenheimer (2023) is listed as an upcoming film in the 2022-05 wiki article (and Oppenheimer_(film) exists).')
        out['reference_sql'] = [{'site': 'wiki', 'sql': "SELECT count(*) FROM article WHERE path IN ('Christopher_Nolan', 'Christopher_Nolan_filmography')", 'expect': 2}]
        out['changes'] = changes

    # ---- 88: repo with a README of the N most active DIY posts (gitlab + forum)
    elif tpl == 88:
        out = base(t, ['gitlab', 'forum'], 'gitlab', {'gitlab': GITLAB_USER, 'forum': FORUM_USER})
        p = ev['program_html'][0]
        repo = re.search(r'__GITLAB__/(.+?)/-/raw/', p['url']).group(1)
        urls = p['required_contents']['must_include']
        ids = ids_from_urls(urls)
        out['eval'] = {'type': 'state', 'state': [{'site': 'gitlab', 'sql': gl_file_has(repo, 'README.md', post_paths(urls), new_project=True), 'expect': 1}]}
        out['reference_sql'] = [{'site': 'forum', 'sql': forum_posts_sql('DIY', 's.last_active_at DESC, s.id DESC', len(ids)), 'expect': {'rows': [[i] for i in ids], 'ordered': True}}]
        changes.append(f'program_html (raw README.md must_include {len(ids)} post URLs) -> SQL on gitlab: a project {repo} created by the rollout whose README.md on the default '
                       'branch contains each post path /f/diy/<id> (case-insensitive, host-free; the slug may follow).')
        changes.append(f'Reference re-derived on the forum: the {len(ids)} most active /f/DIY posts (sort "active" = last_active_at DESC) are {ids} = WebArena\'s (reference_sql).')
        if tid == 566:
            changes.append('Repository "Do it myself": GitLab derives the path do-it-myself; project paths compare case-insensitively.')
        out['changes'] = changes

    # ---- 101: low-rated review titles from the shop -> post in /f/gaming (shopping + forum)
    elif tpl == 101:
        product_ids = {671: 29647, 672: 84385, 673: 111576, 674: 111396, 675: 85404}
        stars = {671: 2, 672: 3, 673: 1, 674: 3, 675: 2}
        n_titles = {671: 3, 672: 6, 673: 4, 674: 3, 675: 3}  # distinct titles (673: one title holds two of the needles)
        intent = t['intent'].replace('in the games subreddit', 'in the gaming subreddit')
        out = base(t, ['shopping', 'forum'], 'forum', {'shopping': SHOP_USER, 'forum': FORUM_USER}, intent=intent)
        title = ev['program_html'][0]['required_contents']['exact_match']
        needles = ev['program_html'][1]['required_contents']['must_include']
        out['eval'] = {'type': ['url', 'state'], 'url': ['__REDDIT__/f/gaming'], 'url_match': 'prefix',
                       'state': [{'site': 'forum', 'sql': latest_new_post(['gaming'], needles, title=title, body_only=True), 'expect': 1}]}
        out['reference_sql'] = [{'site': 'shopping', 'sql': low_reviews_sql(product_ids[tid], stars[tid]), 'expect': {'count': n_titles[tid]}}]
        changes.append('Intent "games subreddit" -> "gaming subreddit": there is no /f/games; the reference is /f/gaming (as tasks/forum 644).')
        changes.append(f'program_html (.submission__title exact, .submission__body must_include) -> SQL on forum: the user\'s newest new submission is in /f/gaming, '
                       f'its title is "{title}" (case-insensitive) and its body contains every review title (typographic apostrophes match ASCII ones). URL: final page under /f/gaming (prefix).')
        changes.append(f'Reference re-derived on the store: approved reviews of product {product_ids[tid]} rated <= {stars[tid]} stars (reference_sql; duplicate titles listed once).')
        out['changes'] = changes

    # ---- 116: find a repo on gitlab, post a link to it in a relevant forum (forum + gitlab)
    elif tpl == 116:
        out = base(t, ['forum', 'gitlab'], 'forum', {'forum': FORUM_USER, 'gitlab': GITLAB_USER})
        forums = [re.sub(r'^__REDDIT__/f/', '', u.strip()) for u in ev['reference_url'].split('|OR|')]
        needles = ev['program_html'][0]['required_contents']['must_include']
        repo = needles[1].replace('__GITLAB__', '').lower()
        out['eval'] = {'type': ['url', 'state'], 'url': [f'__REDDIT__/f/{f}' for f in forums], 'url_match': 'prefix',
                       'state': [{'site': 'forum', 'sql': latest_new_post(forums, [], repo=repo), 'expect': 1}]}
        out['reference_sql'] = [{'site': 'gitlab', 'sql': f'SELECT count(*) FROM projects WHERE lower(full_path) = lower({lit(repo[1:])})', 'expect': 1}]
        changes.append(f'program_html (.submission__inner must_include {needles[0]!r} and the repo URL) -> SQL on forum: the user\'s newest new submission is in one of '
                       f'{forums} and its title/url/body links the repo (contains {repo} with any host but github.com: the code site\'s host varies per tenant). URL: final page under one of those forums (prefix).')
        changes.append(f'Dropped the must_include {needles[0]!r}: the intent does not ask for that phrase in the post (a post linking the repo with other words is correct); '
                       'the repo link identifies the repository.')
        out['changes'] = changes

    # ---- 117: promote a repo with its own description (forum + gitlab)
    elif tpl == 117:
        out = base(t, ['forum', 'gitlab'], 'forum', {'forum': FORUM_USER, 'gitlab': GITLAB_USER})
        forum = ev['reference_url'].replace('__REDDIT__/f/', '').strip()
        desc, link = ev['program_html'][0]['required_contents']['must_include']
        repo = link.replace('__GITLAB__', '').lower()
        out['eval'] = {'type': ['url', 'state'], 'url': [f'__REDDIT__/f/{forum}'], 'url_match': 'prefix',
                       'state': [{'site': 'forum', 'sql': latest_new_post([forum], [desc], repo=repo), 'expect': 1}]}
        out['reference_sql'] = [{'site': 'gitlab', 'sql': f'SELECT instr(description, {lit(desc)}) > 0 FROM projects WHERE lower(full_path) = lower({lit(repo[1:])})', 'expect': 1}]
        changes.append(f'program_html (.submission__inner text + hrefs must_include the description and the repo URL) -> SQL on forum: the user\'s newest new submission is in /f/{forum} '
                       f'and its title/url/body contains "{desc}" (case-insensitive) and links {repo} (any host but github.com). URL: final page under /f/{forum} (prefix).')
        changes.append('Description checked on gitlab (reference_sql): the project description contains the reference text.')
        out['changes'] = changes

    else:
        out = map_task(t, changes)
        if out is None:
            raise SystemExit(f'task {tid}: template {tpl} not handled')
        status, drop = out.pop('_status', status), out.pop('_drop', drop)
        out['changes'] = changes
    out['status'] = status
    out['drop_reason'] = drop
    return out


CMU = (40.4436977, -79.9434082)
MAP_PLACES = {  # task -> (accepted OSM objects, must_include on the place page, what)
    424: (['R188553', 'W544174673'], ['Pittsburgh'], 'Mister Rogers\' Neighborhood was taped at WQED in Pittsburgh: the city (relation 188553) or the WQED studio'),
    425: (['W375341624', 'W611248703'], ['Mackinac Bridge'], 'the Mackinac Bridge (bridge way or its motorway way; Michigan, geocoder only)'),
    426: (['R417155', 'W295270550', 'N2942530213', 'W621563695', 'R189076', 'R8729705'], ['Somerset County'],
          'Flight 93 crashed near Shanksville, Stonycreek Township, Somerset County: the county, the Flight 93 National Memorial (park, entrance, visitor centre), Shanksville or Stonycreek Township'),
    427: (['R65066'], ['Massachusetts Institute of Technology'], 'MIT (relation 65066)'),
    428: (['R2279034', 'W25795401'], ['Carnegie Mellon University'], 'John Nash studied at the Carnegie Institute of Technology = Carnegie Mellon University (relation or campus way)'),
    429: (['W172206707', 'W109563490'], ['Chatham University'], 'The Chair was filmed at Chatham University (main campus or its Eastside building)'),
    430: (['W583390395'], ['Washington & Jefferson College'], 'Washington & Jefferson College (Washington, PA)'),
}
FROM_CMU = {'must_include': ['Carnegie Mellon University', 'Pittsburgh'], 'near': list(CMU), 'radius_m': 500}
MAP_ROUTES = {  # task -> (from, to, note); engine car (WebArena selectedIndex 1)
    737: (FROM_CMU, {'must_include': ['Xfinity Mobile Arena |OR| Wells Fargo Center', 'Philadelphia'], 'near': [39.9013372, -75.1720196], 'radius_m': 500},
          'the 76ers play at the Wells Fargo Center, renamed Xfinity Mobile Arena in current OSM (our display name; "Wells Fargo Center" is an alias)'),
    738: (FROM_CMU, {'must_include': ['South Broad Street |OR| Xfinity Mobile Arena |OR| Wells Fargo Center', 'Philadelphia'], 'near': [39.9013372, -75.1720196], 'radius_m': 800},
          'in the 1970s the 76ers played at the Spectrum, 3601 South Broad Street (demolished 2011, not in OSM): the route must end at that address / the sports complex (within 800 m of the arena, which shares the address)'),
    739: (FROM_CMU, {'must_include': ['Yankee Stadium |OR| East 161st Street |OR| Heritage Field', 'Bronx'], 'near': [40.8295565, -73.9268337], 'radius_m': 600},
          'in the 1980s the Yankees played at the old Yankee Stadium (1923-2008, East 161st Street; demolished, now Heritage Field next to the new stadium): end within 600 m of the current stadium'),
    740: (FROM_CMU, {'must_include': ['Madison Square Garden', 'Manhattan'], 'near': [40.7505067, -73.9934445], 'radius_m': 300}, 'the Knicks play at Madison Square Garden'),
    741: (FROM_CMU, {'must_include': ['TD Garden', 'Boston'], 'near': [42.3664151, -71.0623184], 'radius_m': 300}, 'the Celtics play at TD Garden'),
    759: ({'must_include': ['Boston'], 'near': [42.3588336, -71.0578303], 'radius_m': 15000}, {'must_include': ['New York'], 'near': [40.7127281, -74.0060152], 'radius_m': 40000},
          'Sophia Young lives in Boston (store customer address, reference_sql)'),
    760: ({'must_include': ['Allentown', 'Lehigh County'], 'near': [40.6022552, -75.4716115], 'radius_m': 15000}, {'must_include': ['Hoboken', 'New Jersey'], 'near': [40.7433066, -74.0323752], 'radius_m': 5000},
          'Amanda Kim lives in Hoboken, NJ (store customer address, reference_sql); From = the city of Allentown, PA (Lehigh County), not the Allentown neighbourhood of Pittsburgh'),
}
# lite engine numbers (car / bike, endpoints as the directions form geocodes them)
MAP_ANSWERS = {
    97: ([{'numeric': {'value': 913, 'unit': 'km', 'tol_pct': 3}}],
         'string_match "914km" -> numeric distance (kit numeric mode, 3 %): lite car Carnegie Mellon University -> Massachusetts Institute of Technology: 913km, 11h 34min. Top CS school in Massachusetts = MIT (wiki).'),
    265: ([{'must_include': ['Acadia National Park']}, {'numeric': {'value': 422, 'unit': 'km', 'tol_pct': 5}}],
          'must_include "457km" -> numeric distance (5 %): lite car Boston -> Acadia National Park (the geocoder\'s Acadia object, Hadlock Pond Road): 422km, 5h 41min (WebArena\'s endpoint gave 457km).'),
    266: ([{'exact': 'Acadia National Park'}], 'Unchanged: largest city in Maine = Portland (wiki); the closest national park is Acadia.'),
    267: ([{'must_include': ['Acadia National Park']}, {'numeric': {'value': 78, 'unit': 'min', 'tol_pct': 10, 'tol_abs': 3}}],
          'Hometown = Bangor, decided explicitly: the wiki article says King was born in Portland, raised in Durham, and calls Bangor "his home town" (STK Foundation paragraph); WebArena\'s 1h 23min also fits Bangor. fuzzy "1h 23min" -> numeric (10 %): lite car Bangor -> Acadia National Park 74km, 1h 18min (Portland would be 3h 36min and fails).'),
    268: ([{'must_include': ['Acadia National Park']}, {'numeric': {'value': 613, 'unit': 'min', 'tol_pct': 10}}],
          'fuzzy "10h 33min" -> numeric (10 %): lite bike Vinalhaven -> Acadia National Park 158km, 10h 13min (incl. the Rockland ferry).'),
}


def map_task(t, changes):
    """wiki / shopping_admin + map tasks: graded on the map's final URL or the answer"""
    tid = t['task_id']
    tpl = t['intent_template_id']
    sites = ['wiki', 'map'] if 'wikipedia' in t['sites'] else ['shopping_admin', 'map']
    logins = {'shopping_admin': ADMIN_USER} if 'shopping_admin' in sites else None
    out = base(t, sites, 'map', logins, start_url=MAP_START)
    changes.append('start_url __MAP__ -> ' + MAP_START + ' (as tasks/map: the default CMU view, explicit; search ranking uses the map view).')
    if 'wikipedia' in t['sites']:
        changes.append('require_login dropped: neither the wiki nor the map has accounts.')
    if tid in MAP_ANSWERS:
        ans, note = MAP_ANSWERS[tid]
        out['eval'] = {'type': 'answer', 'answer': ans if len(ans) > 1 else ans[0]}
        changes.append(note)
    elif tid in MAP_PLACES:
        osm, inc, note = MAP_PLACES[tid]
        out['eval'] = {'type': 'place', 'place': {'osm': osm, 'must_include': inc}}
        changes.append(f'program_html (#sidebar_content must_include {inc}) -> place check: the final URL is the place page of an accepted object ({", ".join(osm)}) and its name/address contains {inc}. '
                       f'WebArena accepted any page mentioning the words; the object list keeps the intent ({note}).')
        if tid == 425:
            out['intent'] = t['intent'].replace('the longest bridge', 'the longest suspension bridge')
            out['instantiation_dict'] = {'description': 'the longest suspension bridge in the Western hemisphere'}
            changes.append('Intent "the longest bridge" -> "the longest suspension bridge": by total length the longest bridge in the Western Hemisphere is the Lake Pontchartrain Causeway '
                           '(wiki List_of_longest_bridges; Louisiana, not on the map); the Mackinac Bridge article says "the longest suspension bridge between anchorages in the Western Hemisphere".')
        if tid == 427:
            out['intent'] = 'Find the page of the university in Massachusetts that has the most Turing Award winners on the map.'
            out['instantiation_dict'] = {'description': 'the university in Massachusetts that has the most Turing Award winners'}
            changes.append('Intent fixed ("Turning" -> "Turing", "university" -> "university in Massachusetts"): on our 2022-05 wiki the counts favour Stanford '
                           '("29 Turing Award laureates") over MIT ("26 Turing Award winners"), the Turing Award article has no affiliations, and Stanford is not on the map; '
                           'within Massachusetts MIT (26) clearly beats Harvard (14), so the reference MIT holds (docs/NOTES-wiki.md 427).')
    elif tid in MAP_ROUTES:
        frm, to, note = MAP_ROUTES[tid]
        out['eval'] = {'type': 'directions', 'directions': {'engine': 'car', 'from': frm, 'to': to}}
        ph = t['eval']['program_html']
        refs = {re.search(r"name=\\?\"(route_\w+)", p['locator']).group(1) if 'route_' in p['locator'] else 'engine': p['required_contents'] for p in ph}
        changes.append('program_html (select.routing_engines selectedIndex 1, route_from/route_to values must_include '
                       f'{refs.get("route_from", {}).get("must_include")} / {refs.get("route_to", {}).get("must_include")}) -> directions check of the final URL: engine car, '
                       'From/To field values (display names) contain the must_include words and the route end points lie near the places: ' + note + '.')
        if tid in (759, 760):
            name = 'Sophia Young' if tid == 759 else 'Amanda Kim'
            out['reference_sql'] = [{'site': 'shopping_admin', 'sql': f"SELECT a.city FROM customers c JOIN customer_addresses a ON a.customer_id = c.id WHERE c.firstname || ' ' || c.lastname = {lit(name)}",
                                     'expect': 'Boston' if tid == 759 else 'Hoboken'}]
    else:
        return None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=SRC)
    ap.add_argument('--out', default=os.path.join(HERE, 'webarena.jsonl'))
    ap.add_argument('--status', default=os.path.join(HERE, 'verify.jsonl'), help='verify log; tasks without an ok run are written as status "unverified"')
    ap.add_argument('--only', help='comma-separated template ids to convert (development)')
    a = ap.parse_args()
    with open(a.src) as f:
        src = [t for t in json.load(f) if len(t['sites']) > 1]
    if a.only:
        keep = {int(x) for x in a.only.split(',')}
        src = [t for t in src if t['intent_template_id'] in keep]
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
