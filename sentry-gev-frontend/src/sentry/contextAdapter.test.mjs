import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createSentryLayer } from './layer.js';
import { getContextStore, getSelectedEntityContext, selectTrackedSubjectContext } from '../data/contextStore.js';

async function fixture(t) {
  const previousWindow = globalThis.window;
  const host = new EventTarget(); globalThis.window = host;
  const selectedEvents = [], clearedEvents = [];
  host.addEventListener('gev:awareness-subject-selected', (event) => selectedEvents.push(event.detail));
  host.addEventListener('gev:awareness-subject-cleared', (event) => clearedEvents.push(event.detail));
  const session = { session_id: 'RUN-1', scenario_id: 'RKTU-SIM', elapsed_seconds: 30,
    simulation_time_utc: '2026-09-01T00:00:30Z', traffic_count: 2,
    traffic: [{ aircraft_id: 'SIM-01', aircraft_type: 'A320', source: 'SYNTHETIC', category: 'AIRLINER',
      x_nm: 1, y_nm: 2, altitude_ft: 9000, ground_speed_kt: 240, heading_deg: 90,
      vertical_speed_fpm: -800, emergency_status: 'NONE' },
    { aircraft_id: 'SIM-02', aircraft_type: 'B738', source: 'OPENSKY', category: 'AIRLINER',
      x_nm: 2, y_nm: 2, altitude_ft: 9100, ground_speed_kt: 220, heading_deg: 80,
      vertical_speed_fpm: 0, emergency_status: 'DECLARED' }],
  };
  let offline = false, tracked, selected;
  const commands = [], reads = [];
  const client = {
    async get(route) {
      reads.push(route);
      if (offline) throw new Error('offline');
      if (route === '/golden-demo/session') return structuredClone(session);
      if (route === '/reference/scenario') return { scenario_id: session.scenario_id, steps: [] };
      return {};
    },
    async command(body) { commands.push(body); return { ok: true }; },
  };
  const viewer = { dataSources: new Cesium.DataSourceCollection(),
    selectedEntityChanged: new Cesium.Event(), trackedEntityChanged: new Cesium.Event(),
    get trackedEntity() { return tracked; },
    set trackedEntity(value) { tracked = value; this.trackedEntityChanged.raiseEvent(value); },
    get selectedEntity() { return selected; },
    set selectedEntity(value) { selected = value; this.selectedEntityChanged.raiseEvent(value); },
    camera: { flyTo() {} },
  };
  const layer = createSentryLayer({ client });
  await layer.init(viewer); layer.enable(); await layer.update(viewer);
  t.after(() => {
    layer.destroy();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  });
  return { layer, viewer, session, commands, reads, selectedEvents, clearedEvents, host,
    setOffline(value) { offline = value; } };
}

function publishLive(host, id = 'abc123') {
  const subject = { layerId: 'flights', id, label: 'LIVE', position: Cesium.Cartesian3.fromDegrees(127, 37, 1000) };
  selectTrackedSubjectContext(subject);
  host.dispatchEvent(new CustomEvent('gev:awareness-subject-selected', { detail: subject }));
  return subject;
}

test('SENTRY selection before CONTACTS activation is queryable without camera follow or backend commands', async (t) => {
  const f = await fixture(t), initialReads = f.reads.length;
  assert.equal(f.layer.select('SIM-01'), true);
  const subject = f.layer.getSelectedSubject();
  assert.equal(subject.id, 'SIM-01'); assert.equal(subject.layerId, 'sentry-demo');
  assert.equal(subject.simulation, true); assert.equal(subject.source, 'SYNTHETIC');
  assert.equal(subject.verticalRateFpm, -800); assert.equal(subject.aircraftType, 'A320');
  assert.equal(f.layer.getTrackedSubject(), null); assert.equal(f.viewer.trackedEntity, undefined);
  const selected = getSelectedEntityContext();
  assert.equal(selected.id, 'sentry-demo:SIM-01'); assert.equal(selected.subjectId, 'SIM-01');
  assert.equal(f.selectedEvents.at(-1).id, 'SIM-01'); assert.equal(f.selectedEvents.at(-1).origin, 'user');
  assert.equal(f.layer.getSubject('sim-01'), null, 'raw scenario identity is case-sensitive');
  assert.equal(f.reads.length, initialReads); assert.deepEqual(f.commands, []);
});

test('provider rows preserve recorded source and identities without invented ICAO24 values', async (t) => {
  const f = await fixture(t);
  const subject = f.layer.getSubject('SIM-02');
  assert.equal(subject.source, 'OPENSKY'); assert.equal(subject.simulation, true);
  assert.match(subject.sourceDescription, /recording/); assert.equal(subject.emergencyStatus, 'DECLARED');
  const nearby = f.layer.getNearby(f.layer.getSubject('SIM-01').position, 5000, 10);
  assert.deepEqual(nearby.map((row) => row.id), ['SIM-01', 'SIM-02']);
  assert.equal(nearby[0].distanceM, 0); assert.ok(nearby[1].distanceM > 1800);
  assert.equal(nearby[1].data.source, 'OPENSKY'); assert.equal(nearby[1].callsign, 'SIM-02');
  assert.equal(nearby[1].type, 'B738'); assert.equal('icao24' in nearby[1], false);
  assert.equal('icao24' in nearby[1].data, false);
  assert.equal(f.layer.getAllPositions(1).length, 1); assert.equal(f.layer.getNearby(subject.position, 1, 0).length, 0);
  assert.equal(f.layer.hasContact('SIM-02'), true);
  subject.position.x = 0;
  assert.notEqual(f.layer.getSubject('SIM-02').position.x, 0, 'callers cannot mutate the simulation frame');
  assert.deepEqual(f.commands, []);
});

test('tracked subject follows only its own Cesium entity and uses cached simulation positions', async (t) => {
  const f = await fixture(t);
  assert.equal(f.layer.trackById('SIM-01', { origin: 'user' }), true);
  const entity = f.viewer.trackedEntity;
  assert.equal(entity.gevTrackedId, 'sentry-demo:SIM-01');
  assert.equal(f.layer.getTrackedSubject().id, 'SIM-01');
  assert.match(entity.gevLabelModel.title, /SIM/);
  assert.equal(Cesium.Cartesian3.equals(entity.gevDisplayPosition(), f.layer.getSubject('SIM-01').position), true);
  const before = entity.gevDisplayPosition();
  f.session.traffic[0].x_nm += 1;
  assert.equal(Cesium.Cartesian3.equals(before, entity.gevDisplayPosition()), true, 'unfetched state and wall time do not move the frame');
  await f.layer.update(f.viewer);
  assert.equal(Cesium.Cartesian3.equals(before, entity.gevDisplayPosition()), false);
  const other = new Cesium.Entity({ id: 'live-aircraft' }); f.viewer.trackedEntity = other;
  assert.equal(f.layer.getTrackedSubject(), null); assert.equal(f.layer.getSelectedSubject(), null);
  assert.equal(f.viewer.trackedEntity, other); assert.deepEqual(f.commands, []);
});

test('foreign selection releases SENTRY tracking and later polling never replaces the live selection', async (t) => {
  const f = await fixture(t);
  f.layer.follow('SIM-01');
  publishLive(f.host);
  assert.equal(f.layer.getSelectedSubject(), null); assert.equal(f.layer.getTrackedSubject(), null);
  assert.equal(f.viewer.trackedEntity, undefined);
  await f.layer.update(f.viewer);
  assert.equal(getSelectedEntityContext().layerId, 'flights');
  assert.equal(getSelectedEntityContext().id, 'abc123');
  assert.equal(f.clearedEvents.at(-1).layerId, 'sentry-demo');
  // Even a store-only selection (no event) cannot be stolen by polling.
  f.layer.select('SIM-01');
  selectTrackedSubjectContext({ id: 'def456', layerId: 'flights', label: 'NEW LIVE' });
  await f.layer.update(f.viewer);
  assert.equal(getSelectedEntityContext().id, 'def456');
  assert.deepEqual(f.commands, []);
});

test('global context keys cannot collide with a Live hex equal to a raw SENTRY callsign', async (t) => {
  const f = await fixture(t);
  f.session.traffic[0].aircraft_id = 'ABC123'; await f.layer.update(f.viewer);
  selectTrackedSubjectContext({ id: 'ABC123', layerId: 'flights', label: 'LIVE WITH SAME KEY' });
  f.layer.select('ABC123');
  assert.equal(getSelectedEntityContext().id, 'sentry-demo:ABC123');
  assert.equal(f.layer.getSubject('ABC123').id, 'ABC123');
  assert.equal(getContextStore().entities.get('ABC123').layerId, 'flights');
  publishLive(f.host, 'ABC123');
  assert.equal(getSelectedEntityContext().id, 'ABC123');
  assert.equal(getSelectedEntityContext().layerId, 'flights');
  assert.equal(getContextStore().entities.has('sentry-demo:ABC123'), false);
});

test('selection publication is reentrant-safe and polling does not repeat selection events', async (t) => {
  const f = await fixture(t);
  f.host.addEventListener('gev:awareness-subject-selected', (event) => {
    if (event.detail.layerId === 'sentry-demo') f.layer.select(event.detail.id);
  });
  f.layer.select('SIM-01');
  assert.equal(f.selectedEvents.length, 1);
  await f.layer.update(f.viewer);
  assert.equal(f.selectedEvents.length, 1);
  assert.equal(getSelectedEntityContext().subjectId, 'SIM-01');
});

test('RESET at the same timestamp clears selection and tracking even when callsign survives', async (t) => {
  const f = await fixture(t);
  f.session.elapsed_seconds = 0; f.session.simulation_time_utc = '2026-09-01T00:00:00Z';
  await f.layer.update(f.viewer); f.layer.follow('SIM-01');
  await f.layer.command({ command: 'RESET' });
  assert.deepEqual(f.commands, [{ command: 'RESET' }]);
  assert.equal(f.layer.hasContact('SIM-01'), true);
  assert.equal(f.layer.getSelectedSubject(), null); assert.equal(f.layer.getTrackedSubject(), null);
  assert.equal(getSelectedEntityContext(), null); assert.equal(f.clearedEvents.at(-1).reason, 'reset');
});

test('rewind, run replacement, disappearance and disable clear only SENTRY context', async (t) => {
  const f = await fixture(t);
  f.layer.follow('SIM-01'); f.session.elapsed_seconds = 1; await f.layer.update(f.viewer);
  assert.equal(f.layer.getSelectedSubject(), null);
  f.layer.follow('SIM-01'); f.session.session_id = 'RUN-2'; await f.layer.update(f.viewer);
  assert.equal(f.layer.getTrackedSubject(), null);
  f.layer.follow('SIM-01'); f.session.traffic.shift(); f.session.traffic_count = 1; await f.layer.update(f.viewer);
  assert.equal(f.layer.hasContact('SIM-01'), false); assert.equal(getSelectedEntityContext(), null);
  f.layer.follow('SIM-02'); f.layer.disable();
  assert.equal(f.layer.getSelectedSubject(), null); assert.equal(f.layer.getTrackedSubject(), null);
  assert.equal(f.layer.getAllPositions().length, 0); assert.equal(f.layer.hasContact('SIM-02'), false);
  assert.equal(f.clearedEvents.at(-1).reason, 'disabled');
  publishLive(f.host); f.layer.destroy();
  assert.equal(getSelectedEntityContext().layerId, 'flights');
});

test('temporary network failure keeps a marked snapshot but refuses new tracking until recovery', async (t) => {
  const f = await fixture(t);
  f.layer.select('SIM-01'); const position = f.layer.getSelectedSubject().position;
  f.setOffline(true); assert.equal(await f.layer.update(f.viewer), false);
  const stale = f.layer.getSelectedSubject();
  assert.equal(stale.stale, true); assert.equal(stale.staleReason, 'network-error');
  assert.equal(Cesium.Cartesian3.equals(stale.position, position), true);
  assert.equal(f.layer.getStats().stale, true); assert.equal(f.layer.hasContact('SIM-01'), true);
  assert.match(getSelectedEntityContext().properties.status, /STALE/);
  assert.equal(f.layer.trackById('SIM-02'), false); assert.equal(f.layer.refocusTrackedById('SIM-01'), false);
  f.setOffline(false); await f.layer.update(f.viewer);
  assert.equal(f.layer.getSubject('SIM-01').stale, false); assert.equal(f.layer.trackById('SIM-02'), true);
  assert.deepEqual(f.commands, []);
});

test('Cesium background deselection clears the SENTRY context and its follow camera', async (t) => {
  const f = await fixture(t);
  f.layer.follow('SIM-01');
  f.viewer.selectedEntity = undefined;
  assert.equal(f.layer.getSelectedSubject(), null);
  assert.equal(f.layer.getTrackedSubject(), null);
  assert.equal(f.viewer.trackedEntity, undefined);
  assert.equal(getSelectedEntityContext(), null);
  assert.equal(f.clearedEvents.at(-1).reason, 'deselected');
  assert.deepEqual(f.commands, []);
});
