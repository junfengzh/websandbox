#!/usr/bin/env bash
# Rebuild the code-hosting site's base.db from the WebArena GitLab squashfs image.
# Usage: sites/code/build/build.sh [step...]
#   steps: mount pgcopy pgstart export repocopy git templates assemble media verify licenses cleanup
#   (default: all, in that order). See README.md.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${SRC:-$WSB_SRC}
SCR=${SCR:-$WSB_SCRATCH}
MNT=$WSB_MNT/code
WORK=$SCR/work/code
OUT=$SCR/data/code
VENV=$WORK/venv
PG_IMAGE=postgres:13.8          # GitLab 15.7.5 Omnibus runs PostgreSQL 13.8 (PG_VERSION 13)
PG_PORT=7432
PG_NAME=wsb-code-pg
PG="host=127.0.0.1 port=$PG_PORT user=gitlab-psql dbname=gitlabhq_production"
JOBS=${JOBS:-5}
RAILS=$MNT/opt/gitlab/embedded/service/gitlab-rails

mkdir -p "$WORK" "$OUT"

venv() {
  if [ ! -x "$VENV/bin/python" ]; then
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q "psycopg[binary]==3.2.3"
  fi
}

step_mount() {
  mkdir -p "$MNT"
  mountpoint -q "$MNT" || sudo mount -o loop,ro "$SRC/gitlab.sqfs" "$MNT"
}

step_pgcopy() {   # docker cannot bind-mount NFS/squashfs: copy the datadir (12 GB) to local disk
  [ -d "$WORK/pgdata" ] || sudo cp -a "$MNT/var/opt/gitlab/postgresql/data" "$WORK/pgdata"
  printf 'local all all trust\nhost all all 0.0.0.0/0 trust\n' | sudo tee "$WORK/pgdata/pg_hba.conf" >/dev/null
  sudo rm -f "$WORK/pgdata/postmaster.pid"
}

step_pgstart() {
  docker rm -f $PG_NAME >/dev/null 2>&1 || true
  local uid; uid=$(sudo stat -c %u "$WORK/pgdata")
  docker run -d --name $PG_NAME --user "$uid:$uid" -p 127.0.0.1:$PG_PORT:5432 \
    -v "$WORK/pgdata:/var/lib/postgresql/data" $PG_IMAGE \
    postgres -D /var/lib/postgresql/data -c listen_addresses='*' -c ssl=off -c ssl_ca_file='' \
      -c unix_socket_directories=/tmp -c shared_buffers=2GB -c work_mem=256MB >/dev/null
  until docker exec $PG_NAME pg_isready -h /tmp -q; do sleep 1; done
}

step_export() { venv; "$VENV/bin/python" -I "$HERE/export_pg.py" --pg "$PG" --out "$WORK/rel.db"; }

step_repocopy() {  # repos are root-only on the image; copy and chown so git can read them
  if [ ! -d "$WORK/repos" ]; then
    sudo cp -a "$MNT/var/opt/gitlab/git-data/repositories" "$WORK/repos"
    sudo chown -R "$(id -u):$(id -g)" "$WORK/repos"
  fi
}

step_git() { python3 -I "$HERE/import_git.py" --repos "$WORK/repos" --rel "$WORK/rel.db" --shards "$WORK/shards" --jobs "$JOBS"; }

step_templates() { python3 -I "$HERE/templates.py" --rails "$RAILS" --work "$WORK" --shards "$WORK/shards"; }

step_assemble() { python3 -I "$HERE/assemble.py" --rel "$WORK/rel.db" --shards "$WORK/shards" --out "$OUT/base.db"; }

step_media() {    # the only uploaded avatars (2 bots); everyone else gets a letter avatar
  local up=$MNT/var/opt/gitlab/gitlab-rails/uploads/-/system/user/avatar
  for d in $(sudo ls "$up"); do
    for f in $(sudo ls "$up/$d"); do
      mkdir -p "$OUT/media/avatars/user/$d"
      sudo cat "$up/$d/$f" > "$OUT/media/avatars/user/$d/$f"
    done
  done
}

step_verify() { venv; "$VENV/bin/python" -I "$HERE/verify.py" --db "$OUT/base.db" --pg "$PG" --repos "$WORK/repos"; }

step_licenses() { python3 -I "$HERE/licenses.py" --db "$OUT/base.db" --out "$HERE/../SOURCES.repos.md"; }

step_cleanup() {
  docker rm -f $PG_NAME >/dev/null 2>&1 || true
  sudo rm -rf "$WORK/pgdata" "$WORK/repos" "$WORK/shards" "$WORK/rel.db"
  mountpoint -q "$MNT" && sudo umount "$MNT" || true
}

steps=("$@")
[ ${#steps[@]} -eq 0 ] && steps=(mount pgcopy pgstart export repocopy git templates assemble media verify licenses cleanup)
for s in "${steps[@]}"; do
  echo "== $s ($(date +%T))"
  "step_$s"
done
