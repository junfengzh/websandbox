#!/usr/bin/env bash
# Download every external input of the map build (OSM extracts, planetiler,
# planetiler's auxiliary sources, fonts, sprites, MapLibre style). Idempotent:
# files that already exist with the right size are skipped.
#
#   WSB_SRC=/path/to/sources  ./download.sh      (or SRC=... WORK=...; WORK default $WSB_WORK/map)
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
SRC=${SRC:-${WSB_SRC:?set WSB_SRC (or SRC) to the raw-extracts directory}}
WORK=${WORK:-${WSB_WORK:-$REPO/work}/map}
mkdir -p "$SRC" "$WORK/dl" "$WORK/sources"

fetch() { # url dest
  local url=$1 dest=$2 want have
  want=$(curl -sIL "$url" | grep -i '^content-length' | tail -1 | tr -dc 0-9 || true)
  have=$(stat -c %s "$dest" 2>/dev/null || echo 0)
  if [[ -n "$want" && "$have" == "$want" ]]; then echo "ok   $dest"; return; fi
  echo "get  $url -> $dest ($want bytes)"
  curl -sSL --retry 5 -C - -o "$dest.part" "$url" || curl -sSL --retry 5 -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}

# --- OSM extracts (ODbL) ---
# us-northeast is usually fetched by the lead; only fetch if missing.
[[ -s "$SRC/us-northeast-latest.osm.pbf" ]] || fetch https://download.geofabrik.de/north-america/us-northeast-latest.osm.pbf "$SRC/us-northeast-latest.osm.pbf"
fetch https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf "$SRC/greater-london-latest.osm.pbf" &
fetch https://download.bbbike.org/osm/bbbike/SanFrancisco/SanFrancisco.osm.pbf "$SRC/bbbike-SanFrancisco.osm.pbf" &
fetch https://download.bbbike.org/osm/bbbike/Singapore/Singapore.osm.pbf "$SRC/bbbike-Singapore.osm.pbf" &
wait

# --- planetiler + its auxiliary sources ---
fetch https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar "$WORK/dl/planetiler.jar" &
fetch https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip "$WORK/sources/water-polygons-split-3857.zip" &
fetch https://naciscdn.org/naturalearth/packages/natural_earth_vector.sqlite.zip "$WORK/sources/natural_earth_vector.sqlite.zip" &
fetch https://github.com/acalcutt/osm-lakelines/releases/download/v12/lake_centerline.shp.zip "$WORK/sources/lake_centerline.shp.zip" &
wait

# --- client assets: glyphs (OFL fonts), OSM Bright style + sprites ---
fetch https://github.com/openmaptiles/fonts/releases/download/v2.0/v2.0.zip "$WORK/dl/fonts-v2.0.zip" &
fetch https://github.com/openmaptiles/osm-bright-gl-style/releases/download/v1.11/v1.11.zip "$WORK/dl/osm-bright-v1.11.zip" &
wait
echo done
