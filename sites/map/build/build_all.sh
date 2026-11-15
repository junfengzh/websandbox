#!/usr/bin/env bash
# Full map build: regions -> tiles (planetiler) + geocoder DB + routing graphs + client assets.
#
#   ./build_all.sh            # everything
#   STEPS="geocode route" ./build_all.sh
#
# Env: SRC (raw extracts), WORK (intermediates), OUT (outputs), JAVA (Java >= 21 for planetiler).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${SRC:-$WSB_SRC}
WORK=${WORK:-$WSB_WORK/map}
OUT=${OUT:-$WSB_DATA_ROOT/map}
JAVA=${JAVA:-/usr/lib/jvm/java-21-openjdk-amd64/bin/java}
STEPS=${STEPS:-"download prepare compile assets tiles route geocode"}
export SRC WORK
mkdir -p "$WORK" "$OUT"
has() { [[ " $STEPS " == *" $1 "* ]]; }
ts() { date +%H:%M:%S; }

if has download; then "$HERE/download.sh"; fi
if has prepare; then echo "[$(ts)] prepare"; python3 -I "$HERE/prepare.py"; fi
if has compile; then
  echo "[$(ts)] compile"
  g++ -O3 -std=c++17 -o "$WORK/route_extract" "$HERE/route_extract.cpp" -lz -lbz2 -lexpat -lpthread
  g++ -O3 -march=native -std=c++17 -o "$WORK/graph" "$HERE/graph.cpp"
fi
if has assets; then echo "[$(ts)] assets"; python3 -I "$HERE/assets.py" "$WORK/dl" "$OUT/static"; fi

pids=()
if has tiles; then
  (
    echo "[$(ts)] tiles start"
    mkdir -p "$OUT/tiles" "$WORK/tiles"
    "$JAVA" -Xmx16g -jar "$WORK/dl/planetiler.jar" --osm-path="$WORK/all.osm.pbf" \
      --output="$OUT/tiles/map.mbtiles" --force --download=false \
      --water-polygons-path="$WORK/sources/water-polygons-split-3857.zip" \
      --natural-earth-path="$WORK/sources/natural_earth_vector.sqlite.zip" \
      --lake-centerlines-path="$WORK/sources/lake_centerline.shp.zip" \
      --polygon="$WORK/all.poly" --maxzoom=14 --tmpdir="$WORK/tiles/tmp" --threads=4 \
      --nodemap-type=sparsearray --nodemap-storage=mmap \
      --name="websandbox map" --attribution='<a href="https://openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>' \
      > "$WORK/tiles/planetiler.log" 2>&1
    rm -rf "$WORK/tiles/tmp"
    echo "[$(ts)] tiles done: $(du -h "$OUT/tiles/map.mbtiles" | cut -f1)"
  ) &
  pids+=($!)
fi
if has route; then
  (
    echo "[$(ts)] route start"
    mkdir -p "$WORK/route" "$OUT/route"
    "$WORK/route_extract" "$WORK/all.osm.pbf" "$WORK/route" > "$WORK/route.log" 2>&1
    "$WORK/graph" "$WORK/route" "$OUT/route" car,bike:astar,foot:astar >> "$WORK/route.log" 2>&1
    echo "[$(ts)] route done: $(du -sh "$OUT/route" | cut -f1)"
  ) &
  pids+=($!)
fi
if has geocode; then
  (
    echo "[$(ts)] geocode start"
    mkdir -p "$WORK/geocode"
    python3 -I "$HERE/geocode_extract.py" "$WORK/all.osm.pbf" "$WORK/geocode" > "$WORK/geocode.log" 2>&1
    python3 -I "$HERE/build_geocode.py" "$WORK/geocode/extract.pkl" "$OUT/geocode.db" >> "$WORK/geocode.log" 2>&1
    echo "[$(ts)] geocode done: $(du -h "$OUT/geocode.db" | cut -f1)"
  ) &
  pids+=($!)
fi
for p in "${pids[@]}"; do wait "$p"; done
echo "[$(ts)] all done"; du -sh "$OUT"/*
