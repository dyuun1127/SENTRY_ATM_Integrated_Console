// SENTRY owns the simulation clock and local plane. GEV owns only presentation.
export const ARP = Object.freeze({ lat: 36 + 42 / 60 + 59 / 3600, lon: 127 + 29 / 60 + 57 / 3600 });
const RAD = Math.PI / 180;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const W = 1 - E2 * Math.sin(ARP.lat * RAD) ** 2;
const M = 6378137 * (1 - E2) / W ** 1.5 / 1852;
const N = 6378137 / Math.sqrt(W) / 1852;

export function toGeodetic(x, y, altitudeFt) {
  if (![x, y, altitudeFt].every(Number.isFinite)) return null;
  const lat = ARP.lat + y / M / RAD;
  const lon = ARP.lon + x / (N * Math.cos(ARP.lat * RAD)) / RAD;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // Display height only: this does not assert a measured ellipsoid/terrain height.
  return { lat, lon, height: altitudeFt * 0.3048 };
}

export function prepareFrame(session, prediction) {
  const conflictIds = session?.primary_conflict?.aircraft_ids || [];
  const risk = session?.primary_conflict?.risk_level;
  const tracks = (session?.traffic || []).flatMap((track) => {
    const position = toGeodetic(track.x_nm, track.y_nm, track.altitude_ft);
    if (!position || typeof track.aircraft_id !== 'string' || !Number.isFinite(track.heading_deg)) return [];
    const military = /FIGHT|MIL/.test(track.category || '') || /^F\d/.test(track.aircraft_type || '');
    const emergency = track.emergency_status === 'DECLARED';
    const color = emergency ? '#ff77ad' : conflictIds.includes(track.aircraft_id)
      ? (['HIGH', 'CRITICAL'].includes(risk) ? '#ff7770' : '#ffd072')
      : military ? '#ffd072' : '#73e6ed';
    return [{ ...track, position, color, military }];
  });
  const paths = [];
  if (prediction?.kind === 'CONSTANT_VELOCITY' && prediction.session_id === session?.session_id &&
      Number.isFinite(session?.elapsed_seconds) && prediction.elapsed_seconds === session.elapsed_seconds &&
      Date.parse(prediction.simulation_time_utc) === Date.parse(session.simulation_time_utc)) {
    for (const trajectory of prediction.trajectories || []) {
      const track = tracks.find((item) => item.aircraft_id === trajectory.aircraft_id);
      const points = trajectory.points || [];
      if (!track || !points.length || !points.every((point, index) =>
        Number.isFinite(point.horizon_seconds) && point.horizon_seconds > (index ? points[index - 1].horizon_seconds : 0))) continue;
      const positions = points.map((point) => toGeodetic(point.x_nm, point.y_nm, point.altitude_ft));
      if (positions.some((point) => !point)) continue;
      paths.push({ aircraftId: track.aircraft_id, positions: [track.position, ...positions] });
    }
  }
  return { tracks, paths, conflictIds };
}

export function updateHistory(history, session, tracks) {
  if (history.sessionId !== session.session_id || session.elapsed_seconds < history.time) history.tracks.clear();
  const present = new Set(tracks.map((track) => track.aircraft_id));
  for (const id of history.tracks.keys()) if (!present.has(id)) history.tracks.delete(id);
  for (const track of tracks) {
    const points = history.tracks.get(track.aircraft_id) || [];
    if (points.at(-1)?.time !== session.elapsed_seconds) points.push({ ...track.position, time: session.elapsed_seconds });
    history.tracks.set(track.aircraft_id, points.filter((point) => session.elapsed_seconds - point.time <= 300).slice(-120));
  }
  history.time = session.elapsed_seconds;
  history.sessionId = session.session_id;
}
