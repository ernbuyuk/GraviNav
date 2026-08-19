// GraviNav TRN Tracker
//
// Kurulum (kendi React projende):
//   npm install maplibre-gl
//
// Bu dosya kendi başına bir Vite/CRA projesine bağımlı; Claude'un artifact
// önizlemesinde maplibre-gl paketi mevcut olmayabilir, bu yüzden kendi build
// sisteminde (npm run dev) test etmen gerekir.
//
// Varsayımlar:
//   - Tileserver http://localhost:8080 üzerinde "combined" stiliyle çalışıyor
//   - Backend http://localhost:8000 üzerinde çalışıyor (main.py)
// Farklıysa aşağıdaki iki sabiti güncelle.

import { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const TILESERVER_STYLE_URL = "http://localhost:8080/styles/combined/style.json";
const BACKEND_HTTP_URL = "http://localhost:8000";
const BACKEND_WS_BASE = "ws://localhost:8000/ws/track";

// Panelden ayarlanabilecek parametreler ve varsayılan değerleri.
// Her parametrenin backend'deki (main.py) karşılığı aynı isimle query param.
const DEFAULT_PARAMS = {
  n_particles: 1500,
  interval_ms: 700,
  sigma_elev: 3.0,
  step_deg: 0.0015,
  heading_noise_std: 0.2,
  process_noise_deg: 0.0004,
  injection_ratio: 0.01,
  resample_threshold_ratio: 0.25,
  cluster_threshold: 0.05,
  cluster_cell_deg: 0.01,
};

const PARAM_FIELDS = [
  { key: "n_particles", label: "parçacık sayısı", min: 100, max: 10000, step: 100 },
  { key: "interval_ms", label: "adım aralığı (ms)", min: 100, max: 3000, step: 100 },
  { key: "sigma_elev", label: "sensör gürültüsü σ (m)", min: 0.1, max: 20, step: 0.1 },
  { key: "step_deg", label: "adım büyüklüğü (derece)", min: 0.0002, max: 0.01, step: 0.0002 },
  { key: "heading_noise_std", label: "yön belirsizliği (rad)", min: 0, max: 1.5, step: 0.05 },
  { key: "process_noise_deg", label: "konum başıboşluğu (derece)", min: 0.00005, max: 0.002, step: 0.00005 },
  { key: "injection_ratio", label: "rejuvenation oranı", min: 0, max: 0.2, step: 0.01 },
  { key: "resample_threshold_ratio", label: "resample eşiği (oran)", min: 0.05, max: 0.9, step: 0.05 },
  { key: "cluster_threshold", label: "küme eşiği (olasılık)", min: 0.01, max: 0.5, step: 0.01 },
  { key: "cluster_cell_deg", label: "küme hücre boyutu (derece)", min: 0.002, max: 0.05, step: 0.002 },
];

function buildWsUrl(params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${BACKEND_WS_BASE}?${qs}`;
}

export default function TrackerApp() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const wsRef = useRef(null);
  const mapReadyRef = useRef(false);

  const [status, setStatus] = useState("bağlanıyor...");
  const [stats, setStats] = useState({ step: 0, measured: null, ess: null, clusterCount: null });
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [panelOpen, setPanelOpen] = useState(true);

  const clearMapSources = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    ["particles", "truth", "estimate", "clusters"].forEach((id) => {
      if (map.getSource(id)) map.getSource(id).setData(emptyFC());
    });
  }, []);

  const connectSocket = useCallback((currentParams) => {
    wsRef.current?.close();
    setStatus("bağlanıyor...");

    const ws = new WebSocket(buildWsUrl(currentParams));
    wsRef.current = ws;

    ws.onopen = () => setStatus("bağlı");
    ws.onclose = () => setStatus("bağlantı kesildi");
    ws.onerror = () => setStatus("hata");

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type !== "step") return;

      const map = mapRef.current;
      if (!map || !map.getSource("particles")) return;

      const particleFeatures = msg.particles.lat.map((lat, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [msg.particles.lon[i], lat] },
        properties: { w: msg.particles.w[i] },
      }));
      map.getSource("particles").setData({ type: "FeatureCollection", features: particleFeatures });

      map.getSource("truth").setData(pointFC(msg.true.lon, msg.true.lat));
      map.getSource("estimate").setData(pointFC(msg.estimate.lon, msg.estimate.lat));

      const clusterFeatures = (msg.clusters || []).map((c) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        properties: { probability: c.probability },
      }));
      map.getSource("clusters").setData({ type: "FeatureCollection", features: clusterFeatures });

      setStats({ step: msg.step, measured: msg.measured_elevation, ess: msg.ess, clusterCount: clusterFeatures.length });
    };
  }, []);

  const handleApply = useCallback(() => {
    clearMapSources();
    setStats({ step: 0, measured: null, ess: null, clusterCount: null });
    connectSocket(params);
  }, [params, connectSocket, clearMapSources]);

  const handleReset = useCallback(() => {
    setParams(DEFAULT_PARAMS);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      let center = [29.5, 40.5];
      try {
        const res = await fetch(`${BACKEND_HTTP_URL}/dem/info`);
        const info = await res.json();
        center = [info.center.lon, info.center.lat];
      } catch {
        // backend henüz ayakta değilse varsayılan merkezi kullan
      }

      if (cancelled) return;

      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: TILESERVER_STYLE_URL,
        center,
        zoom: 10,
      });
      mapRef.current = map;

      map.on("load", () => {
        map.setTerrain({ source: "terrain-dem", exaggeration: 1.0 });

        map.addSource("particles", { type: "geojson", data: emptyFC() });
        map.addLayer({
          id: "particles-layer",
          type: "circle",
          source: "particles",
          paint: {
            "circle-radius": 3,
            "circle-color": "#38bdf8",
            "circle-opacity": ["interpolate", ["linear"], ["get", "w"], 0, 0.05, 1, 0.85],
          },
        });

        map.addSource("truth", { type: "geojson", data: emptyFC() });
        map.addLayer({
          id: "truth-layer",
          type: "circle",
          source: "truth",
          paint: {
            "circle-radius": 6,
            "circle-color": "#ef4444",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });

        map.addSource("estimate", { type: "geojson", data: emptyFC() });
        map.addLayer({
          id: "estimate-layer",
          type: "circle",
          source: "estimate",
          paint: {
            "circle-radius": 9,
            "circle-color": "#f59e0b",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });

        map.addSource("clusters", { type: "geojson", data: emptyFC() });
        map.addLayer({
          id: "clusters-layer",
          type: "circle",
          source: "clusters",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["get", "probability"], 0.05, 10, 1.0, 34],
            "circle-color": "#a78bfa",
            "circle-opacity": 0.35,
            "circle-stroke-width": 2,
            "circle-stroke-color": "#a78bfa",
          },
        });
        map.addLayer({
          id: "clusters-label",
          type: "symbol",
          source: "clusters",
          layout: {
            "text-field": ["concat", ["to-string", ["round", ["*", ["get", "probability"], 100]]], "%"],
            "text-size": 12,
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "#000000",
            "text-halo-width": 1.2,
          },
        });

        mapReadyRef.current = true;
        connectSocket(params);
      });
    }

    init();

    return () => {
      cancelled = true;
      wsRef.current?.close();
      mapRef.current?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100vh", background: "#0b0f14" }}>
      <div ref={mapContainerRef} style={{ position: "absolute", inset: 0 }} />

      <div style={panelStyle}>
        <div style={{ fontWeight: 600, marginBottom: 6, letterSpacing: 0.5 }}>GRAVINAV — TRN TRACKER</div>
        <Row label="durum" value={status} />
        <Row label="adım" value={stats.step} />
        <Row label="ölçülen yükseklik" value={stats.measured != null ? `${stats.measured.toFixed(1)} m` : "-"} />
        <Row label="etkin parçacık sayısı" value={stats.ess != null ? stats.ess.toFixed(0) : "-"} />
        <Row label="olası bölge sayısı" value={stats.clusterCount ?? "-"} />
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          <Legend color="#ef4444" label="gerçek konum (simülasyon)" />
          <Legend color="#f59e0b" label="ağırlıklı ortalama" />
          <Legend color="#a78bfa" label="olası bölge (%eşik üstü küme)" />
          <Legend color="#38bdf8" label="parçacık bulutu" />
        </div>
      </div>

      <div style={settingsPanelStyle}>
        <div
          onClick={() => setPanelOpen((v) => !v)}
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
        >
          <span style={{ fontWeight: 600, letterSpacing: 0.5 }}>İNCE AYAR</span>
          <span style={{ opacity: 0.6 }}>{panelOpen ? "▾" : "▸"}</span>
        </div>

        {panelOpen && (
          <>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              {PARAM_FIELDS.map((f) => (
                <div key={f.key}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                    <span style={{ opacity: 0.7 }}>{f.label}</span>
                    <span>{params[f.key]}</span>
                  </div>
                  <input
                    type="range"
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={params[f.key]}
                    onChange={(e) =>
                      setParams((p) => ({ ...p, [f.key]: parseFloat(e.target.value) }))
                    }
                    style={{ width: "100%" }}
                  />
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button onClick={handleApply} style={applyButtonStyle}>
                Uygula (Yeniden Başlat)
              </button>
              <button onClick={handleReset} style={resetButtonStyle}>
                Sıfırla
              </button>
            </div>
            <div style={{ marginTop: 6, fontSize: 11, opacity: 0.5 }}>
              Uygula, mevcut simülasyonu kapatıp yeni parametrelerle sıfırdan başlatır.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Legend({ color, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
      <span style={{ opacity: 0.85 }}>{label}</span>
    </div>
  );
}

function emptyFC() {
  return { type: "FeatureCollection", features: [] };
}

function pointFC(lon, lat) {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: {} }],
  };
}

const panelStyle = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 1,
  background: "rgba(10,14,20,0.85)",
  color: "#e5e7eb",
  padding: "14px 18px",
  borderRadius: 10,
  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
  fontSize: 13,
  lineHeight: 1.7,
  minWidth: 240,
  border: "1px solid rgba(255,255,255,0.08)",
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
};

const settingsPanelStyle = {
  position: "absolute",
  top: 16,
  right: 16,
  zIndex: 1,
  background: "rgba(10,14,20,0.9)",
  color: "#e5e7eb",
  padding: "14px 18px",
  borderRadius: 10,
  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
  fontSize: 13,
  minWidth: 260,
  maxHeight: "88vh",
  overflowY: "auto",
  border: "1px solid rgba(255,255,255,0.08)",
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
};

const applyButtonStyle = {
  flex: 1,
  background: "#f59e0b",
  color: "#0b0f14",
  border: "none",
  borderRadius: 6,
  padding: "8px 10px",
  fontWeight: 600,
  fontSize: 12,
  cursor: "pointer",
};

const resetButtonStyle = {
  background: "transparent",
  color: "#e5e7eb",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 12,
  cursor: "pointer",
};
