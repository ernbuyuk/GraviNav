"""
GraviNav Backend - DEM sorgu API'si + gerçek zamanlı TRN (Terrain Referenced
Navigation) particle filter takip servisi.

Çalıştırma:
    pip install -r requirements.txt --break-system-packages
    uvicorn main:app --reload --host 0.0.0.0 --port 8000

Endpoints:
    GET  /health            - sağlık kontrolü
    GET  /dem/info          - DEM sınırları ve yükseklik aralığı (frontend haritayı ortalamak için kullanır)
    POST /query              - belirli bir yüksekliğe sahip noktaları bul (eski endpoint, RAM'den hızlandırıldı)
    WS   /ws/track           - canlı simülasyon + particle filter akışı
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from dem import DEM
from particle_filter import ParticleFilter
from simulation import PathSimulator

# ---------------------------------------------------------------------------
# DEM yolu -- EPSG:4326 (coğrafi) olması ZORUNLU. Web Mercator (_3857) dosyası
# verirsen DEM sınıfı hata fırlatır; önce gdalwarp -t_srs EPSG:4326 ile çevir.
# ---------------------------------------------------------------------------
DEM_PATH = Path(
    "/home/ubuntu/eren/GraviNav/tileserver/mbtiles/dem_4326.tif"
)

app = FastAPI(title="GraviNav DEM/TRN API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

dem: Optional[DEM] = None


@app.on_event("startup")
def load_dem() -> None:
    global dem
    dem = DEM(DEM_PATH)


# ---------------------------------------------------------------------------
# Eski endpoint'ler (senin orijinal script'inden, RAM'den okuyacak şekilde
# hızlandırıldı -- artık her istekte diski taramıyor)
# ---------------------------------------------------------------------------
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


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "dem_loaded": dem is not None,
        "dem_path": str(DEM_PATH),
    }


@app.get("/dem/info")
def dem_info() -> dict:
    if dem is None:
        raise HTTPException(status_code=503, detail="DEM not loaded")
    return {
        "bounds": {
            "west": dem.west,
            "south": dem.south,
            "east": dem.east,
            "north": dem.north,
        },
        "center": {"lat": (dem.south + dem.north) / 2, "lon": (dem.west + dem.east) / 2},
        "elevation_min": dem.elev_min,
        "elevation_max": dem.elev_max,
    }


@app.post("/query", response_model=QueryResponse)
def query(req: QueryRequest) -> QueryResponse:
    if dem is None:
        raise HTTPException(status_code=503, detail="DEM not loaded")

    lo, hi = req.height - req.tolerance, req.height + req.tolerance
    sub = dem.data[:: req.stride, :: req.stride]
    mask = np.isfinite(sub) & (sub >= lo) & (sub <= hi)
    rr, cc = np.where(mask)

    sampled_count = int(rr.size)
    truncated = False
    if rr.size > req.max_points:
        sel = np.random.choice(rr.size, req.max_points, replace=False)
        rr, cc = rr[sel], cc[sel]
        truncated = True

    heights = sub[rr, cc]
    full_rows = rr * req.stride
    full_cols = cc * req.stride
    lons, lats = dem.transform * (full_cols, full_rows)

    matches = [
        MatchPoint(lat=float(la), lon=float(lo2), height=round(float(h), 2))
        for la, lo2, h in zip(lats, lons, heights)
    ]

    return QueryResponse(matches=matches, sampled_match_count=sampled_count, truncated=truncated)


# ---------------------------------------------------------------------------
# Canlı takip: WebSocket üzerinden sanal rota + particle filter akışı
# ---------------------------------------------------------------------------
@app.websocket("/ws/track")
async def ws_track(
    websocket: WebSocket,
    n_particles: int = 1500,
    interval_ms: int = 700,
    sigma_elev: float = 3.0,
    step_deg: float = 0.0015,
    heading_noise_std: float = 0.35,
    process_noise_deg: float = 0.0004,
    injection_ratio: float = 0.02,
    resample_threshold_ratio: float = 0.5,
    cluster_threshold: float = 0.05,
    cluster_cell_deg: float = 0.01,
    seed: Optional[int] = None,
):
    if dem is None:
        await websocket.close(code=1011)
        return

    await websocket.accept()

    simulator = PathSimulator(
        dem, step_deg=step_deg, measurement_noise_std=sigma_elev, seed=seed
    )
    pf = ParticleFilter(
        dem,
        n_particles=n_particles,
        sigma_elev=sigma_elev,
        process_noise_deg=process_noise_deg,
        injection_ratio=injection_ratio,
        resample_threshold_ratio=resample_threshold_ratio,
        seed=seed,
    )
    heading_rng = np.random.default_rng(None if seed is None else seed + 1)

    step = 0
    try:
        while True:
            lat, lon, true_elev, measured, true_heading = simulator.step()
            noisy_heading = true_heading + heading_rng.normal(0, heading_noise_std)

            # 1) Bu adımın tahminini hesapla (predict + update + belki resample).
            #    inject_random() BİLEREK burada çağrılmıyor -- aşağıya bak.
            pf.step(measured, noisy_heading, step_deg)

            est_lat, est_lon = pf.estimate()
            clusters = pf.clusters(min_fraction=cluster_threshold, cell_deg=cluster_cell_deg)
            step += 1

            w = pf.weights
            w_norm = (w / w.max()) if w.max() > 0 else w

            payload = {
                "type": "step",
                "step": step,
                "true": {"lat": lat, "lon": lon, "elevation": true_elev},
                "measured_elevation": measured,
                "estimate": {"lat": est_lat, "lon": est_lon},
                "clusters": clusters,
                "ess": pf.effective_sample_size(),
                "particles": {
                    "lat": np.round(pf.lats, 6).tolist(),
                    "lon": np.round(pf.lons, 6).tolist(),
                    "w": np.round(w_norm, 4).tolist(),
                },
            }
            await websocket.send_json(payload)

            # 2) Tahmin gönderildikten SONRA rejuvenation uygula -- bu adımın
            #    sonucunu etkilemeden, bir sonraki predict() turuna hazırlık.
            pf.inject_random()

            await asyncio.sleep(interval_ms / 1000)
    except WebSocketDisconnect:
        pass
