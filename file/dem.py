"""
DEM (Digital Elevation Model) okuma katmanı.

Tasarım kararı: dosyayı her sorguda diskten açıp taramak yerine, tüm raster'ı
tek seferde RAM'e yüklüyoruz. Particle filter saniyede binlerce kez
(parçacık sayısı x adım sayısı) yükseklik sorgusu yapacağı için, bu vektörize
numpy erişimi olmadan gerçek zamanlı çalışmak mümkün değil.

DEM dosyasının EPSG:4326 (lat/lon, coğrafi) projeksiyonunda olduğunu varsayar.
Projeksiyonlu (örn. EPSG:3857) bir dosya verilirse, koordinatlar yanlış
yorumlanır -- bu yüzden pipeline'da hep "_4326.tif" dosyasını kullanıyoruz.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio


class DEM:
    def __init__(self, path: Path):
        self.path = path
        if not path.exists():
            raise FileNotFoundError(f"DEM file not found: {path}")

        with rasterio.open(path) as ds:
            if ds.crs is not None and ds.crs.to_epsg() != 4326:
                raise ValueError(
                    f"DEM CRS is {ds.crs}, expected EPSG:4326. "
                    "Reproject with gdalwarp -t_srs EPSG:4326 first."
                )
            self.data = ds.read(1).astype(np.float32)
            self.nodata = ds.nodata
            self.transform = ds.transform
            self.inv_transform = ~ds.transform
            self.height, self.width = self.data.shape
            b = ds.bounds
            self.west, self.south, self.east, self.north = b.left, b.bottom, b.right, b.top

        if self.nodata is not None:
            self.data[self.data == self.nodata] = np.nan

        finite = self.data[np.isfinite(self.data)]
        self.elev_min = float(finite.min()) if finite.size else float("nan")
        self.elev_max = float(finite.max()) if finite.size else float("nan")

    def elevation_at(self, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
        """Verilen lat/lon dizileri için yükseklikleri vektörize şekilde döndürür.
        Sınır dışı veya nodata noktalar için NaN döner."""
        cols, rows = self.inv_transform * (lons, lats)
        rows = np.round(rows).astype(np.int64)
        cols = np.round(cols).astype(np.int64)

        valid = (rows >= 0) & (rows < self.height) & (cols >= 0) & (cols < self.width)
        elev = np.full(lats.shape, np.nan, dtype=np.float32)
        elev[valid] = self.data[rows[valid], cols[valid]]
        return elev

    def is_inside(self, lat: float, lon: float) -> bool:
        return self.west <= lon <= self.east and self.south <= lat <= self.north
