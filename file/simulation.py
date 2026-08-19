"""
Sanal rota üreticisi (Faz 1: gerçek sensör yerine simüle veri).

DEM sınırları içinde yumuşak bir random walk üretir; her adımda "gerçek"
konumu ve o konumun DEM yüksekliğine sensör gürültüsü eklenmiş halini
("ölçülen" yükseklik) döndürür. Particle filter, gerçek konumu HİÇ görmez --
sadece ölçülen yüksekliği görür, tıpkı gerçek bir sensörden geliyormuş gibi.
Gerçek konum sadece bizim (debug/görselleştirme amaçlı) doğrulama yapmamız için var.
"""
from __future__ import annotations

import numpy as np

from dem import DEM


class PathSimulator:
    def __init__(
        self,
        dem: DEM,
        step_deg: float = 0.0015,
        heading_noise: float = 0.15,
        measurement_noise_std: float = 3.0,
        seed: int | None = None,
    ):
        self.dem = dem
        self.step_deg = step_deg
        self.heading_noise = heading_noise
        self.measurement_noise_std = measurement_noise_std
        self.rng = np.random.default_rng(seed)

        # Haritanın kenarlarına çok yakın başlamayalım (DEM dışına taşma riskini azaltır)
        margin_lat = 0.1 * (dem.north - dem.south)
        margin_lon = 0.1 * (dem.east - dem.west)

        for _ in range(200):
            lat = self.rng.uniform(dem.south + margin_lat, dem.north - margin_lat)
            lon = self.rng.uniform(dem.west + margin_lon, dem.east - margin_lon)
            elev = dem.elevation_at(np.array([lat]), np.array([lon]))[0]
            if np.isfinite(elev):
                self.lat, self.lon = lat, lon
                break
        else:
            raise RuntimeError("DEM içinde geçerli bir başlangıç noktası bulunamadı")

        self.heading = self.rng.uniform(0, 2 * np.pi)

    def step(self):
        """Bir adım ilerler. Dönüş: (lat, lon, true_elevation, measured_elevation, heading)"""
        for _ in range(20):
            candidate_heading = self.heading + self.rng.normal(0, self.heading_noise)
            dlat = self.step_deg * np.cos(candidate_heading)
            dlon = self.step_deg * np.sin(candidate_heading)
            new_lat = self.lat + dlat
            new_lon = self.lon + dlon

            if not self.dem.is_inside(new_lat, new_lon):
                # Sınıra çarptıysa yön değiştirip tekrar dene
                self.heading += np.pi / 2
                continue

            elev = self.dem.elevation_at(np.array([new_lat]), np.array([new_lon]))[0]
            if not np.isfinite(elev):
                self.heading += np.pi / 2
                continue

            self.lat, self.lon, self.heading = new_lat, new_lon, candidate_heading
            measured = float(elev + self.rng.normal(0, self.measurement_noise_std))
            return self.lat, self.lon, float(elev), measured, self.heading

        # 20 denemede de geçerli bir adım bulunamazsa, yerinde say
        return self.lat, self.lon, None, None, self.heading
