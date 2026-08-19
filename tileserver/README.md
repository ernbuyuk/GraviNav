# DEM Tile Server

This folder contains a simple Docker tile server setup for a DEM GeoTIFF.

## 1) Build MBTiles from the DEM GeoTIFF

From this folder:

```bash
chmod +x ./scripts/build_mbtiles.sh
./scripts/build_mbtiles.sh \
  /home/ubuntu/Downloads/DEM1_SAR_DGE_30_20110327T155635_20140810T155805_ADS_000000_0nJ0_404c8dc2.DEM/DEM1_SAR_DGE_30_20110327T155635_20140810T155805_ADS_000000_0nJ0_404c8dc2/Copernicus_DSM_10_N40_00_E029_00/DEM/Copernicus_DSM_10_N40_00_E029_00_DEM.tif \
  ./mbtiles
```

This creates a MBTiles file under `./mbtiles`.

## 2) Run the tile server

```bash
docker compose up
```

Then open:
- http://localhost:8080

The tiles should appear in the list under the generated MBTiles name.
