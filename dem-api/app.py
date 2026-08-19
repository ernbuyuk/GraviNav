from pathlib import Path
from typing import List, Optional

import numpy as np
import rasterio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pyproj import Transformer

DEM_PATH = Path(
    "/home/ubuntu/eren/GraviNav/tileserver/mbtiles/Copernicus_DSM_10_N40_00_E029_00_DEM_3857.tif"
)

app = FastAPI(title="DEM Query API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class QueryRequest(BaseModel):
    height: float
    tolerance: float = Field(default=1.0, ge=0)
    stride: int = Field(default=4, ge=1, le=64)
    max_points: int = Field(default=5000, ge=1, le=50000)


class MatchPoint(BaseModel):
    lat: float
    lon: float
    height: float


class QueryResponse(BaseModel):
    matches: List[MatchPoint]
    sampled_match_count: int
    truncated: bool


def _scan_matches(req: QueryRequest) -> QueryResponse:
    if not DEM_PATH.exists():
        raise HTTPException(status_code=500, detail=f"DEM file not found: {DEM_PATH}")

    lo = req.height - req.tolerance
    hi = req.height + req.tolerance

    matches: List[MatchPoint] = []
    sampled_count = 0
    truncated = False

    with rasterio.open(DEM_PATH) as ds:
        transformer = Transformer.from_crs(ds.crs, "EPSG:4326", always_xy=True)

        for _, window in ds.block_windows(1):
            arr = ds.read(1, window=window)
            if arr.size == 0:
                continue

            sub = arr[:: req.stride, :: req.stride]
            valid = np.isfinite(sub)
            mask = valid & (sub >= lo) & (sub <= hi)
            if not np.any(mask):
                continue

            rr, cc = np.where(mask)
            sampled_count += int(rr.size)

            base_r = window.row_off
            base_c = window.col_off

            for r_sub, c_sub in zip(rr, cc):
                r = int(base_r + r_sub * req.stride)
                c = int(base_c + c_sub * req.stride)
                x, y = ds.xy(r, c)
                lon, lat = transformer.transform(x, y)
                h = float(sub[r_sub, c_sub])
                matches.append(MatchPoint(lat=lat, lon=lon, height=round(h, 2)))

                if len(matches) >= req.max_points:
                    truncated = True
                    return QueryResponse(
                        matches=matches,
                        sampled_match_count=sampled_count,
                        truncated=truncated,
                    )

    return QueryResponse(
        matches=matches,
        sampled_match_count=sampled_count,
        truncated=truncated,
    )


@app.get("/health")
def health() -> dict:
    return {"ok": True, "dem_exists": DEM_PATH.exists(), "dem_path": str(DEM_PATH)}


@app.post("/query", response_model=QueryResponse)
def query(req: QueryRequest) -> QueryResponse:
    return _scan_matches(req)
