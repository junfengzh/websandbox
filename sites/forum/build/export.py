#!/usr/bin/env python3
"""Export the WebArena Postmill PostgreSQL database to JSON-lines files.

Usage: python3 -I export.py --container wsb-forum-pg --db postmill --out WORK/export

One file per table, `<table>.jsonl.gz`, one JSON object per row (row_to_json, so
NULL vs '' and integer types are exact). Conversions done in SQL:
  timestamptz -> 'YYYY-MM-DD HH:MM:SS' (UTC text), bytea -> lower-case hex,
  uuid -> text; inet (IP addresses) and tsvector (search_doc) columns are dropped.
Also writes counts.json (source row counts, used by verify.py).
Runs psql inside the DB container (`docker exec`), so no Python DB driver is needed.
"""
import argparse
import gzip
import json
import os
import subprocess
import sys

TABLES = [
    'sites', 'users', 'forums', 'forum_tags', 'forums_tags', 'moderators', 'forum_subscriptions',
    'forum_bans', 'forum_log_entries', 'hidden_forums', 'images', 'submissions', 'comments',
    'submission_votes', 'comment_votes', 'message_threads', 'message_thread_participants', 'messages',
    'notifications', 'wiki_pages', 'wiki_revisions', 'user_bans', 'user_blocks', 'bans', 'flairs',
    'submissions_flairs', 'bad_phrases', 'themes', 'css_theme_revisions',
]
DROP_TYPES = {'inet', 'tsvector'}


def psql(args, sql, **kw):
    cmd = ['docker', 'exec', '-u', 'postgres', args.container, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
           '-v', 'FETCH_COUNT=20000', '-d', args.db, '-c', sql]
    return subprocess.run(cmd, check=True, **kw)


def columns(args, table):
    out = psql(args, f"""SELECT column_name, udt_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='{table}' ORDER BY ordinal_position""",
               capture_output=True, text=True).stdout
    return [line.split('|') for line in out.splitlines() if line]


def expr(name, udt):
    q = f'"{name}"'
    if udt == 'timestamptz' or udt == 'timestamp':
        return f"to_char({q} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS {q}"
    if udt == 'bytea':
        return f"encode({q}, 'hex') AS {q}"
    if udt == 'uuid':
        return f'{q}::text AS {q}'
    return q


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--container', default='wsb-forum-pg')
    ap.add_argument('--db', default='postmill')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    counts = {}
    for t in TABLES:
        cols = [(n, u) for n, u in columns(args, t) if u not in DROP_TYPES]
        if not cols:
            print(f'skip {t} (missing)', file=sys.stderr)
            continue
        order = 'ORDER BY id' if any(n == 'id' for n, _ in cols) else ''
        sel = ', '.join(expr(n, u) for n, u in cols)
        sql = f'SELECT row_to_json(t) FROM (SELECT {sel} FROM "{t}" {order}) t'
        path = os.path.join(args.out, f'{t}.jsonl.gz')
        n = 0
        with gzip.open(path + '.tmp', 'wt', encoding='utf-8', compresslevel=3) as f:
            p = subprocess.Popen(['docker', 'exec', '-u', 'postgres', args.container, 'psql', '-X', '-At',
                                  '-v', 'ON_ERROR_STOP=1', '-v', 'FETCH_COUNT=20000', '-d', args.db, '-c', sql],
                                 stdout=subprocess.PIPE, text=True, encoding='utf-8')
            for line in p.stdout:
                f.write(line)
                n += 1
            if p.wait() != 0:
                raise SystemExit(f'psql failed on {t}')
        os.replace(path + '.tmp', path)
        counts[t] = n
        print(f'{t}: {n}', file=sys.stderr)
    with open(os.path.join(args.out, 'counts.json'), 'w') as f:
        json.dump(counts, f, indent=1, sort_keys=True)


if __name__ == '__main__':
    main()
