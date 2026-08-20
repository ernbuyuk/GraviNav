# GraviNav

Kısa açıklama
---------------
GraviNav, bir DEM (Digital Elevation Model) üzerinden Terrain-Referenced Navigation (TRN) fikrini gösteren küçük bir prototip/proje paketidir. Proje:

- Raster (DEM) veri kaynağını servis eder (tileserver)
- DEM üzerinde yükseklik eşleştirme sorguları sağlar (`dem-api` veya bellek tabanlı backend)
- Bir simülasyon + parçacık filtresi (particle filter) ile gerçek-zamanlı takip gösterir
- React tabanlı bir ön yüz ile görselleştirir

Klasörlerin kısa rolü
--------------------
- `file/`: Ana Python demo backend ve TRN mantığı
  - `main.py`: RAM'e yüklenen DEM ile FastAPI tabanlı backend; `/dem/info`, `/query` ve WebSocket `/ws/track` endpoint'leri (tercih edilen demo).
  - `dem.py`: `DEM` sınıfı — GeoTIFF'i belleğe yükler, lat/lon ↔ piksel dönüşümleri ve vektörize yükseklik sorgusu sağlar (EPSG:4326 bekler).
  - `particle_filter.py`: Particle filter implementasyonu (predict, update, resample, inject_random, estimate, clusters).
  - `simulation.py`: `PathSimulator` — DEM sınırları içinde simüle rota ve gürültülü yükseklik ölçümleri üretir.

- `dem-api/`: Alternatif / legacy DEM sorgu servisi (diskten blok-blok okur). Küçük DEM sorguları için basit bir servis olarak kullanılır. (Hız/performans için `file/main.py` tercih edilir.)

- `localization-ui/`: React + Vite ön yüzü
  - `src/TrackerApp.jsx`, `src/app.jsx`: Harita ve kontrol panelleri, WebSocket veya DEM sorguları ile veri çeker.
  - `src/lib/localization.js`: yardımcı fonksiyonlar (haversine, filtre, centroid).
  - `public/data/static-grid.geojson`: örnek statik rota/ızgara.

- `tileserver/`: DEM GeoTIFF → MBTiles oluşturma ve tile server (docker-compose) konfigurasyonu. Frontend bu sunucudan raster tiles alır.

Nasıl çalıştırılır (kısa)
-------------------------
1) Tile server (tiles)

	- `tileserver/` dizininde MBTiles oluşturduktan sonra docker ile çalıştırın:

```bash
cd tileserver
docker compose up
```

	- Tile server varsayılan olarak `http://localhost:8080` üzerinde çalışır. Ön yüzde bu URL tile kaynağı olarak kullanılır.

2) Backend (tercih edilen: RAM yüklü DEM)

	- `file/` dizinindeki backend, büyük DEM'leri belleğe yükleyip hızlı vektörize sorgular ve WebSocket tabanlı TRN simülasyonu sağlar.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r file/requirements.txt
uvicorn file.main:app --reload --host 0.0.0.0 --port 8000
```

	- Sağlık kontrolü: `http://localhost:8000/health`
	- DEM bilgisi (frontend merkezleme için): `http://localhost:8000/dem/info`
	- WebSocket TRN akışı: `ws://localhost:8000/ws/track` (tracker frontend bu endpoint'e bağlanır)

3) Alternatif: `dem-api` (hafif, blok-okuyucu servis)

	- Küçük veya diskten okunan DEM aramaları için ek bir servis. `localization-ui` DEM yokken veya ayrı bir API kullanmak istendiğinde `http://localhost:8090` üzerinden sorgu yapar.

```bash
pip install -r dem-api/requirements.txt
uvicorn dem-api.app:app --reload --port 8090
```

4) Frontend (visualization)

```bash
cd localization-ui
npm install
npm run dev
```

	- Giriş sayfası, tile URL ve (isteğe bağlı) dem-api adresini kullanarak gözlemleri ekler veya WebSocket tracker'ı dinler.

Kısa notlar / ipuçları
----------------------
- `file/DEM` sınıfı EPSG:4326 (coğrafi lat/lon) bekler — Web Mercator (3857) kullanıyorsanız önce reprojection yapın (`gdalwarp -t_srs EPSG:4326 ...`).
- `dem-api` sadece alternatif bir yol olup diskten blok-blok okur; büyük DEM'lerde performans düşebilir, dolayısıyla gerçek zamanlı izleme için `file/main.py`'deki bellek yaklaşımı tercih edilir.
- WebSocket akışında `main.py` simülatör bir ölçüm üretir, particle filter predict+update yapar, `estimate`/`clusters`/`particles` JSON olarak gönderilir ve frontend bunları çizer.



