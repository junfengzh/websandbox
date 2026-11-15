#!/usr/bin/env bash
# Rebuild the store's base.db + media/ from the WebArena Magento squashfs images.
# Usage: sites/store/build/build.sh [step...]
#   steps: mount-admin export-admin mount-shop export-shop transform images verify cleanup
#   (default: all, in that order). See README.md.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${SRC:-$WSB_SRC}
SCR=${SCR:-$WSB_SCRATCH}
WORK=$SCR/work/store
OUT=$SCR/data/store
VENV=$WORK/venv
PY="$VENV/bin/python -I"
MARIADB_IMAGE=mariadb:10.6.12      # both images run MariaDB 10.6.12 (mysql_upgrade_info)
JOBS=${JOBS:-6}
# WebArena's public demo accounts (customer + admin passwords are read from here, not stored in this repo)
ACCOUNTS=${ACCOUNTS:-$(cd "$HERE/../../../.." && pwd)/3rd-party/webarena/browser_env/env_config.py}

mkdir -p "$WORK" "$OUT"

venv() {
  if [ ! -x "$VENV/bin/python" ]; then
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q pymysql==1.1.1 Pillow==12.3.0 argon2-cffi==25.1.0
  fi
}

mnt() {  # mnt <name> <sqfs>
  local m=$WSB_MNT/store_$1
  mkdir -p "$m"
  mountpoint -q "$m" || sudo mount -o loop,ro "$2" "$m"
}

start_db() {  # start_db <name> <port>
  local d=$WORK/${1}_mysql
  if [ ! -d "$d" ]; then
    sudo cp -a "$WSB_MNT/store_$1/var/lib/mysql" "$d"
    sudo rm -f "$d"/*.pid
    sudo chown -R 999:999 "$d"
  fi
  docker rm -f "wsb-store-$1-db" >/dev/null 2>&1 || true
  docker run -d --name "wsb-store-$1-db" -p "127.0.0.1:$2:3306" -v "$d:/var/lib/mysql" \
    "$MARIADB_IMAGE" mariadbd --skip-grant-tables --innodb-buffer-pool-size=8G >/dev/null
  until docker exec "wsb-store-$1-db" mariadb -e 'select 1' >/dev/null 2>&1; do sleep 2; done
}

export_db() {  # export_db <name> <port>
  rm -f "$WORK/raw_$1.db"
  $PY "$HERE/export_raw.py" --port "$2" --out "$WORK/raw_$1.db"
  docker rm -f "wsb-store-$1-db" >/dev/null
}

step() {
  case $1 in
    mount-admin)  mnt admin "$SRC/shopping_admin.sqfs" ;;
    export-admin) venv; start_db admin 7301; export_db admin 7301 ;;
    mount-shop)   mnt shop "$SRC/shopping.sqfs" ;;
    export-shop)  venv; start_db shop 7302; export_db shop 7302 ;;
    transform)
      cp "$WSB_MNT/store_admin/usr/share/zoneinfo/iso3166.tab" "$WORK/iso3166.tab"
      $PY "$HERE/transform.py" --admin "$WORK/raw_admin.db" --shop "$WORK/raw_shop.db" \
        --out "$OUT/base.db.new" --iso3166 "$WORK/iso3166.tab" \
        --accounts "$ACCOUNTS"
      mv "$OUT/base.db.new" "$OUT/base.db" ;;
    images)
      $PY "$HERE/images.py" --db "$OUT/base.db" --media "$OUT/media" --jobs "$JOBS" \
        --src admin="$WSB_MNT/store_admin/var/www/magento2/pub/media" \
        --src shop="$WSB_MNT/store_shop/var/www/magento2/pub/media" ;;
    verify)
      $PY "$HERE/verify.py" --db "$OUT/base.db" --admin "$WORK/raw_admin.db" --shop "$WORK/raw_shop.db" \
        --media "$OUT/media" ;;
    finalize)
      # kit.build.finalize conventions: rollback journal (copyable single file), ANALYZE, VACUUM, integrity_check
      sqlite3 "$OUT/base.db" 'pragma journal_mode=delete; analyze; vacuum;' >/dev/null
      [ "$(sqlite3 "$OUT/base.db" 'pragma integrity_check')" = ok ] ;;
    cleanup)
      for n in admin shop; do
        docker rm -f "wsb-store-$n-db" >/dev/null 2>&1 || true
        mountpoint -q "$WSB_MNT/store_$n" && sudo umount "$WSB_MNT/store_$n" || true
        sudo rm -rf "$WORK/${n}_mysql"
      done ;;
    *) echo "unknown step $1" >&2; exit 2 ;;
  esac
}

steps=("$@")
[ ${#steps[@]} -eq 0 ] && steps=(mount-admin export-admin mount-shop export-shop transform images finalize verify cleanup)
for s in "${steps[@]}"; do echo "== $s"; step "$s"; done
