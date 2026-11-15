#!/usr/bin/env python3
"""Import GitLab's built-in project templates (vendor/project_templates/*.tar.gz) as shards.

Usage: python3 -I templates.py --rails DIR/opt/gitlab/embedded/service/gitlab-rails --work DIR --shards DIR

Each template tarball holds a git bundle; it is cloned bare into WORK/templates/<name>.git and
read with import_git.process() (policy full) into SHARDS/t_<name>.db. Titles/descriptions come
from lib/gitlab/project_template.rb. merge_shards.py turns them into project_templates rows.
"""
import argparse, os, re, shutil, subprocess, sqlite3, sys, tarfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import import_git  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rails', required=True)
    ap.add_argument('--work', required=True)
    ap.add_argument('--shards', required=True)
    a = ap.parse_args()
    src = open(os.path.join(a.rails, 'lib/gitlab/project_template.rb'), encoding='utf-8').read()
    meta = {}
    for m in re.finditer(r"ProjectTemplate\.new\('([^']+)', '([^']+)', _\('((?:[^'\\]|\\.)*)'\)", src):
        meta[m.group(1)] = (m.group(2), m.group(3))
    tdir = os.path.join(a.work, 'templates')
    shutil.rmtree(tdir, ignore_errors=True)
    os.makedirs(tdir); os.makedirs(a.shards, exist_ok=True)
    vend = os.path.join(a.rails, 'vendor/project_templates')
    for fn in sorted(os.listdir(vend)):
        if not fn.endswith('.tar.gz'):
            continue
        name = fn[:-7]
        if name not in meta:
            print('skip (not a listed template):', name); continue
        x = os.path.join(tdir, name + '.x')
        os.makedirs(x)
        with tarfile.open(os.path.join(vend, fn)) as tf:
            member = next(mm for mm in tf.getmembers() if mm.name.lstrip('./') == 'project.bundle')
            member.name = 'project.bundle'
            tf.extract(member, x)
        bare = os.path.join(tdir, name + '.git')
        subprocess.run(['git', 'clone', '-q', '--bare', os.path.join(x, 'project.bundle'), bare], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shard = os.path.join(a.shards, f't_{name}.db')
        _, m = import_git.process('t_' + name, bare, None, shard)
        db = sqlite3.connect(shard)
        db.executemany('INSERT OR REPLACE INTO meta VALUES (?,?)',
                       [('template_name', name), ('template_title', meta[name][0]),
                        ('template_description', meta[name][1].replace("\\'", "'"))])
        db.commit(); db.close()
        print(name, m.get('default_branch'), m.get('commits'), m.get('obj_blobs'), flush=True)
    shutil.rmtree(tdir, ignore_errors=True)


if __name__ == '__main__':
    main()
