#!/usr/bin/env bash
# Rebuild the forum's base.db + media/ from the WebArena Postmill squashfs image.
# Usage: sites/forum/build/build.sh [step...]
#   steps: mount pg export images transform verify cleanup   (default: all, in that order)
# See README.md. Needs: sudo (loop mount, copy of the Postgres datadir), docker, python3
# with Pillow (WebP), node >= 20 with kit/node_modules installed.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
SRC=${SRC:-$WSB_SRC/forum.sqfs}
SCR=${SCR:-$WSB_SCRATCH}
MNT=$WSB_MNT/forum
WORK=$SCR/work/forum
OUT=$SCR/data/forum
PG_IMAGE=postgres:14-alpine       # source: PG_VERSION 14, Alpine (musl) build, C collation
PG=wsb-forum-pg
JOBS=${JOBS:-7}
TASKS=${TASKS:-$REPO/../3rd-party/webarena/config_files/test.raw.json}
PY="python3 -I"

mkdir -p "$WORK" "$OUT"

step_mount() {
  mkdir -p "$MNT"
  mountpoint -q "$MNT" || sudo mount -o loop,ro "$SRC" "$MNT"
}

step_pg() {  # copy the 4.8 GB datadir to local disk (docker can't bind-mount NFS/squashfs paths reliably) and start PG
  step_mount
  [ -d "$WORK/pgdata" ] || sudo cp -a "$MNT/usr/local/pgsql/data" "$WORK/pgdata"
  sudo rm -f "$WORK/pgdata/postmaster.pid"
  docker rm -f $PG >/dev/null 2>&1 || true
  docker run -d --name $PG -v "$WORK/pgdata:/var/lib/postgresql/data" --shm-size=1g $PG_IMAGE >/dev/null
  # crash recovery (WAL replay) runs on first start; wait until it accepts connections
  until docker exec -u postgres $PG psql -X -At -d postmill -c 'select 1' >/dev/null 2>&1; do sleep 2; done
  echo "postgres ready"
}

step_export() { $PY "$HERE/export.py" --container $PG --out "$WORK/export"; }

step_images() {
  step_mount
  $PY "$HERE/images.py" --src "$MNT/var/www/html/public/submission_images" --out "$OUT/media" \
    --manifest "$WORK/images_manifest.jsonl" --jobs "$JOBS"
}

step_transform() {
  $PY "$HERE/transform.py" --export "$WORK/export" --manifest "$WORK/images_manifest.jsonl" \
    --kit "$REPO/kit" --out "$OUT/base.db"
}

step_verify() {
  local pgopt=()
  docker inspect $PG >/dev/null 2>&1 && pgopt=(--pg-container $PG)
  $PY "$HERE/verify.py" --db "$OUT/base.db" --export "$WORK/export" --tasks "$TASKS" \
    --media "$OUT/media" --kit "$REPO/kit" "${pgopt[@]}" > "$WORK/verify.json"
  echo "verify OK -> $WORK/verify.json"
}

step_cleanup() {  # keeps $WORK/export (~350 MB) and the manifest so transform can re-run without Postgres
  docker rm -f $PG >/dev/null 2>&1 || true
  sudo rm -rf "$WORK/pgdata"
  mountpoint -q "$MNT" && sudo umount "$MNT" || true
}

steps=("$@")
[ ${#steps[@]} -eq 0 ] && steps=(mount pg export images transform verify cleanup)
for s in "${steps[@]}"; do echo "== $s"; "step_$s"; done
