#!/usr/bin/env python3
"""Convert WebArena gitlab-only tasks (batch "a": 24 templates, 93 tasks) to the code lite site.

    python3 -I tasks/code/convert-a.py [--src .../test.raw.json] [--out tasks/code/webarena-a.jsonl]

Batch b (the other gitlab templates) is tasks/code/*-b.*. One task per line
(docs/CONVENTIONS.md "WebArena tasks"). Evaluators:
string_match -> answer (+ answer_sql where data-derived, so drift is reported);
url_match -> url (kit grader: host ignored, params as a subset multiset);
program_html -> state_sql/state_expect on the tenant DB (members, follows, projects, issues,
temp.repo_files for web-edited files). References were checked against base.db and by a
manual UI run (verify-a.jsonl).
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = '$WEBARENA_TASKS'
ME = 'byteblaze'
TEMPLATES = {289, 290, 291, 292, 293, 294, 298, 299, 300, 303, 308, 310, 312, 316, 320, 321, 322, 323, 324, 325, 327, 328, 329, 330}
# Rows created by a rollout: the imported data ends 2023-04-26, the site clock starts 2023-04-27 16:00 UTC.
NEW = '2023-04-27'
SSH = 'ssh://git@metis.lti.cs.cmu.edu:2222/'


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def uid(name):
    return f'(SELECT id FROM users WHERE username = {lit(name)})'


def pid(full_path):
    return f'(SELECT id FROM projects WHERE lower(full_path) = lower({lit(full_path)}))'


def uids(names):
    return ', '.join(uid(n) for n in names)


def ci_has(expr, needle):
    return f'instr(lower({expr}), lower({lit(needle)})) > 0'


# "repositories where I made contributions": byteblaze's own projects + projects he is a member of
CONTRIB = (f"FROM projects p WHERE p.namespace_id = (SELECT id FROM namespaces WHERE kind = 'user' AND path = {lit(ME)}) "
           f"OR p.id IN (SELECT source_id FROM members WHERE source_type = 'project' AND user_id = {uid(ME)} AND requested_at IS NULL)")


def top_contrib(project, branch, col, n=1):
    return (f"SELECT {col} FROM contributors WHERE project_id = {pid(project)} AND branch = {lit(branch)} "
            f"ORDER BY commits DESC, author_email LIMIT {n}")


def commits_sql(project, where):
    """Commits on the project's default branch (GitLab's commit list: merges included; UTC committed day)."""
    return (f"SELECT count(*) FROM branch_commits b JOIN commits c ON c.id = b.commit_id WHERE b.project_id = {pid(project)} "
            f"AND b.branch = (SELECT default_branch FROM projects WHERE id = {pid(project)}) AND c.committed_at < {lit(NEW)} AND ({where})")


ERIC = "c.author_name LIKE 'Eric %'"
KILIAN = "c.author_name LIKE 'Kilian %'"
A11Y = 'a11yproject/a11yproject.com'


def day(d):
    return f"date(c.committed_at) = {lit(d)}"


def span(a, b):
    return f"c.committed_at >= {lit(a)} AND c.committed_at < {lit(b)}"


COMMITS = {  # task -> (project, where, note)
    205: (A11Y, f'{KILIAN} AND {day("2023-03-05")}', None),
    206: (A11Y, f'{ERIC} AND {day("2023-03-02")}', None),
    207: (A11Y, f'({ERIC} OR {KILIAN}) AND {day("2023-01-03")}', None),
    303: (A11Y, f"{KILIAN} AND {span('2023-01-01', '2024-01-01')}", None),
    304: (A11Y, f"{ERIC} AND {span('2023-02-01', '2023-06-01')}", None),
    305: (A11Y, f"c.author_name LIKE 'Philip %' AND {span('2023-01-01', '2023-02-01')}", None),
    306: (A11Y, f"c.author_name LIKE 'Anthony %' AND {span('2022-08-01', '2022-10-01')}", None),
    307: (A11Y, f"(c.author_name = 'Nic' OR c.author_name LIKE 'Nic %') AND {span('2022-04-01', '2022-05-01')}", None),
    132: (A11Y, f'{KILIAN} AND {day("2023-03-05")}', None),
    133: (A11Y, f'{ERIC} AND {day("2023-03-02")}', None),
    134: (A11Y, f'{KILIAN} AND {day("2023-03-01")}', None),
    135: (A11Y, f'({ERIC} OR {KILIAN}) AND {day("2023-01-03")}', None),
    136: ('byteblaze/a11y-webring.club', f"c.author_name LIKE '%Woodson%' AND {day('2023-02-06')}",
          'Counts both of his git identities ("Steven Woodson" 3 + "Steve Woodson" 2 = 5), as the reference does.'),
}

# template 316: (project, branch, answer column(s))
TOP316 = {
    784: ('CellularPrivacy/Android-IMSI-Catcher-Detector', 'development', 'author_email'),
    785: ('CellularPrivacy/Android-IMSI-Catcher-Detector', 'gh-pages', 'author_email'),
    786: ('vinta/awesome-python', 'master', 'commits'),
}
TOP323 = {308: 'primer/design', 309: 'thoughtbot/administrate', 310: 'umano/AndroidSlidingUpPanel',
          311: 'eriklindernoren/PyTorch-GAN', 312: 'wireservice/csvkit'}
TOP324 = {314: ('primer/design', 'author_name'), 315: ('eriklindernoren/PyTorch-GAN', 'author_email'),
          316: ('facebook/create-react-app', 'author_name'), 318: ('yjlou/2019-nCov', 'author_name')}

INVITE = {  # 293: project, usernames
    480: ('byteblaze/solarized-prism-theme', ['yjlou']),
    567: ('byteblaze/gimmiethat.space', ['lahwaacz', 'bblanchon']),
    568: ('a11yproject/a11yproject.com', ['abisubramanya27', 'vinta']),
    569: ('byteblaze/accessible-html-content-patterns', ['bblanchon', 'abisubramanya27']),
    570: ('byteblaze/timeit', ['lahwaacz', 'V13Axel', 'alexhutnik', 'bblanchon']),
}
GUEST = {481: 'abisubramanya27', 482: 'yjlou', 483: 'koush', 484: 'lahwaacz', 485: 'vinta'}
FOLLOW = {533: ['convexegg', 'yjlou'], 534: ['lahwaacz', 'koush', 'vinta'], 535: ['lahwaacz', 'ghost', 'bblanchon'],
          536: ['ghost', 'R1kk3r', 'abisubramanya27'], 537: ['lahwaacz', 'convexegg', 'vinta', 'yjlou', 'abisubramanya27']}
ISSUE327 = {  # project, assignee, due date
    658: ('a11yproject/a11yproject.com', 'Roshanjossey', '2030-12-31'),
    659: ('byteblaze/empathy-prompts', 'Roshanjossey', '2033-04-01'),
    660: ('byteblaze/dotfiles', 'abisubramanya27', '2033-07-18'),
    808: ('byteblaze/cloud-to-butt', 'byteblaze', '2033-03-31'),
    809: ('a11yproject/a11yproject.com', 'byteblaze', '2030-01-03'),
}
ISSUE328 = {661: 'convexegg/chatgpt', 662: '0ang3el/aem-hacker', 663: 'root/metaseq', 664: 'vinta/awesome-python',
            665: 'byteblaze/a11y-syntax-highlighting'}
CLONE = {293: 'convexegg/super_awesome_robot', 294: 'convexegg/chatgpt', 295: 'root/metaseq',
         296: 'eriklindernoren/PyTorch-GAN', 297: 'yjlou/2019-nCov'}

FIXES = {
    786: 'Reference 412 corrected to 414: Vinta Chen (vinta.chen@gmail.com) has 414 commits on the Contributors page '
         '(the live WebArena GitLab\'s /vinta/awesome-python/-/graphs/master?format=json says 414 too, docs/NOTES-code.md); '
         'intent "branch main" -> "branch master" (the repository has no main branch).',
    784: 'Intent "branch main" -> "branch development": the repository has no main branch; development is its default '
         'branch (master gives the same top contributor).',
    785: 'Intent "branch gh-page" -> "branch gh-pages" (the branch name).',
    307: 'Intent "April 2021" -> "April 2022": Nic made 0 commits in April 2021; the reference 16 is Nic Chan\'s '
         'commits in April 2022 (docs/NOTES-code.md).',
    45: 'Reference sort=created_asc (oldest first) contradicts "most recent"; reference changed to the newest-first '
        'list (sort=created_date, the default, as task 46): the list page with no sort param or sort=created_date passes.',
    536: 'Reference listed @lahwaacz although the intent names ghost (copy of 535); reference fixed to @ghost, @R1kk3r, '
         '@abisubramanya27.',
    175: 'Intent keyword "dependency" -> "dependencies": the reference issue is "Outdated dependencies" (empathy-prompts#18); '
         'GitLab\'s title search is a substring match, so "dependency" never finds it. Intent says "assigned to me": '
         'the reference picks from the issues assigned to byteblaze (the dashboard\'s "Issues" list).',
    174: 'Intent says "(assigned to me)": the reference a11y-webring.club#71 is the latest updated "feature" issue assigned to '
         'byteblaze (authored by Seirdy); among issues byteblaze authored it would be #39.',
    317: 'Peter Albert and Zachary DeVito tie for 3rd with 12 commits; either is accepted. Reference "Name: N" strings split '
         'into names and counts (any formatting passes).',
    296: 'exact "ssh://..." -> must_include: the asked-for command "git clone ssh://..." (as in 293-295) passes too.',
    297: 'exact "ssh://..." -> must_include (see 296). "most starred Covid location tracker" = yjlou/2019-nCov (compares '
         'Google Maps location history with patients\' locations); covid19india-react (34 stars) tracks case counts, not locations.',
    312: 'GitLab groups contributors by e-mail: James McKinney has 450 + 130 commits under two e-mails, so the page\'s top '
         'entry is Christopher Groskopf (499), the reference.',
}


def convert(t):
    tid = t['task_id']
    ev0 = t['eval']
    tpl = t['intent_template_id']
    intent = t['intent']
    changes = []
    out = {'task_id': tid, 'site': 'gitlab', 'intent': intent, 'intent_template': t['intent_template'],
           'intent_template_id': tpl, 'instantiation_dict': t.get('instantiation_dict'),
           'start_url': t['start_url'], 'require_login': True, 'login_user': ME}
    refs = (ev0.get('reference_answers') or {})
    ev = {}

    if tpl == 289:  # repos I contributed to, by stars
        cond = {169: f'p.star_count = (SELECT max(p.star_count) {CONTRIB})', 170: f'p.star_count = (SELECT min(p.star_count) {CONTRIB})',
                171: 'p.star_count < 5', 172: 'p.star_count = 0', 168: 'p.star_count > 100'}[tid]
        sql = f'SELECT p.path FROM ({ "SELECT p.* " + CONTRIB }) p WHERE {cond} ORDER BY p.path'
        if tid == 168:
            ev = {'type': 'answer', 'answer': {'fuzzy': 'N/A'}}
            changes.append('Kept fuzzy "N/A" (LLM judge): no repository byteblaze contributes to has more than 100 stars '
                           f'(max 21). Check: {sql} returns no rows.')
        else:
            ev = {'type': 'answer', 'answer': {'must_include': refs['must_include']}, 'answer_sql': sql}
            changes.append('Static must_include kept (project paths); answer_sql = byteblaze\'s own + member projects by '
                           'star_count (reports drift).')
    elif tpl == 290:
        ev = {'type': 'url', 'url': ev0['reference_url']}
        changes.append('url_match kept (lite dashboard uses GitLab\'s URL); kit grader: reference params must be present.')
    elif tpl == 291:
        ev = {'type': 'url', 'url': ev0['reference_url']}
        changes.append('url_match kept (lite dashboard uses GitLab\'s URL); kit grader: reference params must be present.')
    elif tpl == 292:  # new empty repo
        name = t['instantiation_dict']['project_name']
        ev = {'type': 'state', 'state_sql': f"SELECT count(*) FROM projects WHERE lower(full_path) = lower({lit(ME + '/' + name)}) "
                                            f"AND created_at >= {lit(NEW)}", 'state_expect': 1}
        changes.append(f'program_html (project page shows the name) -> SQL: a new project byteblaze/{name} exists.')
    elif tpl == 293:  # invite collaborators
        proj, users = INVITE[tid]
        ev = {'type': 'state', 'state_sql': (f"SELECT count(DISTINCT m.user_id) FROM members m WHERE m.source_type = 'project' "
                                             f"AND m.source_id = {pid(proj)} AND m.requested_at IS NULL AND m.user_id IN ({uids(users)})"),
              'state_expect': len(users)}
        changes.append(f'project_members page must_include {users} -> SQL: each is a member of {proj} (any role, like the '
                       'original page-text check).')
        if tid == 569:
            changes.append('"my HTML5 markup extention repo" = byteblaze/accessible-html-content-patterns ("The full HTML5 Doctor '
                           'Element Index ...").')
        if tid == 570:
            changes.append('"time tracking tool" = byteblaze/timeit; Jakub K = lahwaacz, Alex Dills = V13Axel, Alex Hutnik = alexhutnik.')
    elif tpl == 294:  # invite as guest
        user = GUEST[tid]
        ev = {'type': 'state', 'state_sql': (f"SELECT access_level FROM members WHERE source_type = 'project' AND source_id = "
                                             f"{pid('byteblaze/dotfiles')} AND user_id = {uid(user)} AND requested_at IS NULL"),
              'state_expect': 10}
        changes.append(f'gitlab_get_project_memeber_role(@{user}) == Guest -> SQL: members.access_level = 10 on byteblaze/dotfiles.')
    elif tpl == 298:  # who else has access
        proj = {349: 'byteblaze/gimmiethat.space', 350: 'byteblaze/solarized-prism-theme'}[tid]
        sql = (f"SELECT u.username FROM members m JOIN users u ON u.id = m.user_id WHERE m.source_type = 'project' AND "
               f"m.source_id = {pid(proj)} AND m.user_id <> {uid(ME)} AND m.requested_at IS NULL ORDER BY u.username")
        mode = 'exact' if 'exact_match' in refs else 'must_include'
        ev = {'type': 'answer', 'answer': {mode: refs.get('exact_match') or refs.get('must_include')}, 'answer_sql': sql}
        changes.append('Reference kept; answer_sql = the other members of the project (reports drift).')
        if tid == 350:
            changes.append('"prism-theme" = byteblaze/solarized-prism-theme.')
    elif tpl == 299:
        ev = {'type': 'url', 'url': ev0['reference_url']}
        changes.append('url_match kept: lite issue lists use GitLab\'s params (label_name[] exact title, search=); trailing '
                       'slash ignored by the grader.')
    elif tpl == 300:
        base = t['start_url'] + '/-/issues'
        ev = {'type': 'url', 'url_match': 'exact',
              'url': [base, base + '?state=opened', base + '?sort=created_date', base + '?sort=created_date&state=opened']}
        changes.append('url_match -> exact match on the open-issue list sorted newest first (no sort param = sort=created_date '
                       'default in GitLab and the lite site; state=opened is the default), so an oldest-first list fails.')
    elif tpl == 303:
        ev = {'type': 'url', 'url': ev0['reference_url']}
        changes.append('url_match kept.')
    elif tpl == 308:  # site title
        title = t['instantiation_dict']['title']
        ev = {'type': 'state', 'state_sql': (f"SELECT {ci_has('content', '<title>' + title + '</title>')} AS ok FROM repo_files WHERE "
                                             f"project_id = {pid('byteblaze/gimmiethat.space')} AND branch = 'main' AND path = 'index.html'"),
              'state_expect': 1}
        changes.append('raw index.html must_include "<title>...</title>" -> SQL on temp.repo_files (the web-edited content of '
                       'index.html on main; case-insensitive like WebArena).')
    elif tpl == 310:  # latest updated issue with keyword: closed?
        ev = {'type': ['answer', 'url'], 'answer': {'fuzzy': refs['fuzzy_match']}, 'url': ev0['reference_url']}
        changes.append('Kept: fuzzy answer (LLM judge) + url of the issue page. "My issues" = assigned to byteblaze '
                       '(GitLab\'s dashboard Issues list), latest updated.')
        if tid == 175:
            out['intent'] = intent.replace('keyword "dependency"', 'keyword "dependencies"').replace('my latest updated issue', 'my latest updated issue (assigned to me)')
        if tid == 174:
            out['intent'] = intent.replace('my latest updated issue', 'my latest updated issue (assigned to me)')
        if tid == 177:
            changes.append('Title is "Rethink the homepage\'s content" (a11yproject#719, closed); GitLab search finds it (words matched separately).')
    elif tpl == 312:
        ev = {'type': 'answer', 'answer': {'exact': refs['exact_match']},
              'answer_sql': f"SELECT feed_token FROM users WHERE id = {uid(ME)}"}
        changes.append('Reference kept; answer_sql = users.feed_token (shown at /-/profile/personal_access_tokens).')
    elif tpl == 316:
        if tid in TOP316:
            proj, br, col = TOP316[tid]
            val = '414' if tid == 786 else refs['must_include'][0]
            ev = {'type': 'answer', 'answer': {'must_include': [val]}, 'answer_sql': top_contrib(proj, br, col)}
            if tid == 786:
                out['intent'] = intent.replace('branch main', 'branch master')
            if tid == 784:
                out['intent'] = intent.replace('branch main', 'branch development')
            if tid == 785:
                out['intent'] = intent.replace('branch gh-page', 'branch gh-pages')
        elif tid == 787:
            ev = {'type': 'answer', 'answer': {'must_include': ['0']},
                  'answer_sql': (f"SELECT count(*) FROM follows WHERE followee_id = (SELECT id FROM users WHERE username = 'dehenne')")}
            changes.append('Top contributor on master = Henning Leutz (51 commits) = user dehenne, 0 followers; answer_sql counts his followers.')
        elif tid == 788:
            ev = {'type': 'answer', 'answer': {'must_include': refs['must_include']}}
            changes.append('Top contributor on php52 = Andrew M. Whalen <github@amwhalen.com> (14 commits) = user amwhalen, '
                           'location Massachusetts (checked by SQL on contributors + users).')
        changes.append('Contributors page = contributors.commits for the branch (GitLab 15.7 semantics).')
    elif tpl in (320, 321, 322):
        proj, where, note = COMMITS[tid]
        val = refs['must_include'][0]
        ev = {'type': 'answer', 'answer': {'must_include': [val]}, 'answer_sql': commits_sql(proj, where)}
        changes.append(f'Reference kept; answer_sql counts commits on the default branch of {proj} by UTC committed date.')
        if note:
            changes.append(note)
        if tid == 307:
            out['intent'] = intent.replace('April 2021', 'April 2022')
        if tpl == 322:
            changes.append('"a11yproject" = a11yproject/a11yproject.com.') if tid != 136 else None
    elif tpl == 323:
        proj = TOP323[tid]
        br_sql = f"(SELECT default_branch FROM projects WHERE id = {pid(proj)})"
        ev = {'type': 'answer', 'answer': {'exact': refs['exact_match']},
              'answer_sql': f"SELECT author_name FROM contributors WHERE project_id = {pid(proj)} AND branch = {br_sql} ORDER BY commits DESC, author_email LIMIT 1"}
        changes.append(f'Reference kept; answer_sql = top contributor of {proj} (default branch, Contributors page).')
    elif tpl == 324:
        if tid == 317:
            ev = {'type': 'answer', 'answer': {'must_include': ['Susan Zhang', '70', 'Stephen Roller', '51', 'Peter Albert |OR| Zachary DeVito', '12']},
                  'answer_sql': top_contrib('root/metaseq', 'main', "author_name || ': ' || commits", 4)}
        else:
            proj, col = TOP324[tid]
            br_sql = f"(SELECT default_branch FROM projects WHERE id = {pid(proj)})"
            ev = {'type': 'answer', 'answer': {'must_include': refs['must_include']},
                  'answer_sql': f"SELECT {col} FROM contributors WHERE project_id = {pid(proj)} AND branch = {br_sql} ORDER BY commits DESC, author_email LIMIT 3"}
            changes.append(f'Reference kept; answer_sql = top 3 of {proj} on the default branch (reports drift).')
        if tid == 314:
            changes.append('"prime/design" = primer/design.')
        if tid == 316:
            changes.append('"facebook\'s guide on building react apps" = facebook/create-react-app; reference "Joe Hadda" is a '
                           'prefix of "Joe Haddad" (must_include passes either).')
        if tid == 318:
            changes.append('Top 3 on master: Louis Lo, Stimim Chen, Owen Chu.')
    elif tpl == 325:
        ev = {'type': 'url', 'url': ['__GITLAB__/explore', '__GITLAB__/explore/projects']}
        changes.append('Reference /explore; the lite /explore shows (or redirects to) /explore/projects, the "All" public '
                       'project list -- both accepted.')
    elif tpl == 327:  # create issue with assignee + due date
        proj, who, due = ISSUE327[tid]
        title = ev0['program_html'][0]['required_contents']['exact_match']
        ev = {'type': 'state', 'state_sql': (
            f"SELECT (lower(trim(i.title)) = lower({lit(title)}) AND i.due_date = {lit(due)} AND EXISTS (SELECT 1 FROM issue_assignees a "
            f"WHERE a.issue_id = i.id AND a.user_id = {uid(who)})) AS ok, i.iid, i.title, i.due_date FROM issues i WHERE i.project_id = "
            f"{pid(proj)} AND i.author_id = {uid(ME)} AND i.created_at >= {lit(NEW)} ORDER BY i.id DESC LIMIT 1"), 'state_expect': 1}
        changes.append(f'Issue page title/due date/assignee checks -> SQL: byteblaze\'s newest new issue in {proj} has the title '
                       f'(trimmed, case-insensitive), due_date {due} and @{who} among its assignees. The url_match on the issue '
                       'list ("GOLD in PRED") is dropped: the SQL check covers it.')
        if tid == 660:
            changes.append('WebArena\'s reference_url was the repository tree (/byteblaze/dotfiles/-/tree/main), not an issue page.')
    elif tpl == 328:  # open an issue mentioning X
        if tid == 789:
            ev = {'type': 'answer', 'answer': {'fuzzy': 'N/A'}}
            changes.append('Kept fuzzy "N/A" (LLM judge): there is no huggingface dataset repository on the site.')
        else:
            proj = ISSUE328[tid]
            needle = ev0['program_html'][0]['required_contents']['must_include'][0]
            text = "i.title || ' ' || coalesce(i.description, '')"
            ev = {'type': 'state', 'state_sql': (
                f"SELECT ({ci_has(text, needle)}) AS ok, i.iid, i.title FROM issues i WHERE i.project_id = {pid(proj)} AND i.author_id = "
                f"{uid(ME)} AND i.created_at >= {lit(NEW)} ORDER BY i.id DESC LIMIT 1"), 'state_expect': 1}
            changes.append(f'.detail-page-description (title + description in GitLab 15.7) must_include "{needle}" -> SQL: '
                           f'byteblaze\'s newest new issue in {proj} contains it in title or description (case-insensitive). '
                           'url_match on the issue list dropped (covered by the SQL check).')
    elif tpl == 329:
        proj = CLONE[tid]
        sql = f"SELECT 'git clone ' || (SELECT value FROM site_settings WHERE key = 'ssh_clone_prefix') || full_path || '.git' FROM projects WHERE id = {pid(proj)}"
        if tid in (296, 297):
            ev = {'type': 'answer', 'answer': {'must_include': [refs['exact_match']]}, 'answer_sql': sql.replace("'git clone ' || ", '')}
        else:
            ev = {'type': 'answer', 'answer': {'exact': refs['exact_match']}, 'answer_sql': sql}
            changes.append('Reference kept; answer_sql builds the command from site_settings.ssh_clone_prefix (clone URL shown on the project page).')
        if tid == 296:
            changes.append('"the best GAN python implementation" = eriklindernoren/PyTorch-GAN.')
    elif tpl == 330:  # follow users
        users = FOLLOW[tid]
        ev = {'type': 'state', 'state_sql': (f"SELECT count(*) FROM follows WHERE follower_id = {uid(ME)} AND followee_id IN ({uids(users)})"),
              'state_expect': len(users)}
        changes.append(f'/users/byteblaze/following must_include {["@" + u for u in users]} -> SQL: follows rows for each.')
        if tid in (535, 537):
            changes.append('"Jakub K" / "Jakub Klinkovsk" = lahwaacz (Jakub Klinkovský).')
    else:
        raise SystemExit(f'unhandled task {tid} template {tpl}')

    if tid in FIXES:
        changes.append(FIXES[tid])
    out['eval'] = ev
    out['changes'] = changes
    out['status'] = 'verified'
    out['drop_reason'] = None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=SRC)
    ap.add_argument('--out', default=os.path.join(HERE, 'webarena-a.jsonl'))
    ap.add_argument('--status', default=os.path.join(HERE, 'verify-a.jsonl'), help='verify log; tasks without an ok run are written as "unverified"')
    a = ap.parse_args()
    with open(a.src) as f:
        src = [t for t in json.load(f) if t['sites'] == ['gitlab'] and t['intent_template_id'] in TEMPLATES]
    ok = {}
    if os.path.exists(a.status):
        with open(a.status) as f:
            for line in f:
                if line.strip():
                    v = json.loads(line)
                    if not v.get('negative'):
                        ok[v['task_id']] = v['ok']  # last positive run wins
    tasks = [convert(t) for t in sorted(src, key=lambda t: (t['intent_template_id'], t['task_id']))]
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
