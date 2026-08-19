# Motion-Constrained Localization UI

This is a lightweight web UI for visualizing height matching on a DEM tile layer.

## Run

```bash
npm install
npm run dev
```

## DEM observation mode (without Grid JSON)

When no grid JSON is loaded, the UI can query the DEM directly from a local API.

1. Start `dem-api` service (default `http://localhost:8090`).
2. Keep tile server running for map tiles.
3. In UI, set `Observation height` and click `Add observation`.

The app will request matching points from DEM and plot candidates directly.

## Raster tiles

1. Start the tileserver in `../tileserver`.
2. Open http://localhost:8080 and note your tileset id.
3. Enter the tile template in the UI, for example:

```
http://localhost:8080/data/<tileset_id>/{z}/{x}/{y}.png
```

## Grid JSON format

Provide a JSON file with grid cell centers and heights:

```json
{
  "cells": [
    { "lat": 40.0002, "lon": 29.0001, "height": 320.2 }
  ]
}
```

The app also renders a built-in static path overlay from `public/data/static-grid.geojson`.
