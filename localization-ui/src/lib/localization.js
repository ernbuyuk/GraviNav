const EARTH_RADIUS_M = 6371000;

export function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);

  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function filterByHeight(cells, height, tolerance) {
  return cells.filter((c) => Math.abs(c.height - height) <= tolerance);
}

export function updateCandidates(cells, height, tolerance, prevCandidates, maxDistance) {
  const matches = filterByHeight(cells, height, tolerance);

  if (!prevCandidates || prevCandidates.length === 0) {
    return matches;
  }

  return matches.filter((m) =>
    prevCandidates.some((p) => haversineMeters(m, p) <= maxDistance)
  );
}

export function centroid(candidates) {
  if (!candidates || candidates.length === 0) {
    return null;
  }

  const sum = candidates.reduce(
    (acc, c) => ({
      lat: acc.lat + c.lat,
      lon: acc.lon + c.lon
    }),
    { lat: 0, lon: 0 }
  );

  return {
    lat: sum.lat / candidates.length,
    lon: sum.lon / candidates.length
  };
}
