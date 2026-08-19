#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /path/to/input.tif [output_dir]" >&2
  exit 1
fi

INPUT_TIF="$(realpath "$1")"
OUT_DIR="${2:-./mbtiles}"
OUT_DIR="$(realpath "$OUT_DIR")"
NAME="$(basename "$INPUT_TIF" .tif)"

mkdir -p "$OUT_DIR"

IN_DIR="$(dirname "$INPUT_TIF")"
IN_BASE="$(basename "$INPUT_TIF")"

# Convert to Web Mercator and build MBTiles using GDAL in Docker.
docker run --rm \
  -v "$IN_DIR":/in \
  -v "$OUT_DIR":/out \
  ghcr.io/osgeo/gdal:ubuntu-small-latest \
  bash -lc "gdalwarp -t_srs EPSG:3857 /in/$IN_BASE /out/${NAME}_3857.tif \
    && gdal_translate -of MBTiles -co TILE_FORMAT=PNG /out/${NAME}_3857.tif /out/${NAME}.mbtiles \
    && gdaladdo -r average /out/${NAME}.mbtiles 2 4 8 16 32"

echo "Created: $OUT_DIR/${NAME}.mbtiles"
