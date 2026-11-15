#!/usr/bin/env python3
"""Turn the Postmill export (export.py) into the lite forum base.db.

Usage: python3 -I transform.py --export WORK/export --manifest WORK/images_manifest.jsonl \
           --kit KIT_DIR --out DATA/base.db

Ids are kept. Values are kept raw (titles with '&amp;', the Reddit ids WebArena stored
in users.biography / forums.sidebar / user_flag). Changes from the source:
  * user_flag 't3_...'/'t1_...' moves to reddit_id; user_flag becomes 'none';
  * slug column added (Postmill Slugger::slugify);
  * password_hash: users whose bcrypt hash verifies with a documented WebArena password
    get one cheap scrypt hash of it (kit format); others keep the bcrypt hash;
  * IP addresses, e-mail addresses and tsvectors are not kept; images get WebP paths from the manifest.
"""
import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
# Passwords WebArena documents for its forum accounts (browser_env/env_config.py).
KNOWN_PASSWORDS = ['test1234']
B = lambda v: None if v is None else int(bool(v))  # noqa: E731


def rows(export, table):
    with gzip.open(os.path.join(export, f'{table}.jsonl.gz'), 'rt', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


_WORD = re.compile(r'[^\w]+', re.UNICODE)


def graphemes(s):
    return sum(1 for ch in s if not unicodedata.combining(ch))


def slugify(title, max_len=60):
    """Postmill App\\Utils\\Slugger::slugify (mb_strtolower, split on /[^\\w]+/u, <= 60 graphemes)."""
    words = [w for w in _WORD.split(title.lower()) if w]
    slug, n = '', 0
    for w in words:
        add = f'-{w}' if n > 0 else w
        n += graphemes(add)
        if n > max_len:
            break
        slug += add
    return slug or '-'


def scrypt_hash(password, tag):
    """kit.auth format scrypt$N$salt$hash; deterministic salt so builds are reproducible."""
    salt = base64.urlsafe_b64encode(hashlib.sha256(f'websandbox-forum:{tag}'.encode()).digest()[:12]).decode().rstrip('=')
    dk = hashlib.scrypt(password.encode(), salt=salt.encode(), n=1024, r=8, p=1, dklen=32)
    return f"scrypt$1024${salt}${base64.urlsafe_b64encode(dk).decode().rstrip('=')}"


def resolve_passwords(hashes, kit_dir):
    """Map each distinct bcrypt hash to a known plaintext (or None) using the kit's verifier.
    Hashes and passwords go over stdin; nothing secret is printed."""
    js = r"""
const { verifyPassword } = require(process.argv[1] + '/lib/auth');
let buf = ''; process.stdin.on('data', d => buf += d).on('end', async () => {
  const { hashes, candidates } = JSON.parse(buf); const out = {};
  for (const h of hashes) { out[h] = null; for (const c of candidates) if (await verifyPassword(c, h)) { out[h] = c; break; } }
  process.stdout.write(JSON.stringify(out));
});"""
    p = subprocess.run(['node', '-e', js, kit_dir], input=json.dumps({'hashes': sorted(hashes), 'candidates': KNOWN_PASSWORDS}),
                       capture_output=True, text=True, check=True)
    return json.loads(p.stdout)


def split_flag(flag, prefix):
    if flag and flag.startswith(prefix):
        return 'none', flag
    return flag or 'none', None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--export', required=True)
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--kit', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    counts = json.load(open(os.path.join(a.export, 'counts.json')))
    # Tables the lite schema has but the WebArena source leaves empty: fail loudly if that changes.
    for t in ['forum_tags', 'forums_tags', 'forum_bans', 'forum_log_entries', 'hidden_forums', 'message_threads',
              'message_thread_participants', 'messages', 'notifications', 'wiki_pages', 'wiki_revisions',
              'user_bans', 'user_blocks', 'bans', 'flairs', 'submissions_flairs', 'bad_phrases', 'themes',
              'css_theme_revisions']:
        if counts.get(t, 0):
            raise SystemExit(f'source table {t} has {counts[t]} rows but has no loader yet')

    tmp = a.out + '.tmp'
    for s in ('', '-journal', '-wal', '-shm'):
        if os.path.exists(tmp + s):
            os.remove(tmp + s)
    db = sqlite3.connect(tmp, isolation_level=None)
    for p in ('journal_mode=OFF', 'synchronous=OFF', 'cache_size=-1048576', 'temp_store=MEMORY', 'foreign_keys=OFF'):
        db.execute(f'PRAGMA {p}')
    db.executescript(open(os.path.join(HERE, 'schema.sql')).read())
    db.execute('PRAGMA foreign_keys=OFF')
    db.execute('BEGIN')

    # site settings (Postmill `sites` row)
    for r in rows(a.export, 'sites'):
        for k, v in r.items():
            if k != 'id':
                db.execute('INSERT INTO site_settings VALUES (?, ?)', (k, json.dumps(v) if isinstance(v, bool) else v))

    # users
    users = list(rows(a.export, 'users'))
    plain = resolve_passwords({u['password'] for u in users}, a.kit)
    rehash = {h: scrypt_hash(pw, pw) for h, pw in plain.items() if pw}
    print(f'password hashes: {len(plain)} distinct, {len(rehash)} matched a known WebArena password', file=sys.stderr)
    # provenance: the original bcrypt hash(es) that were replaced (shared by all those users)
    for i, h in enumerate(sorted(rehash)):
        db.execute('INSERT INTO site_settings VALUES (?, ?)', (f'source_bcrypt_{i}', h))
    db.executemany('INSERT INTO users VALUES (' + ','.join('?' * 28) + ')', (
        (u['id'], u['username'], u['normalized_username'], None, None,  # e-mails dropped (privacy)
         rehash.get(u['password'], u['password']), 'admin' if u['admin'] else 'user', B(u['trusted']),
         u['created'], u['last_seen'], u['biography'], u['locale'], u['timezone'], u['night_mode'], u['front_page'],
         u['front_page_sort_mode'], B(u['show_thumbnails']), B(u['open_external_links_in_new_tab']),
         B(u['notify_on_reply']), B(u['notify_on_mentions']), B(u['allow_private_messages']),
         B(u['auto_fetch_submission_titles']), B(u['enable_post_previews']), B(u['show_custom_stylesheets']),
         B(u['poppers_enabled']), B(u['full_width_display_enabled']), u['submission_link_destination'],
         u['preferred_fonts']) for u in users))
    del users

    db.executemany('INSERT INTO forums VALUES (?,?,?,?,?,?,?,?,?,?)', (
        (f['id'], f['name'], f['normalized_name'], f['title'], f['description'], f['sidebar'], f['created'],
         B(f['featured']), B(f['moderation_log_public']), f['background_image_mode']) for f in rows(a.export, 'forums')))

    # images + webp manifest
    man = {}
    if os.path.exists(a.manifest):
        for line in open(a.manifest):
            m = json.loads(line)
            if 'error' not in m:
                man[m['file_name']] = m
    else:
        print('WARNING: no image manifest; images.path left NULL', file=sys.stderr)
    nimg = nmiss = 0
    for im in rows(a.export, 'images'):
        m = man.get(im['file_name'])
        stem = os.path.splitext(im['file_name'])[0]
        nimg += 1
        nmiss += m is None
        db.execute('INSERT INTO images VALUES (?,?,?,?,?,?,?,?,?,?)', (
            im['id'], im['file_name'], im['sha256'], im['width'], im['height'],
            f'submission_images/{stem}.webp' if m else None, f'submission_images/thumb/{stem}.webp' if m else None,
            m and m['width'], m and m['height'], m and m['bytes']))
    print(f'images: {nimg}, without webp: {nmiss}', file=sys.stderr)

    def subs():
        for s in rows(a.export, 'submissions'):
            flag, rid = split_flag(s['user_flag'], 't3_')
            yield (s['id'], s['forum_id'], s['user_id'], s['title'], slugify(s['title']), s['url'], s['body'],
                   s['media_type'], s['image_id'], s['timestamp'], s['edited_at'], s['last_active'], B(s['sticky']),
                   B(s['locked']), B(s['moderated']), s['visibility'], flag, s['net_score'], s['comment_count'],
                   s['ranking'], rid)
    db.executemany('INSERT INTO submissions VALUES (' + ','.join('?' * 21) + ')', subs())

    def coms():
        for c in rows(a.export, 'comments'):
            flag, rid = split_flag(c['user_flag'], 't1_')
            yield (c['id'], c['submission_id'], c['parent_id'], c['user_id'], c['body'], c['timestamp'], c['edited_at'],
                   c['visibility'], B(c['moderated']), flag, c['net_score'], rid)
    db.executemany('INSERT INTO comments VALUES (' + ','.join('?' * 12) + ')', coms())

    db.executemany('INSERT INTO submission_votes VALUES (?,?,?,?,?)', (
        (v['id'], v['user_id'], v['submission_id'], B(v['upvote']), v['timestamp']) for v in rows(a.export, 'submission_votes')))
    db.executemany('INSERT INTO comment_votes VALUES (?,?,?,?,?)', (
        (v['id'], v['user_id'], v['comment_id'], B(v['upvote']), v['timestamp']) for v in rows(a.export, 'comment_votes')))
    db.executemany('INSERT INTO moderators (forum_id, user_id, created_at) VALUES (?,?,?)', (
        (m['forum_id'], m['user_id'], m['timestamp']) for m in sorted(rows(a.export, 'moderators'), key=lambda m: m['timestamp'])))
    db.executemany('INSERT INTO forum_subscriptions VALUES (?,?,?)', (
        (s['user_id'], s['forum_id'], s['subscribed_at']) for s in rows(a.export, 'forum_subscriptions')))
    db.execute('COMMIT')

    print('indexing (FTS5, triggers)...', file=sys.stderr)
    db.executescript(open(os.path.join(HERE, 'search.sql')).read())
    for t in ('submissions_fts', 'comments_fts', 'forums_fts'):
        db.execute(f"INSERT INTO {t}({t}) VALUES ('optimize')")
    fk = db.execute('PRAGMA foreign_key_check').fetchall()
    if fk:
        raise SystemExit(f'foreign_key_check: {len(fk)} violations, e.g. {fk[:5]}')
    db.execute('ANALYZE')
    db.execute('PRAGMA journal_mode=DELETE')
    db.execute('VACUUM')
    ok = db.execute('PRAGMA integrity_check').fetchone()[0]
    if ok != 'ok':
        raise SystemExit(f'integrity_check: {ok}')
    db.close()
    os.replace(tmp, a.out)
    print(f'wrote {a.out} ({os.path.getsize(a.out) / 2**30:.2f} GiB)', file=sys.stderr)


if __name__ == '__main__':
    main()
