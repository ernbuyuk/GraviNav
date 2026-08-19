# DEM Query API

Small local API that scans the DEM raster and returns points matching an observation height.

## Run

```bash
cd dem-api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8090
```

## Query

```bash
curl -X POST http://localhost:8090/query \
  -H "Content-Type: application/json" \
  -d '{"height": 80, "tolerance": 1.0, "stride": 4, "max_points": 5000}'
```

`stride` increases speed by scanning every Nth pixel. Lower stride gives denser output.
