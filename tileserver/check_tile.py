#!/usr/bin/env python3
"""
Usage: ./check_tile.py <tileset_id> <lat> <lon> <zoom>
Example:
  ./check_tile.py Copernicus_DSM_10_N40_00_E029_00_DEM 40.004 29.003 12

This computes tile x/y for given lat/lon at zoom and attempts to download the PNG
from the local tileserver at http://localhost:8080/data/<tileset_id>/{z}/{x}/{y}.png
"""
import math
import sys
from urllib import request, error

if len(sys.argv) != 5:
    print(__doc__)
    sys.exit(1)

tileset, lat_s, lon_s, z_s = sys.argv[1:5]
lat = float(lat_s)
lon = float(lon_s)
z = int(z_s)

def latlon_to_tile(lat, lon, z):
    n = 2 ** z
    xtile = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    ytile = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return xtile, ytile

x, y = latlon_to_tile(lat, lon, z)
url = f"http://localhost:8080/data/{tileset}/{z}/{x}/{y}.png"
print(f"Checking tile URL: {url}")

out = f"/tmp/tile_{z}_{x}_{y}.png"
try:
    request.urlretrieve(url, out)
    print(f"Saved tile to: {out}")
except error.HTTPError as e:
    print(f"HTTP Error: {e.code} {e.reason}")
    sys.exit(2)
except error.URLError as e:
    print(f"URL Error: {e.reason}")
    sys.exit(3)

print("Done. Open the saved PNG or check tileserver logs for details.")
