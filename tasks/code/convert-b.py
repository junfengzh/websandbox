#!/usr/bin/env python3
"""Convert WebArena gitlab-only tasks (part b) to the code hosting lite site.

    python3 -I tasks/code/convert-b.py [--src .../test.raw.json] [--out tasks/code/webarena-b.jsonl]

Scope: `sites == ["gitlab"]` and intent_template_id NOT in EXCLUDED (those are part a,
tasks/code/*-a.*). 87 tasks. Evaluators (docs/CONVENTIONS.md "WebArena tasks"):
string_match -> answer (+ answer_sql where data-derived); url_match -> url (GitLab URL scheme kept);
program_html -> state_sql/state_expect on the tenant DB (notes, issue_assignees, members,
user_statuses, users.website_url, stars, projects/forks, milestones, merge_requests + mr_reviewers,
issues, namespaces, temp.repo_files for web-edited files). Every task was run through the UI
with tasks/tools/browse.js and graded with tasks/tools/grade.js (verify-b.jsonl).
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get('WEBARENA_TASKS', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '3rd-party', 'webarena', 'config_files', 'test.raw.json'))
EXCLUDED = {289, 290, 291, 292, 293, 294, 298, 299, 300, 303, 308, 310, 312, 316, 320, 321, 322, 323, 324,
            325, 327, 328, 329, 330}
ME = 'byteblaze'  # WebArena's gitlab storage_state user
# The imported data ends 2023-04-24 (members) / 2023-03-27 (everything else); the site clock starts
# 2023-04-27 16:00 UTC, so rows created by a rollout have created_at >= BASE_END.
BASE_END = '2023-04-27'


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def uid(name):
    return f'(SELECT id FROM users WHERE username = {lit(name)})'


def pid(full_path):
    return f'(SELECT id FROM projects WHERE full_path = {lit(full_path)})'


ME_ID = uid(ME)
TD = "title || ' ' || coalesce(description, '')"
ME_NS = f"(SELECT id FROM namespaces WHERE kind = 'user' AND owner_id = {ME_ID})"


def has_all(expr, needles):
    """SQL: expr contains every needle (case-insensitive, like WebArena's cleaned must_include)."""
    return '(' + ' AND '.join(f'instr(lower({expr}), lower({lit(n)})) > 0' for n in needles) + ')'


def squash(expr):
    """SQL: lower(expr) with all whitespace removed (line breaks in a license text must not matter)."""
    return f"replace(replace(replace(replace(lower({expr}), ' ', ''), char(10), ''), char(13), ''), char(9), '')"


def has_all_ws(expr, needles):
    """has_all, ignoring whitespace (needles are compared with their whitespace removed too)."""
    return '(' + ' AND '.join(f"instr({squash(expr)}, {lit(''.join(n.lower().split()))}) > 0" for n in needles) + ')'


def ulist(names):
    return '(' + ', '.join(uid(n) for n in names) + ')'


# ---------------------------------------------------------------- per-template data
LABELS = {  # 349: repo, label title (exact, as GitLab's label filter)
    102: ('a11yproject/a11yproject.com', 'help wanted'),
    103: ('kkroening/ffmpeg-python', 'question'),
    104: ('keycloak/keycloak', 'flaky-test'),
    105: ('OpenAPITools/openapi-generator', 'OpenAPI Generator CLI'),
    106: ('umano/AndroidSlidingUpPanel', 'BUG'),
}
LATEST_ISSUE = {  # 500: accepted issue URLs (project, iid), issue id for answer_sql, answer
    178: ([('a11yproject/a11yproject.com', 1057)], 83572, 'Yes'),
    179: ([('byteblaze/a11y-webring.club', 39)], 83747, 'No'),
    180: ([('byteblaze/empathy-prompts', 18), ('a11yproject/a11yproject.com', 989)], 83733, 'No'),
    181: ([('byteblaze/a11y-syntax-highlighting', 1)], 83756, 'No'),
    182: ([('a11yproject/a11yproject.com', 719)], 83395, 'Yes'),
}
MR_NOTE = {  # 348 / 360: merge request ids (any of), text, mode
    389: ([139245], 'Thanks, working on reviews', 'include'),
    390: ([72594], 'lgtm', 'exact'),
    391: ([72404], 'close because non reproducible', 'exact'),
    392: ([72135, 72123], 'Good idea', 'exact'),
    393: ([138843], 'lgtm', 'exact'),
    415: ([138783], '@davepgreene', 'exact'),
    416: ([72409], 'Thank you', 'exact'),
    417: ([72560], '@Roshanjossey', 'exact'),
}
FORKS = {  # 352: source project ids that must be forked into byteblaze's namespace / must not be
    394: ([79], []), 395: ([86], []), 396: ([175], []), 397: ([33], []),
    398: ([163, 159, 170], [165, 164]),
    522: ([60, 122], []),
}
FORK_NAMES = {79: 'yjlou/2019-nCov', 86: 'eriklindernoren/PyTorch-GAN', 175: 'convexegg/chatgpt', 33: 'root/metaseq',
              163: 'aklsh/SimCache', 159: 'aklsh/dots', 170: 'aklsh/CacheEval', 165: 'aklsh/nvidia-patch',
              164: 'aklsh/viewgrades-scraper', 60: 'facebook/buck', 122: 'facebook/create-react-app'}
MIT = ['MIT license', 'The above copyright notice and this permission notice shall be included in all copies or '
       'substantial portions of the Software.']
LICENSE = {  # 355: [(project, branch, path, needles, already_ok_without_edit)]
    411: [('byteblaze/cloud-to-butt', 'master', 'LICENSE.txt', ['MIT license'], 0)],
    412: [('byteblaze/accessible-html-content-patterns', 'main', 'LICENSE', ['Apache License', 'apache.org/licenses/LICENSE-2.0'], 0)],
    413: [('byteblaze/a11y-syntax-highlighting', 'main', 'LICENSE', ['GENERAL PUBLIC LICENSE'], 0)],
    414: [('byteblaze/dotfiles', 'main', 'LICENSE', MIT, 0)],
    736: [('byteblaze/gimmiethat.space', 'main', 'LICENSE', MIT, 1), ('byteblaze/dotfiles', 'main', 'LICENSE', MIT, 0)],
}
ASSIGN = {  # 999: [(issue ids, username)]
    446: [([83677], 'Roshanjossey')],
    447: [([83751], 'Seirdy')],
    804: [([83759, 83787], ME), ([83759, 83787], 'primer')],
    810: [([83759, 83787], ME)],
    811: [([83677], ME)],
}
TOP_STARRED = [152, 122, 133, 99, 145, 86, 113, 143]  # star_count 55, 52, 51, 47, 46, 45, 44, 43 (9th: 42)
STAR_N = {523: 5, 524: 8, 525: 4, 526: 3, 527: 1}
ADD_MEMBERS = {  # 351: project, users, access level
    576: ('byteblaze/a11y-webring.club', ['abisubramanya27', 'lahwaacz'], 30),
    577: ('byteblaze/remove-board-movement-events-from-the-github-issue-timeline', ['abisubramanya27', 'lahwaacz'], 40),
    578: ('byteblaze/millennials-to-snake-people', ['yjlou', 'a11yproject'], 20),
    579: ('byteblaze/timeit', ['yjlou'], 10),
}
MILESTONE = {  # 339: project, keyword, start, due
    590: ('primer/design', 'product launch', '2030-01-16', '2030-01-30'),
    591: ('primer/design', 'code review', '2030-01-16', '2030-02-05'),
    592: ('primer/design', 'sensitive information', '2030-02-16', '2030-03-08'),
    593: ('byteblaze/dotfiles', 'all branches to main', '2044-03-15', '2044-03-30'),
    594: ('byteblaze/dotfiles', 'zsh comprehensive support', '2044-05-01', '2044-05-21'),
}
NEW_MR = {  # 335: project, source branch, target branch, reviewers
    666: ('primer/design', 'dialog-component', 'dialog', ['scarol8']),
    667: ('primer/design', 'dialog-component', 'bump-doctocat', ['primer']),
    668: ('a11yproject/a11yproject.com', 'redesign', 'main', ['justinmeister']),
    805: ('a11yproject/a11yproject.com', 'feature/replace-gulp', 'main', [ME, 'Roshanjossey']),
    806: ('a11yproject/a11yproject.com', 'redesign', 'feature/markdown-figure-block', [ME]),
    807: ('primer/design', 'debug-build-time', 'main', [ME]),
}
NEW_ISSUE = {  # 337
    669: ('byteblaze/solarized-prism-theme', ['implementation', 'dark mode']),
    670: ('byteblaze/dotfiles', ['implementation', 'default plugins', 'zsh']),
}
NEW_PROJECT = {  # 332 / 2100: path, visibility, kind (None = don't care | 'blank' | template names), members
    742: ('planner', 'private', None, ['abisubramanya27', 'vinta']),
    743: ('web_arena', 'public', None, ['abisubramanya27', 'vinta']),
    744: ('AutoAGI', 'public', None, ['primer']),
    745: ('awesome-llms', 'public', None, ['primer', 'convexegg', 'abisubramanya27']),
    746: ('llm_bulk_inference', 'private', None, ['primer', 'convexegg', 'abisubramanya27']),
    747: ('awesome_web_agents', 'private', 'blank', ['abisubramanya27', 'vinta']),
    748: ('web_agent_android_xl', 'private', ['android'], ['primer', 'convexegg', 'abisubramanya27']),
    749: ('project_site', 'private', ['express'], ['primer', 'convexegg', 'vinta']),
    750: ('agi_index', 'private', ['plainhtml', 'nfplainhtml'], ['vinta']),
    751: ('AGISite', 'private', ['jekyll', 'nfjekyll'], ['Seirdy', 'vinta']),
    752: ('web_agent', 'private', 'blank', []),
    753: ('web_agent_android_xs', 'private', ['android'], []),
    754: ('web_agent_nodejs', 'private', ['express'], []),
    755: ('web_agent_index', 'private', ['plainhtml', 'nfplainhtml'], []),
    756: ('11711_gitlab', 'private', ['jekyll', 'nfjekyll'], []),
}
NEW_GROUP = {  # 600
    799: ('n-lab', ['patou', 'egpast', 'westurner', 'jontutcher']),
    800: ('x-lab', ['JonasVautherin', 'dilipchandima', 'dawiss1337', 'bmyun', 'DCMJY']),
    801: ('crew', ['ASWATFZLLC', 'patrickhlauke', 'westurner', 'linkmatrix']),
    802: ('coding_friends', ['qhduan', 'Agnes-U']),
    803: ('webagent', ['pandey2000', 'sayakpaul']),
}
INTENT_FIX = {
    181: ('Open the latest created issue in my repositories that has theme editor in its title to check if it is closed',
          'byteblaze authored no issue with "theme editor" in its title; the WebArena reference is '
          'byteblaze/a11y-syntax-highlighting#1 "Tm Theme Editor" (by earlev4, in byteblaze\'s repo): intent changed from '
          '"my latest created issue" to "the latest created issue in my repositories".'),
    590: ('Create a milestone for the upcoming event of product launch starting on 1/16/2030 and ending on 1/30/2030',
          'Intent dates 1/16/2023-1/30/2023 contradict the WebArena reference (Jan 16, 2030 - Jan 30, 2030) and are not '
          '"upcoming" (site clock 2023-04-27): intent year changed to 2030.'),
    591: ('Create a milestone for the upcoming practice of collective code review starting on 1/16/2030 and ending on in 20 days',
          'Intent start 1/16/2023 contradicts the WebArena reference (Jan 16, 2030 - Feb 5, 2030): intent year changed to 2030.'),
    592: ('Create a milestone for the upcoming task of cleaning sensitive information starting on 2/16/2030 and ending on in 20 days',
          'Intent start 2/16/2023 contradicts the WebArena reference (Feb 16, 2030 - Mar 8, 2030): intent year changed to 2030.'),
    668: ('Submit a merge request for a11yproject.com/redesign branch to be merged into main branch, assign Justin Armstrong as the reviewer',
          'a11yproject.com has no master branch (default branch main; the WebArena reference checks target "main"): '
          'intent "master" -> "main".'),
    805: ('Submit a merge request for the branch that implements the support of template strings to be merged into main branch, '
          'assign myself and Roshan as the reviewer',
          'a11yproject.com has no master branch (the WebArena reference checks target "main"): intent "master" -> "main".'),
}


def gl(path):
    return '__GITLAB__' + path


def convert(t):
    tid = t['task_id']
    ev0 = t['eval']
    tpl = t['intent_template_id']
    intent = t['intent']
    changes = []
    if tid in INTENT_FIX:
        intent, why = INTENT_FIX[tid]
        changes.append(why)
    out = {
        'task_id': tid, 'site': 'gitlab', 'intent': intent, 'intent_template': t['intent_template'],
        'intent_template_id': tpl, 'instantiation_dict': t.get('instantiation_dict'),
        'start_url': t['start_url'], 'require_login': True, 'login_user': ME,
    }
    ev = {}

    if tpl == 349:  # issue list filtered by a label
        repo, label = LABELS[tid]
        from urllib.parse import quote
        ev = {'type': 'url', 'url': gl(f'/{repo}/-/issues?label_name%5B%5D={quote(label)}')}
        changes.append('url_match kept (GitLab URL scheme; kit grader: path equal, reference params a subset).')
        if tid == 102:
            changes.append('WebArena reference URL pointed at byteblaze/a11y-syntax-highlighting (0 issues with the label), '
                           'not the repository the intent names; corrected to a11yproject/a11yproject.com label "help wanted" '
                           '(33 open issues).')
    elif tpl == 500:  # latest own issue with keyword: open it, answer closed?
        urls, iid_row, ans = LATEST_ISSUE[tid]
        ev = {'type': ['answer', 'url'], 'answer': {'exact': ans},
              'answer_sql': f"SELECT CASE state WHEN 'closed' THEN 'Yes' ELSE 'No' END FROM issues WHERE id = {iid_row}",
              'url': [gl(f'/{p}/-/issues/{i}') for p, i in urls]}
        ref = ev0['reference_url'].replace('__GITLAB__', '')
        if tid == 178:
            changes.append(f'Reference URL {ref} (#566 "Better Event page UX", 2017) is not the latest: byteblaze\'s latest issue '
                           'with "better" in the title is a11yproject.com#1057 "Add better form validation ..." (2020-08-12, '
                           'closed); URL corrected, answer unchanged (Yes).')
        elif tid == 179:
            changes.append(f'Reference {ref} (#1517 "Deprecate GitHub Discussions") has no "feature" in its title (only in the '
                           'description). byteblaze\'s latest issue with "feature" in the title is a11y-webring.club#39 '
                           '"[Feature suggestion] WCAG trash panda mode" (2023-01-22, open): URL corrected and answer '
                           '"Yes" -> "No".')
        elif tid == 180:
            changes.append('Kept reference empathy-prompts#18 "Outdated dependencies" (2021-06-02, open); also accepts '
                           'a11yproject.com#989 "Remove Gulp as a dependency" (the latest whose title contains the literal '
                           'word, open). Both give "No".')
        elif tid == 181:
            changes.append('Answer "No" (issue open) unchanged.')
        else:
            changes.append('Issue #719 is titled "Rethink the homepage\'s content" (search tolerates the possessive).')
        changes.append('answer_sql gives the issue state for drift checks.')
    elif tpl in (348, 360):  # comment on an MR (360: "Thank you" vs @author decided by the data)
        mrs, text, mode = MR_NOTE[tid]
        cond = (f"lower(trim(n.body)) = lower({lit(text)})" if mode == 'exact' else has_all('n.body', [text]))
        mrl = ', '.join(str(i) for i in mrs)
        ev = {'type': 'state',
              'state_sql': (f"SELECT max(ok) AS ok FROM (SELECT (SELECT n.author_id = {ME_ID} AND {cond} FROM notes n "
                            f"WHERE n.noteable_type = 'merge_request' AND n.noteable_id = m.id AND n.system = 0 "
                            f"ORDER BY n.id DESC LIMIT 1) AS ok FROM merge_requests m WHERE m.id IN ({mrl}))"),
              'state_expect': 1}
        changes.append('program_html on the MR page (last .timeline-discussion-body) -> SQL: the newest non-system note on the '
                       f'MR is by {ME} and its text {"equals (trimmed, case-insensitive)" if mode == "exact" else "contains"} '
                       f'"{text}".')
        if tid == 392:
            changes.append('"color utility" matches two MRs titled "Add color utility classes" (!1071 open = WebArena\'s '
                           'reference, !1053 merged); either is accepted.')
        if tpl == 360:
            changes.append('"MR I have to review" = open MRs assigned to byteblaze (a11y-webring.club!40, a11yproject.com!1270, '
                           '!1485). Expected reply checked against the data: '
                           + {415: '!40 has no comment by its author davepgreene -> "@davepgreene".',
                              416: '!1270: the last user comment is by its author aguscha333 -> "Thank you".',
                              417: '!1485 has no comment by its author Roshanjossey -> "@Roshanjossey".'}[tid])
    elif tpl == 352:  # forks
        want, never = FORKS[tid]
        sqls, exps = [], []
        for s in want:
            sqls.append(f"SELECT count(*) FROM projects WHERE namespace_id = {ME_NS} AND forked_from_id = {s}")
            exps.append({'min': 1})
        for s in never:
            sqls.append(f"SELECT count(*) FROM projects WHERE namespace_id = {ME_NS} AND (forked_from_id = {s} OR lower(path) = "
                        f"lower((SELECT path FROM projects WHERE id = {s})))")
            exps.append(0)
        ev = {'type': 'state', 'state_sql': sqls, 'state_expect': exps}
        changes.append('program_html (byteblaze/<repo> page shows the name) -> SQL: a project in byteblaze\'s namespace with '
                       'forked_from_id = ' + ', '.join(f'{s} ({FORK_NAMES[s]})' for s in want) + ' (any path).')
        if never:
            changes.append('Akilesh Kannan = aklsh; "source repos" = his non-fork projects SimCache, dots, CacheEval; his forks '
                           'nvidia-patch and viewgrades-scraper must NOT be forked (WebArena: those pages 404).')
        if tid == 522:
            changes.append('facebook\'s repos: facebook/buck and facebook/create-react-app.')
    elif tpl == 355:  # LICENSE edits
        sqls, exps = [], []
        for proj, br, path, needles, already in LICENSE[tid]:
            sqls.append(f"SELECT CASE WHEN rf.project_id IS NULL THEN {already} ELSE (rf.content IS NOT NULL AND "
                        f"{has_all_ws('rf.content', needles)}) END AS ok FROM (SELECT 1) LEFT JOIN repo_files rf ON "
                        f"rf.project_id = {pid(proj)} AND rf.branch = {lit(br)} AND rf.path = {lit(path)}")
            exps.append(1)
        if tid == 413:
            sqls[0] = sqls[0].replace(' END AS ok', " AND instr(lower(rf.content), 'lesser general public license') = 0 END AS ok")
        ev = {'type': 'state', 'state_sql': sqls if len(sqls) > 1 else sqls[0], 'state_expect': exps if len(exps) > 1 else exps[0]}
        changes.append('program_html on the blob page -> SQL on temp.repo_files (current content of files written by web '
                       'commits; no row = file unchanged since the import), needles case- and whitespace-insensitive (the standard MIT '
                       'text breaks "included in all / copies" over two lines).')
        if tid == 412:
            changes.append('URL needle relaxed to "apache.org/licenses/LICENSE-2.0" (http or https).')
        if tid == 413:
            changes.append('"mandates all copies and derivative works under the same license" = GPL (AGPL also contains '
                           'the needle); the LGPL ("LESSER GENERAL PUBLIC LICENSE") is not accepted.')
        if tid == 414:
            changes.append('byteblaze/dotfiles has no LICENSE in the source: the task creates it.')
        if tid == 736:
            changes.append('gimmiethat.space\'s LICENSE is already MIT (passes unless changed); dotfiles has none (must be '
                           'created).')
    elif tpl == 361:  # status
        status = t['instantiation_dict']['status']
        cond = f"lower(trim(coalesce(s.message, ''))) = lower({lit(status)})"
        if status.lower() == 'busy':
            cond = f"({cond} OR (s.availability = 'busy' AND trim(coalesce(s.message, '')) = ''))"
        ev = {'type': 'state',
              'state_sql': f"SELECT coalesce({cond}, 0) AS ok, s.message, s.availability FROM users u LEFT JOIN user_statuses s "
                           f"ON s.user_id = u.id WHERE u.id = {ME_ID}",
              'state_expect': 1}
        changes.append('program_html (.cover-status text on the profile) -> SQL: user_statuses.message equals the status '
                       '(trimmed, case-insensitive).' + (' "Busy" also passes as the "Set yourself as busy" availability '
                                                        'with an empty message.' if status.lower() == 'busy' else ''))
    elif tpl == 999:  # assign issues
        sqls, exps = [], []
        for ids, user in ASSIGN[tid]:
            idl = ', '.join(str(i) for i in ids)
            sqls.append(f"SELECT count(*) FROM issue_assignees a JOIN issues i ON i.id = a.issue_id WHERE i.state = 'opened' "
                        f"AND a.issue_id IN ({idl}) AND a.user_id = {uid(user)}")
            exps.append(len(ids))
        ev = {'type': 'state', 'state_sql': sqls if len(sqls) > 1 else sqls[0], 'state_expect': exps if len(exps) > 1 else exps[0]}
        changes.append('program_html (dashboard issue list filtered by assignee shows the title) -> SQL: issue_assignees rows '
                       'on the open issue(s) ' + ', '.join(str(i) for i in ASSIGN[tid][0][0]) + ' for '
                       + ', '.join(u for _, u in ASSIGN[tid]) + '.')
        if tid in (446, 811):
            changes.append('"issue regarding 404 in a11yproject" = a11yproject.com#1478 "[Bug] 404s, bad host, timeouts, bad '
                           'urls for URLs linked from website" (the only open issue with 404 in its title).')
        if tid == 447:
            changes.append('Rohan = Seirdy (Rohan Kumar); issue a11y-webring.club#71.')
        if tid in (804, 810):
            changes.append('"flash alert(s)" = two open primer/design issues (#104, #316), both required (as WebArena).')
    elif tpl == 331:  # profile website
        want = ev0['program_html'][0]['required_contents']['exact_match']
        ev = {'type': 'state',
              'state_sql': f"SELECT lower(rtrim(replace(replace(trim(coalesce(website_url, '')), 'https://', ''), 'http://', ''), '/')) "
                           f"AS shown FROM users WHERE id = {ME_ID}",
              'state_expect': want}
        changes.append('program_html (profile header link text, scheme stripped) -> SQL: users.website_url without '
                       f'http(s):// and trailing slash = "{want}".')
    elif tpl == 354:  # star top N
        n = STAR_N[tid]
        ids = TOP_STARRED[:n]
        ev = {'type': 'state',
              'state_sql': f"SELECT count(*) FROM stars WHERE user_id = {ME_ID} AND project_id IN ({', '.join(map(str, ids))})",
              'state_expect': n}
        changes.append(f'program_html (/users/byteblaze/starred lists the names) -> SQL: stars rows of byteblaze on the top {n} '
                       f'projects by star_count (fixed ids {ids}; no ties within the top 8: 55,52,51,47,46,45,44,43, 9th 42). '
                       'Matches the WebArena reference names.')
    elif tpl == 351 and tid in ADD_MEMBERS:
        proj, users, lvl = ADD_MEMBERS[tid]
        ev = {'type': 'state',
              'state_sql': f"SELECT u.username, m.access_level FROM members m JOIN users u ON u.id = m.user_id WHERE m.source_type = "
                           f"'project' AND m.source_id = {pid(proj)} AND m.requested_at IS NULL AND u.username IN "
                           f"({', '.join(lit(x) for x in users)})",
              'state_expect': [[x, lvl] for x in users]}
        changes.append(f'program_html (role on the members page) -> SQL: members rows of {proj} for {", ".join(users)} with '
                       f'access_level {lvl}.')
        if tid == 577:
            changes.append('"GitHub timeline item management extension" = byteblaze/remove-board-movement-events-from-the-github-issue-timeline.')
        if tid == 579:
            changes.append('"my time tracking tool" = byteblaze/timeit.')
        if tid == 578:
            changes.append('a11yproject is a user (The A11Y Project) on this instance.')
    elif tpl == 351:  # 783: not permitted
        ev = {'type': ['answer', 'state'], 'answer': {'fuzzy': 'N/A'},
              'state_sql': f"SELECT count(*) FROM members WHERE source_type = 'project' AND source_id = {pid('kkroening/ffmpeg-python')} "
                           f"AND user_id IN {ulist(['yjlou', 'a11yproject'])}",
              'state_expect': 0}
        changes.append('Kept fuzzy "N/A" (LLM judge): ' + ev0.get('string_note', '') + '. Added a state check that neither user '
                       'became a member (byteblaze is not a member of kkroening/ffmpeg-python; the site refuses with 403).')
    elif tpl == 339:  # milestones
        proj, kw, start, due = MILESTONE[tid]
        ev = {'type': ['url', 'state'], 'url': f'__GITLAB__/{proj}/-/milestones', 'url_match': 'prefix',
              'state_sql': f"SELECT count(*) FROM milestones WHERE project_id = {pid(proj)} AND created_at >= '{BASE_END}' AND "
                           f"{has_all(TD, [kw])} "
                           f"AND start_date = '{start}' AND due_date = '{due}'",
              'state_expect': {'min': 1}}
        changes.append(f'program_html on the new milestone page -> SQL: a new milestone of {proj} whose title/description '
                       f'contains "{kw}" with start {start} and due {due}.')
        changes.append(f"regrade 2026-11-15: WebArena's url_match (\"GOLD in PRED\") restored as url_match 'prefix' (final URL at or below /{proj}/-/milestones); it had been dropped while the kit grader had no prefix mode.")
    elif tpl == 335:  # new MR with reviewers
        proj, src, dst, revs = NEW_MR[tid]
        ev = {'type': ['url', 'state'], 'url': f'__GITLAB__/{proj}/-/merge_requests', 'url_match': 'prefix',
              'state_sql': f"SELECT count(*) FROM merge_requests m WHERE m.project_id = {pid(proj)} AND m.source_project_id = m.project_id "
                           f"AND m.state = 'opened' AND m.source_branch = "
                           f"{lit(src)} AND m.target_branch = {lit(dst)} AND (SELECT count(*) FROM mr_reviewers r WHERE "
                           f"r.merge_request_id = m.id AND r.user_id IN {ulist(revs)}) = {len(revs)}",
              'state_expect': {'min': 1}}
        changes.append(f'program_html on the MR page (source/target branch, reviewer block) -> SQL: an open MR in '
                       f'{proj} from {src} into {dst} with reviewer(s) {", ".join(revs)}.')
        changes.append(f"regrade 2026-11-15: WebArena's url_match (\"GOLD in PRED\") restored as url_match 'prefix' (final URL at or below /{proj}/-/merge_requests); it had been dropped while the kit grader had no prefix mode.")
        if tid in (805, 807):
            changes.append({805: 'a11yproject.com!1141 (esjay) is already open from feature/replace-gulp into main', 807: 'primer/design!390 '
                            '(colebemis) is already open from debug-build-time into main'}[tid] + '; GitLab refuses a second open MR for the '
                            'same branches ("Another open merge request already exists"), so the task is done by setting the reviewer(s) '
                            'on that MR (what WebArena\'s page check accepts too). The check therefore takes any open MR for the branch pair.')
        if tid == 666:
            changes.append('Carol = scarol8 (Caroline Stewart).')
        if tid == 668:
            changes.append('Justin Armstrong = justinmeister.')
        if tid == 805:
            changes.append('"branch that implements the support of template strings" = feature/replace-gulp (head commit '
                           '"upgrade node version to allow use of template strings"); Roshan = Roshanjossey.')
    elif tpl == 337:  # new issue
        proj, needles = NEW_ISSUE[tid]
        ev = {'type': ['url', 'state'], 'url': f'__GITLAB__/{proj}/-/issues', 'url_match': 'prefix',
              'state_sql': f"SELECT count(*) FROM issues WHERE project_id = {pid(proj)} AND author_id = {ME_ID} AND created_at >= "
                           f"'{BASE_END}' AND {has_all(TD, needles)}",
              'state_expect': {'min': 1}}
        changes.append(f'program_html (.detail-page-description = title + description) -> SQL: a new issue by byteblaze in '
                       f'{proj} whose title/description contains {", ".join(needles)} (case-insensitive).')
        changes.append(f"regrade 2026-11-15: WebArena's url_match (\"GOLD in PRED\") restored as url_match 'prefix' (final URL at or below /{proj}/-/issues); it had been dropped while the kit grader had no prefix mode.")
    elif tpl in (332, 2100):  # new project
        path, vis, kind, members = NEW_PROJECT[tid]
        fp = f'byteblaze/{path}'
        sqls = [f"SELECT visibility FROM projects WHERE full_path = {lit(fp)}"]
        exps = [vis]
        desc = [f'project {fp} exists with visibility {vis}']
        if kind == 'blank':
            sqls.append(f"SELECT count(*) FROM projects p JOIN project_commits pc ON pc.project_id = p.id JOIN commits c ON c.id = "
                        f"pc.commit_id WHERE p.full_path = {lit(fp)} AND p.template_name IS NULL AND c.title = 'Initial commit'")
            exps.append({'min': 1})
            desc.append('blank (no template) with an "Initial commit" (initialised with a README)')
        elif kind:
            sqls.append(f"SELECT template_name FROM projects WHERE full_path = {lit(fp)} AND template_name IN ({', '.join(lit(k) for k in kind)})")
            exps.append({'count': 1})
            desc.append('created from template ' + ' or '.join(kind))
        if members:
            sqls.append(f"SELECT count(DISTINCT m.user_id) FROM members m WHERE m.source_type = 'project' AND m.source_id = {pid(fp)} "
                        f"AND m.requested_at IS NULL AND m.user_id IN {ulist(members)}")
            exps.append(len(members))
            desc.append('members ' + ', '.join(members) + ' (any role)')
        ev = {'type': 'state', 'state_sql': sqls, 'state_expect': exps}
        changes.append('program_html (visibility icon, commits page, members page, description) -> SQL: ' + '; '.join(desc) + '.')
        if kind and kind != 'blank' and ('plainhtml' in kind or 'jekyll' in kind):
            changes.append('WebArena read the template\'s project description; here the template is recorded in '
                           'projects.template_name (GitLab Pages/Plain HTML or its Netlify variant, resp. Pages/Jekyll or Netlify/Jekyll).')
        if kind and kind != 'blank' and ('android' in kind or 'express' in kind):
            changes.append('WebArena looked for the template\'s commit "Initialized from \'...\' project template"; here '
                           'projects.template_name.')
        if any(m in members for m in ('abisubramanya27', 'Seirdy')):
            changes.append('Abishek = abisubramanya27 (Abishek S); Vinta = vinta; Rohan = Seirdy (Rohan Kumar).')
    elif tpl == 600:  # new group with members
        path, users = NEW_GROUP[tid]
        ev = {'type': 'state',
              'state_sql': [f"SELECT count(*) FROM namespaces WHERE kind = 'group' AND lower(path) = lower({lit(path)}) AND created_at >= '{BASE_END}'",
                            f"SELECT count(DISTINCT m.user_id) FROM members m JOIN namespaces n ON n.id = m.source_id WHERE m.source_type = "
                            f"'namespace' AND n.kind = 'group' AND lower(n.path) = lower({lit(path)}) AND m.requested_at IS NULL AND "
                            f"m.user_id IN {ulist(users)}"],
              'state_expect': [1, len(users)]}
        changes.append(f'program_html (/groups/{path}/-/group_members lists @users) -> SQL: new group {path} with members '
                       f'{", ".join(users)} (any role).')
        if tid == 803:
            changes.append('sayakpaul is listed twice in the intent; required once.')
    else:
        raise SystemExit(f'unhandled task {tid} template {tpl}')

    out['eval'] = ev
    out['changes'] = changes
    out['status'] = 'verified'
    out['drop_reason'] = None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=SRC)
    ap.add_argument('--out', default=os.path.join(HERE, 'webarena-b.jsonl'))
    ap.add_argument('--status', default=os.path.join(HERE, 'verify-b.jsonl'),
                    help='verify log; tasks without an ok run are written as status "unverified"')
    a = ap.parse_args()
    with open(a.src) as f:
        src = [t for t in json.load(f) if t['sites'] == ['gitlab'] and t['intent_template_id'] not in EXCLUDED]
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
