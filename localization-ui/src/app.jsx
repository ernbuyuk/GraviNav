import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import {
  filterByHeight,
  haversineMeters
} from "./lib/localization.js";

const DEFAULT_TILE_URL = "http://localhost:8080/data/Copernicus_DSM_10_N40_00_E029_00_DEM/{z}/{x}/{y}.png";
const DEFAULT_CENTER = { lat: 40.8842, lon: 29.2615 };
const DEFAULT_DEM_API_URL = "http://localhost:8090";

function parseCells(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && Array.isArray(payload.cells)) {
    return payload.cells;
  }
  return [];
}

function toGeoJsonPoints(candidates) {
  return {
    type: "FeatureCollection",
    features: candidates.map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: { height: c.height }
    }))
  };
}

function toGeoJsonLine(points) {
  if (!points || points.length < 2) {
    return { type: "FeatureCollection", features: [] };
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: points.map((p) => [p.lon, p.lat])
        },
        properties: {}
      }
    ]
  };
}

function toGeoJsonSegments(segments) {
  return {
    type: "FeatureCollection",
    features: segments.map((s) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [s.from.lon, s.from.lat],
          [s.to.lon, s.to.lat]
        ]
      },
      properties: {}
    }))
  };
}

function toGeoJsonCircle(center, radiusMeters, steps = 96) {
  if (!center) {
    return { type: "FeatureCollection", features: [] };
  }

  const earthRadius = 6371000;
  const latRad = (center.lat * Math.PI) / 180;
  const lonRad = (center.lon * Math.PI) / 180;
  const angularDistance = radiusMeters / earthRadius;

  const coordinates = [];

  for (let i = 0; i <= steps; i += 1) {
    const bearing = (2 * Math.PI * i) / steps;
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinAng = Math.sin(angularDistance);
    const cosAng = Math.cos(angularDistance);

    const lat2 = Math.asin(
      sinLat * cosAng +
        cosLat * sinAng * Math.cos(bearing)
    );

    const lon2 = lonRad + Math.atan2(
      Math.sin(bearing) * sinAng * cosLat,
      cosAng - sinLat * Math.sin(lat2)
    );

    coordinates.push([
      (lon2 * 180) / Math.PI,
      (lat2 * 180) / Math.PI
    ]);
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [coordinates]
        },
        properties: { radiusMeters }
      }
    ]
  };
}

function toGeoJsonBranchLines(branches) {
  return {
    type: "FeatureCollection",
    features: branches
      .filter((branch) => Array.isArray(branch) && branch.length >= 1)
      .map((branch) => ({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: branch.map((p) => [p.lon, p.lat])
        },
        properties: {}
      }))
  };
}

export default function App() {
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);

  const [mapSize, setMapSize] = useState({ width: 0, height: 0 });
  const [mapLoaded, setMapLoaded] = useState(false);

  const [tileUrl, setTileUrl] = useState(DEFAULT_TILE_URL);
  const [demApiUrl, setDemApiUrl] = useState(DEFAULT_DEM_API_URL);
  const [demOpacity, setDemOpacity] = useState(0.7);
  const [demVisible, setDemVisible] = useState(true);
  const [cells, setCells] = useState([]);
  const [startNodes, setStartNodes] = useState([]);
  const [activeNodes, setActiveNodes] = useState([]);
  const [pathBranches, setPathBranches] = useState([]);
  const [status, setStatus] = useState("Load a grid JSON to begin.");

  const [heightInput, setHeightInput] = useState("321.0");
  const [toleranceInput, setToleranceInput] = useState("0.6");
  const [distanceInput, setDistanceInput] = useState("200");

  const pathGeo = useMemo(() => toGeoJsonBranchLines(pathBranches), [pathBranches]);
  const radiusCenter = useMemo(() => {
    if (activeNodes.length > 0) {
      const sum = activeNodes.reduce(
        (acc, node) => ({ lat: acc.lat + node.lat, lon: acc.lon + node.lon }),
        { lat: 0, lon: 0 }
      );
      return {
        lat: sum.lat / activeNodes.length,
        lon: sum.lon / activeNodes.length
      };
    }

    if (startNodes.length > 0) {
      const sum = startNodes.reduce(
        (acc, node) => ({ lat: acc.lat + node.lat, lon: acc.lon + node.lon }),
        { lat: 0, lon: 0 }
      );
      return {
        lat: sum.lat / startNodes.length,
        lon: sum.lon / startNodes.length
      };
    }

    return null;
  }, [activeNodes, startNodes]);
  const radiusGeo = useMemo(() => toGeoJsonCircle(radiusCenter, 200), [radiusCenter]);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#f2efe9" }
          }
        ]
      },
      center: [DEFAULT_CENTER.lon, DEFAULT_CENTER.lat],
      zoom: 12
    });

    mapRef.current = map;

    map.on("load", () => {
      // Add a public OSM raster basemap as a visible fallback
      map.addSource("osm", {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256
      });

      map.addLayer({
        id: "osm-layer",
        type: "raster",
        source: "osm",
        paint: { "raster-opacity": 1 }
      });

      setMapLoaded(true);

      // update initial container size for debugging
      const el = mapContainerRef.current;
      if (el) {
        setMapSize({ width: el.clientWidth, height: el.clientHeight });
      }

      window.addEventListener("resize", () => {
        const el2 = mapContainerRef.current;
        if (el2) setMapSize({ width: el2.clientWidth, height: el2.clientHeight });
      });

      map.addSource("dem", {
        type: "raster",
        tiles: [tileUrl],
        tileSize: 256
      });

      map.addLayer({
        id: "dem-layer",
        type: "raster",
        source: "dem",
        paint: { "raster-opacity": demOpacity }
      });

      map.addSource("search-radius", {
        type: "geojson",
        data: radiusGeo
      });

      map.addLayer({
        id: "search-radius-fill",
        type: "fill",
        source: "search-radius",
        paint: {
          "fill-color": "#ff7a00",
          "fill-opacity": 0.12
        }
      });

      map.addLayer({
        id: "search-radius-line",
        type: "line",
        source: "search-radius",
        paint: {
          "line-color": "#ff7a00",
          "line-width": 2,
          "line-opacity": 0.8
        }
      });

      map.addSource("path-branches", {
        type: "geojson",
        data: pathGeo
      });

      map.addLayer({
        id: "path-lines",
        type: "line",
        source: "path-branches",
        paint: {
          "line-color": "#0057ff",
          "line-width": 4,
          "line-opacity": 0.9
        }
      });

      // Load static chain overlay (pre-generated) and draw it in orange
      fetch('/data/static-grid.geojson')
        .then((r) => r.json())
        .then((geo) => {
          map.addSource('static-grid', { type: 'geojson', data: geo });

          map.addLayer({
            id: 'static-grid-line',
            type: 'line',
            source: 'static-grid',
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': '#1e6bff', 'line-width': 3 }
          });

          map.addLayer({
            id: 'static-grid-points',
            type: 'circle',
            source: 'static-grid',
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
              'circle-radius': 4,
              'circle-color': '#1e6bff',
              'circle-stroke-width': 1,
              'circle-stroke-color': '#ffffff'
            }
          });

          const lineFeature = geo.features?.find(
            (f) => f?.geometry?.type === 'LineString' && Array.isArray(f.geometry.coordinates)
          );
          const coords = lineFeature?.geometry?.coordinates || [];
          if (coords.length > 1) {
            const lons = coords.map((c) => c[0]);
            const lats = coords.map((c) => c[1]);
            const sw = [Math.min(...lons), Math.min(...lats)];
            const ne = [Math.max(...lons), Math.max(...lats)];
            map.fitBounds([sw, ne], {
              padding: { top: 80, bottom: 260, left: 420, right: 80 },
              duration: 0
            });
          }
        })
        .catch((err) => {
          setStatus(`Static path load failed: ${err.message}`);
        });
    });

    return () => map.remove();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }

    const source = map.getSource("dem");
    if (source) {
      map.removeLayer("dem-layer");
      map.removeSource("dem");
    }

    map.addSource("dem", {
      type: "raster",
      tiles: [tileUrl],
      tileSize: 256
    });

    map.addLayer({
      id: "dem-layer",
      type: "raster",
      source: "dem",
      paint: { "raster-opacity": demOpacity }
    }, "path-lines");
    if (!demVisible) {
      try { map.setLayoutProperty('dem-layer', 'visibility', 'none'); } catch (e) {}
    }
  }, [tileUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    try {
      map.setPaintProperty("dem-layer", "raster-opacity", demOpacity);
      map.setLayoutProperty("dem-layer", "visibility", demVisible ? "visible" : "none");
    } catch (err) {
      // layer might not exist yet
    }
  }, [demOpacity, demVisible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }
    const source = map.getSource("search-radius");
    if (source) {
      source.setData(radiusGeo);
    }
  }, [radiusGeo]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }
    const source = map.getSource("path-branches");
    if (source) {
      source.setData(pathGeo);
    }
  }, [pathGeo]);

  const handleFile = async (file) => {
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const parsed = parseCells(payload)
        .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon) && Number.isFinite(c.height));
      setCells(parsed);
      setStartNodes([]);
      setActiveNodes([]);
      setPathBranches([]);
      setStatus(`Loaded ${parsed.length} grid cells.`);

      if (parsed.length > 0) {
        mapRef.current?.flyTo({
          center: [parsed[0].lon, parsed[0].lat],
          zoom: 13,
          essential: true
        });
      }
    } catch (err) {
      setStatus(`Failed to parse JSON: ${err.message}`);
    }
  };

  const addObservation = async () => {
    const height = Number(heightInput);
    const tolerance = Number(toleranceInput);
    const maxDistance = Number(distanceInput);

    if (!Number.isFinite(height) || !Number.isFinite(tolerance) || !Number.isFinite(maxDistance)) {
      setStatus("Height, tolerance, and distance must be valid numbers.");
      return;
    }

    let sourceCells = cells;

    // If no uploaded grid is present, query the DEM API directly.
    if (sourceCells.length === 0) {
      try {
        const response = await fetch(`${demApiUrl}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            height,
            tolerance,
            stride: 4,
            max_points: 5000
          })
        });

        if (!response.ok) {
          throw new Error(`DEM API error: ${response.status}`);
        }

        const payload = await response.json();
        sourceCells = Array.isArray(payload.matches) ? payload.matches : [];
        if (sourceCells.length === 0) {
          setStartNodes([]);
          setActiveNodes([]);
          setPathBranches([]);
          setStatus("No DEM matches for this observation.");
          return;
        }
      } catch (err) {
        setStatus(`DEM API request failed: ${err.message}`);
        return;
      }
    }

    const matches = filterByHeight(sourceCells, height, tolerance);

    if (activeNodes.length === 0) {
      if (matches.length === 0) {
        setStartNodes([]);
        setActiveNodes([]);
        setPathBranches([]);
        setStatus("No initial candidates found for this observation.");
        return;
      }

      setStartNodes(matches);
      setActiveNodes(matches);
      setPathBranches(matches.map((match) => [match]));
      setStatus(`Initial candidates: ${matches.length}`);
      return;
    }

    const nextMap = new Map();
    const nextBranches = [];

    for (const branch of pathBranches.length > 0 ? pathBranches : activeNodes.map((node) => [node])) {
      const prevCandidate = branch[branch.length - 1];
      for (const match of matches) {
        if (haversineMeters(prevCandidate, match) <= maxDistance) {
          nextBranches.push([...branch, match]);
          const key = `${match.lat.toFixed(6)}|${match.lon.toFixed(6)}|${match.height.toFixed(2)}`;
          if (!nextMap.has(key)) {
            nextMap.set(key, match);
          }
        }
      }
    }

    const nextCandidates = [...nextMap.values()];

    if (nextCandidates.length === 0) {
      setStartNodes([]);
      setActiveNodes([]);
      setPathBranches([]);
      setStatus("New observation did not match previous paths. Paths cleared.");
      return;
    }

    setActiveNodes(nextCandidates);
    setPathBranches(nextBranches);
    setStatus(`Candidates: ${nextCandidates.length} | Branches: ${nextBranches.length}`);
  };

  const reset = () => {
    setStartNodes([]);
    setActiveNodes([]);
    setPathBranches([]);
    setStatus("Reset complete.");
  };

  return (
    <div className="app">
      <aside className="panel">
        <div>
          <div className="badge">Motion-Constrained Localization</div>
          <h1>Height-Matching Console</h1>
        </div>

        <div className="field">
          <label htmlFor="tileUrl">Raster tile template</label>
          <input
            id="tileUrl"
            value={tileUrl}
            onChange={(event) => setTileUrl(event.target.value)}
            placeholder="http://localhost:8080/data/{id}/{z}/{x}/{y}.png"
          />
        </div>

        <div className="field">
          <label htmlFor="demApiUrl">DEM API URL (grid yoksa buradan sorgular)</label>
          <input
            id="demApiUrl"
            value={demApiUrl}
            onChange={(event) => setDemApiUrl(event.target.value)}
            placeholder="http://localhost:8090"
          />
        </div>

        <div className="field">
          <label>DEM overlay</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="range" min="0" max="1" step="0.05" value={demOpacity} onChange={(e) => setDemOpacity(Number(e.target.value))} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={demVisible} onChange={(e) => setDemVisible(e.target.checked)} /> Show
            </label>
          </div>
        </div>

        <div className="field">
          <label>Grid JSON</label>
          <input
            type="file"
            accept="application/json"
            onChange={(event) => handleFile(event.target.files?.[0])}
          />
        </div>

        <div className="field">
          <label htmlFor="height">Observation height (m)</label>
          <input
            id="height"
            value={heightInput}
            onChange={(event) => setHeightInput(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="tolerance">Height tolerance (m)</label>
          <input
            id="tolerance"
            value={toleranceInput}
            onChange={(event) => setToleranceInput(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="distance">Max step distance (m)</label>
          <input
            id="distance"
            value={distanceInput}
            onChange={(event) => setDistanceInput(event.target.value)}
          />
        </div>

        <div className="field">
          <button type="button" onClick={addObservation}>Add observation</button>
        </div>

        <div className="field">
          <button className="secondary" type="button" onClick={reset}>Reset</button>
        </div>

        <div className="stat">
          <span>Grid cells</span>
          <strong>{cells.length}</strong>
        </div>
        <div className="stat">
          <span>Current candidates</span>
          <strong>{activeNodes.length}</strong>
        </div>
        <div className="stat">
          <span>Path branches</span>
          <strong>{pathBranches.length}</strong>
        </div>

        <div className="status">{status}</div>
      </aside>

      <section className="map-wrap">
        <div ref={mapContainerRef} className="map" />
        <div style={{ position: "absolute", top: 12, left: 12, zIndex: 10 }}>
          <div className="badge">Map: {mapLoaded ? "loaded" : "not loaded"}</div>
          <div style={{ marginTop: 6, padding: "6px 10px", background: "rgba(255,255,255,0.9)", borderRadius: 8, fontSize: 12 }}>
            <div>W: {mapSize.width}px</div>
            <div>H: {mapSize.height}px</div>
          </div>
        </div>
      </section>
    </div>
  );
}
