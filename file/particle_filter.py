"""
Terrain-Referenced Navigation için parçacık filtresi (particle filter).

Akış her adımda:
  1. predict()  - parçacıkları hareket modeline göre ileri taşı (+ süreç gürültüsü)
  2. update()   - yeni yükseklik ölçümüyle her parçacığın ağırlığını güncelle
  3. resample() - etkin parçacık sayısı düşükse, düşük ağırlıklıları eleyip
                  yüksek ağırlıklıların etrafında yeniden örnekle

Ağırlıklandırma mantığı: bir parçacığın konumundaki DEM yüksekliği, gerçek
ölçüme ne kadar yakınsa o parçacık o kadar "muhtemel" sayılır. Bu yakınlık
Gauss (normal dağılım) olasılık yoğunluğu ile ölçülür -- sensör gürültüsünü
(sigma_elev) modelliyor.
"""
from __future__ import annotations

import numpy as np

from dem import DEM


class ParticleFilter:
    def __init__(
        self,
        dem: DEM,
        n_particles: int = 1500,
        sigma_elev: float = 3.0,
        process_noise_deg: float = 0.0004,
        injection_ratio: float = 0.02,
        resample_threshold_ratio: float = 0.5,
        seed: int | None = None,
    ):
        self.dem = dem
        self.n = n_particles
        self.sigma_elev = sigma_elev
        self.process_noise = process_noise_deg
        self.injection_ratio = injection_ratio
        # Etkin parçacık sayısı (ESS) bu oranın altına düşene kadar resample
        # TETİKLENMEZ. Düşük değer (örn. 0.1-0.2) = resample nadiren olur,
        # ağırlıklar birden fazla adım boyunca çarpımsal olarak BİRİKİR --
        # yani "kısa vadede belirsiz ama uzun vadede tutarlı" yolları
        # ayırt edebilmek için gereken tam olarak bu. Yüksek değer (0.5-0.9)
        # = sık resample, sistem her adımda yeniden karar verir gibi davranır.
        self.resample_threshold_ratio = resample_threshold_ratio
        self.rng = np.random.default_rng(seed)

        # Başlangıçta parçacıklar DEM sınırları içinde tamamen rastgele --
        # yani başta "haritanın her yeri eşit ihtimalli" varsayımı.
        self.lats = self.rng.uniform(dem.south, dem.north, n_particles)
        self.lons = self.rng.uniform(dem.west, dem.east, n_particles)
        self.weights = np.full(n_particles, 1.0 / n_particles)

    def predict(self, heading_rad: float, step_deg: float) -> None:
        dlat = step_deg * np.cos(heading_rad)
        dlon = step_deg * np.sin(heading_rad)
        noise_lat = self.rng.normal(0, self.process_noise, self.n)
        noise_lon = self.rng.normal(0, self.process_noise, self.n)

        self.lats = np.clip(self.lats + dlat + noise_lat, self.dem.south, self.dem.north)
        self.lons = np.clip(self.lons + dlon + noise_lon, self.dem.west, self.dem.east)

    def update(self, measured_elevation: float) -> None:
        particle_elev = self.dem.elevation_at(self.lats, self.lons)
        valid = np.isfinite(particle_elev)

        diff = np.where(valid, measured_elevation - particle_elev, np.inf)
        likelihood = np.where(
            valid,
            np.exp(-0.5 * (diff / self.sigma_elev) ** 2),
            1e-12,
        )

        self.weights = self.weights * likelihood
        total = self.weights.sum()
        if total <= 0 or not np.isfinite(total):
            # Tüm parçacıklar aşırı uzak düştüyse (örn. sensör outlier'ı),
            # çökmemek için eşit ağırlığa sıfırla.
            self.weights = np.full(self.n, 1.0 / self.n)
        else:
            self.weights = self.weights / total

    def effective_sample_size(self) -> float:
        return float(1.0 / np.sum(self.weights**2))

    def resample(self) -> None:
        """Systematic resampling -- düşük varyanslı, standart particle filter yöntemi."""
        positions = (np.arange(self.n) + self.rng.uniform()) / self.n
        cumulative = np.cumsum(self.weights)
        cumulative[-1] = 1.0
        idx = np.searchsorted(cumulative, positions)

        self.lats = self.lats[idx]
        self.lons = self.lons[idx]

        # Roughening: resample sonrası birebir aynı konumda üst üste yığılan
        # kopya parçacıkları hafifçe dağıt. Bu olmadan filtre zamanla
        # çeşitliliğini kaybedip tek bir noktaya "donar".
        rough_std = 0.3 * self.process_noise
        self.lats = np.clip(
            self.lats + self.rng.normal(0, rough_std, self.n), self.dem.south, self.dem.north
        )
        self.lons = np.clip(
            self.lons + self.rng.normal(0, rough_std, self.n), self.dem.west, self.dem.east
        )

        self.weights = np.full(self.n, 1.0 / self.n)

    def inject_random(self) -> None:
        """Parçacıkların bir kısmını haritada rastgele bir noktaya 'ışınla'.
        Bu, filtrenin yanlış bir bölgeye kilitlenmesi durumunda (sample
        impoverishment) kendini toparlayabilmesi için gereken tek mekanizma --
        onsuz, aday havuzunda hiç doğru bölge kalmayabilir ve sistem oraya
        asla 'bakamaz'."""
        if self.injection_ratio <= 0:
            return
        k = max(1, int(self.n * self.injection_ratio))
        idx = self.rng.choice(self.n, size=k, replace=False)
        self.lats[idx] = self.rng.uniform(self.dem.south, self.dem.north, k)
        self.lons[idx] = self.rng.uniform(self.dem.west, self.dem.east, k)
        # Yeni enjekte edilen parçacıklara ortalama ağırlık ver ki bir sonraki
        # ölçümde adil şekilde değerlendirilsinler, hemen elenmesinler.
        self.weights[idx] = self.weights.mean()
        self.weights /= self.weights.sum()

    def estimate(self) -> tuple[float, float]:
        """Ağırlıklı ortalama -- tek tepeli (unimodal) dağılımlarda iyi çalışır.
        Çok tepeli dağılımlarda (iki ayrı olası bölge varsa) YANILTICI olabilir,
        çünkü iki kümenin ARASINDA bir nokta üretir. Çok tepeli durumda
        clusters() metodunu kullan."""
        est_lat = float(np.average(self.lats, weights=self.weights))
        est_lon = float(np.average(self.lons, weights=self.weights))
        return est_lat, est_lon

    def clusters(self, min_fraction: float = 0.05, cell_deg: float = 0.01) -> list[dict]:
        """Parçacık bulutunu coğrafi hücrelere ayırıp komşu dolu hücreleri
        birleştirerek 'tepe bölgeleri' (olası konum kümeleri) bulur.

        Her küme için toplam ağırlık = o bölgenin toplam olasılığı.
        Sadece toplam olasılığın en az `min_fraction` (örn. 0.05 = %5)
        kadarını taşıyan kümeler döndürülür -- yani "ciddiye alınacak"
        adaylar. Tek küme varsa filtre tek bir bölgede kararlı demektir;
        birden fazla küme varsa hâlâ birden fazla olası konum var demektir.
        """
        col = np.floor((self.lons - self.dem.west) / cell_deg).astype(np.int64)
        row = np.floor((self.lats - self.dem.south) / cell_deg).astype(np.int64)

        cell_weight: dict[tuple[int, int], float] = {}
        cell_indices: dict[tuple[int, int], list[int]] = {}
        for i in range(self.n):
            key = (int(row[i]), int(col[i]))
            cell_weight[key] = cell_weight.get(key, 0.0) + float(self.weights[i])
            cell_indices.setdefault(key, []).append(i)

        visited: set[tuple[int, int]] = set()
        raw_clusters: list[tuple[float, list[int]]] = []

        for start_key in cell_weight:
            if start_key in visited:
                continue
            stack = [start_key]
            comp_keys: list[tuple[int, int]] = []
            while stack:
                k = stack.pop()
                if k in visited or k not in cell_weight:
                    continue
                visited.add(k)
                comp_keys.append(k)
                r, c = k
                for dr in (-1, 0, 1):
                    for dc in (-1, 0, 1):
                        if dr == 0 and dc == 0:
                            continue
                        neighbor = (r + dr, c + dc)
                        if neighbor in cell_weight and neighbor not in visited:
                            stack.append(neighbor)

            total_w = sum(cell_weight[k] for k in comp_keys)
            idxs = [i for k in comp_keys for i in cell_indices[k]]
            raw_clusters.append((total_w, idxs))

        result = []
        for total_w, idxs in raw_clusters:
            if total_w < min_fraction:
                continue
            idx_arr = np.array(idxs)
            w_sub = self.weights[idx_arr]
            c_lat = float(np.average(self.lats[idx_arr], weights=w_sub))
            c_lon = float(np.average(self.lons[idx_arr], weights=w_sub))
            result.append({"lat": c_lat, "lon": c_lon, "probability": float(total_w)})

        result.sort(key=lambda c: c["probability"], reverse=True)
        return result

    def step(self, measured_elevation: float | None, heading_rad: float, step_deg: float) -> None:
        self.predict(heading_rad, step_deg)
        if measured_elevation is not None:
            self.update(measured_elevation)
            if self.effective_sample_size() < self.n * self.resample_threshold_ratio:
                self.resample()
        # NOT: inject_random() burada ÇAĞRILMIYOR. Neden: enjekte edilen
        # parçacıklar henüz yükseklik testinden geçmemiş olur; eğer burada
        # çağrılsaydı, bu adımın tahmini (estimate/clusters) test edilmemiş
        # rastgele noktalardan etkilenirdi. Bunun yerine main.py, o adımın
        # tahminini hesapladıktan SONRA inject_random()'ı ayrıca çağırıp
        # bir sonraki adıma hazırlık yapıyor.
