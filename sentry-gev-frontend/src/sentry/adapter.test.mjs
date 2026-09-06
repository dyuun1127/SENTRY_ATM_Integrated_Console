import test from 'node:test';
import assert from 'node:assert/strict';
import { ARP, toGeodetic, prepareFrame, updateHistory } from './adapter.js';
import { createSentryClient } from './client.js';

const track = { aircraft_id: 'SYN-01', x_nm: 1, y_nm: 0, altitude_ft: 10000,
  heading_deg: 90, ground_speed_kt: 180, category: 'AIRLINER', source: 'SYNTHETIC' };
const session = { session_id: 'RUN-1', elapsed_seconds: 30, simulation_time_utc: '2026-09-01T00:00:30Z', traffic: [track] };
const prediction = { session_id: 'RUN-1', elapsed_seconds: 30, simulation_time_utc: session.simulation_time_utc,
  kind: 'CONSTANT_VELOCITY', trajectories: [{ aircraft_id: 'SYN-01', points: [
    { horizon_seconds: 30, x_nm: 2.5, y_nm: 0, altitude_ft: 10000 },
    { horizon_seconds: 60, x_nm: 4, y_nm: 0, altitude_ft: 10000 },
  ] }] };

test('RKTU coordinate mapping preserves NM direction and ft altitude without missing-value defaults', () => {
  const origin = toGeodetic(0, 0, 10000);
  assert.equal(origin.lat, ARP.lat); assert.equal(origin.lon, ARP.lon); assert.equal(origin.height, 3048);
  assert.ok(toGeodetic(1, 0, 0).lon > ARP.lon); assert.ok(toGeodetic(0, 1, 0).lat > ARP.lat);
  assert.equal(toGeodetic(1, 0, null), null); assert.equal(toGeodetic(NaN, 0, 0), null);
});

test('only current-run current-time CV is rendered; no future playback masquerades as prediction', () => {
  assert.equal(prepareFrame(session, prediction).paths.length, 1);
  assert.equal(prepareFrame(session, { ...prediction, simulation_time_utc: '2026-09-01T00:00:30.000000Z' }).paths.length, 1);
  for (const patch of [{ session_id: 'OLD' }, { elapsed_seconds: 20 }, { simulation_time_utc: 'old' }, { kind: 'PLAYBACK' }]) {
    assert.equal(prepareFrame(session, { ...prediction, ...patch }).paths.length, 0);
  }
  const bad = structuredClone(prediction); bad.trajectories[0].points[1].horizon_seconds = 10;
  assert.equal(prepareFrame(session, bad).paths.length, 0);
  bad.trajectories[0].points[1].horizon_seconds = 60; bad.trajectories[0].points[1].altitude_ft = null;
  assert.equal(prepareFrame(session, bad).paths.length, 0);
});

test('critical conflict and declared emergency remain visibly distinct from ordinary demo traffic', () => {
  const conflict = { aircraft_ids: ['SYN-01','SYN-02'], risk_level: 'CRITICAL' };
  assert.equal(prepareFrame({ ...session, primary_conflict: conflict }).tracks[0].color, '#ff7770');
  assert.equal(prepareFrame({ ...session, traffic: [{ ...track, emergency_status: 'DECLARED' }], primary_conflict: conflict }).tracks[0].color, '#ff77ad');
});

test('trails clear on reset, replaced runs and removed aircraft, and do not grow on repeated polls', () => {
  const history = { tracks: new Map(), time: 0, sessionId: null };
  const tracks = prepareFrame(session).tracks;
  updateHistory(history, session, tracks); updateHistory(history, session, tracks);
  assert.equal(history.tracks.get('SYN-01').length, 1);
  updateHistory(history, { ...session, elapsed_seconds: 60 }, tracks);
  assert.equal(history.tracks.get('SYN-01').length, 2);
  updateHistory(history, { ...session, session_id: 'RUN-2', elapsed_seconds: 60 }, tracks);
  assert.equal(history.tracks.get('SYN-01').length, 1);
  updateHistory(history, { ...session, session_id: 'RUN-2', elapsed_seconds: 70 }, []);
  assert.equal(history.tracks.size, 0);
});

test('reading the bridge issues only GET; POST is reserved for explicit command calls', async () => {
  const requests = [];
  const client = createSentryClient({ fetchImpl: async (url, options) => {
    requests.push({ url, ...options }); return { ok: true, json: async () => session };
  } });
  await client.get('/golden-demo/session'); await client.get('/prediction');
  assert.deepEqual(requests.map((r) => r.method), ['GET','GET']);
  await client.command({ command: 'ADVANCE', seconds: 30 });
  assert.equal(requests[2].url, '/sentry-api/golden-demo/session/commands');
  assert.deepEqual(JSON.parse(requests[2].body), { command: 'ADVANCE', seconds: 30 });
});
