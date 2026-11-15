#!/usr/bin/env python3
"""Redact live-looking credentials and personal emails inherited from the WebArena GitLab image.

Usage: python3 -I redact.py --db base.db [--dry-run]

- Every TEXT column of the GitLab-DB-derived tables (issues, merge_requests, notes, snippets,
  wiki_pages, ...) gets credential-looking substrings replaced with [REDACTED]: GitHub tokens
  (ghp_/gho_/ghu_/ghs_/ghr_, github_pat_), Google API keys (AIza...), AWS access key ids
  (AKIA/ASIA...) and secret-access-key assignments, Slack tokens (xox[baprs]-), and the body of
  PEM private keys (BEGIN/END lines kept; trivially short placeholder bodies left alone).
  Git data (commits, git_objects, refs, contributors, mr_commits, ...) is left untouched, and so
  are users.feed_token / password_hash (byteblaze's RSS feed token is used by task 259).
- users.email on a personal webmail domain (gmail.com, ...) -> <username>@example.com.
  (No task references those addresses; tasks log in by username.)
- FTS5 indexes stay consistent through the sync triggers built by assemble.py. Ends with
  secure_delete + VACUUM so the old values do not survive in free pages.
Prints counts only, never the redacted values.
"""
import argparse, re, sqlite3

GIT_TABLES = {'git_objects', 'commits', 'paths', 'commit_files', 'refs', 'project_commits', 'branch_commits',
              'contributors', 'project_templates', 'mr_commits'}
KEEP_COLS = {('users', 'feed_token'), ('users', 'password_hash'), ('users', 'email')}
R = '[REDACTED]'
PATTERNS = [
    ('github', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})')),
    ('google', re.compile(r'AIza[0-9A-Za-z_\-]{35}')),
    ('aws_key_id', re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b')),
    ('aws_secret', re.compile(r'(?i)((?:aws_?secret(?:_?access)?_?key|secret_?access_?key)["\']?\s*[:=]\s*["\']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])')),
    ('slack', re.compile(r'\bxox[baprs]-[A-Za-z0-9-]{10,}')),
]
PEM = re.compile(r'(-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----)(.*?)(-----END \2PRIVATE KEY-----)', re.S)
PEM_OPEN = re.compile(r'(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)((?:[A-Za-z0-9+/=\s]|\\n|\\r)+)')
WEBMAIL = ('gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com',
           'qq.com', '163.com', '126.com', 'protonmail.com', 'proton.me', 'aol.com', 'gmx.de', 'mail.ru')


def b64len(s):
    return len(re.findall(r'[A-Za-z0-9+/]', s))


def redact(v, stats):
    if not isinstance(v, str):
        return v
    out = v
    for k, p in PATTERNS:
        if k == 'aws_secret':
            out, n = p.subn(lambda m: m.group(1) + R, out)
        else:
            out, n = p.subn(R, out)
        if n:
            stats[k] = stats.get(k, 0) + n

    def pem(m):
        if b64len(m.group(3)) < 40:
            return m.group(0)
        stats['private_key'] = stats.get('private_key', 0) + 1
        return m.group(1) + R + m.group(4)
    out = PEM.sub(pem, out)

    def pem_open(m):   # BEGIN without a matching END (truncated paste)
        if b64len(m.group(2)) < 40:
            return m.group(0)
        stats['private_key'] = stats.get('private_key', 0) + 1
        return m.group(1) + R
    out = PEM_OPEN.sub(lambda m: m.group(0) if R in m.group(0) else pem_open(m), out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    db = sqlite3.connect(a.db, isolation_level=None)
    stats = {}
    db.create_function('wsb_redact', 1, lambda v: redact(v, stats), deterministic=True)
    db.create_function('wsb_redact_probe', 1, lambda v: redact(v, {}), deterministic=True)  # WHERE: not counted
    db.execute('PRAGMA secure_delete=ON')
    db.execute('BEGIN')
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'")]
    shadow = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL%'")}
    rows = 0
    for t in tables:
        if t in GIT_TABLES or t.startswith('sqlite_') or any(t.startswith(s + '_') for s in shadow):
            continue
        for _, c, typ, *_ in db.execute(f'PRAGMA table_info("{t}")').fetchall():
            if (typ or '').upper() not in ('TEXT', '') or (t, c) in KEEP_COLS:
                continue
            n = db.execute(f'UPDATE "{t}" SET "{c}" = wsb_redact("{c}") WHERE typeof("{c}") = \'text\' '
                           f'AND wsb_redact_probe("{c}") <> "{c}"').rowcount
            if n:
                print(f'  {t}.{c}: {n} rows')
                rows += n
    ph = ','.join('?' * len(WEBMAIL))
    taken = {r[0] for r in db.execute('SELECT lower(email) FROM users')}
    em = db.execute(f"SELECT id, username FROM users WHERE lower(substr(email, instr(email, '@') + 1)) IN ({ph})",
                    WEBMAIL).fetchall()
    for uid, user in em:
        new = f'{user}@example.com'
        if new.lower() in taken:
            new = f'{user}+{uid}@example.com'
        db.execute('UPDATE users SET email = ? WHERE id = ?', (new, uid))
    print(f'credential matches {stats}; {rows} text cells; users.email -> example.com: {len(em)}')
    if a.dry_run:
        db.execute('ROLLBACK')
        return
    db.execute('COMMIT')
    for t in [s for s in shadow if s.endswith('_fts')]:
        db.execute(f"INSERT INTO {t}({t}) VALUES ('integrity-check')")
    db.execute('PRAGMA journal_mode=DELETE')
    db.execute('VACUUM')
    ok = db.execute('PRAGMA integrity_check').fetchone()[0]
    db.close()
    if ok != 'ok':
        raise SystemExit('integrity_check: ' + ok)


if __name__ == '__main__':
    main()
