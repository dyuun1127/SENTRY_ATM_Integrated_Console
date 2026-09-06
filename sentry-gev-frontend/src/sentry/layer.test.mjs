import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DataLayerManager } from '../data/manager.js';
import { LAYER_STATE_REGISTRY, LAYER_STATE_STORAGE_KEY, LayerStateCoordinator,
  createDefaultLayerState, serializeStoredLayerState } from '../data/layerState.js';
import * as Cesium from 'cesium';
import { createSentryLayer } from './layer.js';
import { createSentryController } from './controller.js';
import { isOwnedByOtherLayer, registerPickOwner, unregisterPickOwner } from '../data/pickRegistry.js';

function makeViewer() {
  let tracked;
  const events = [];
  return {
    dataSources: new Cesium.DataSourceCollection(),
    selectedEntityChanged: new Cesium.Event(), trackedEntityChanged: new Cesium.Event(), events,
    get trackedEntity() { return tracked; },
    set trackedEntity(value) {
      tracked = value; events.push(value ? `track:${value.id}` : 'release');
      this.trackedEntityChanged.raiseEvent(value);
    },
    camera: { flyTo() { events.push('fly'); } },
  };
}

function makeClient() {
  const calls = [];
  const session = {
    session_id: 'RKTU-SIM-RUN-1', scenario_id: 'RKTU-SIM', stage: 'MONITORING', elapsed_seconds: 30,
    simulation_time_utc: '2026-09-01T00:00:30Z', traffic_count: 1,
    traffic: [{ aircraft_id: 'SIM-01', aircraft_type: 'A320', category: 'AIRLINER',
      source: 'SYNTHETIC', x_nm: 1, y_nm: 2, altitude_ft: 9000,
      heading_deg: 90, ground_speed_kt: 240, emergency_status: 'NONE' }],
  };
  let referencesFail = false;
  return {
    calls, session,
    set referencesFail(value) { referencesFail = value; },
    async get(path) {
      calls.push(path);
      if (path.startsWith('/reference/') && referencesFail) throw new Error('offline reference');
      if (path === '/golden-demo/session') return structuredClone(session);
      if (path === '/reference/scenario') return { scenario_id: session.scenario_id, steps: [{ n: 1, t_s: 30 }] };
      if (path === '/reference/geometry') return {
        runway: { thr06l: [36.7, 127.4], thr24r: [36.8, 127.5] },
        fixes: [{ name: 'SIMFIX', lat: 36.75, lon: 127.45 }],
      };
      return {};
    },
    async command() { assert.fail('Read-only map behavior must not command the backend'); },
  };
}

test('SENTRY picks belong to their layer only while enabled and never replace sibling owners', async () => {
  const layer = createSentryLayer({ client: makeClient() });
  const viewer = makeViewer();
  registerPickOwner('test-original', (id) => id === 'original:1');
  try {
    await layer.init(viewer);
    assert.equal(isOwnedByOtherLayer('flights', 'sentry:track:SIM-01'), false);
    layer.enable();
    for (const id of ['sentry:track:SIM-01', 'sentry:trail:SIM-01', 'sentry:fix:SIMFIX']) {
      assert.equal(isOwnedByOtherLayer('flights', id), true);
      assert.equal(isOwnedByOtherLayer('military', id), true);
    }
    assert.equal(isOwnedByOtherLayer('sentry-demo', 'original:1'), true);
    layer.disable();
    assert.equal(isOwnedByOtherLayer('flights', 'sentry:track:SIM-01'), false);
    layer.enable();
    layer.destroy();
    assert.equal(isOwnedByOtherLayer('flights', 'sentry:track:SIM-01'), false);
    assert.equal(isOwnedByOtherLayer('flights', 'original:1'), true);
    assert.equal(viewer.dataSources.length, 0);
  } finally { unregisterPickOwner('test-original'); }
});

test('camera ownership is released before tracking SENTRY or flying to its airport', async () => {
  const layer = createSentryLayer({ client: makeClient() });
  const viewer = makeViewer();
  await layer.init(viewer); layer.enable(); await layer.update(viewer);
  // This is the integration seam for GEV's public beginLocationNavigation().
  layer.setCameraPreparation(() => { viewer.events.push('exit-cockpit'); });
  try {
    assert.equal(layer.follow('SIM-01'), true);
    assert.deepEqual(viewer.events, ['exit-cockpit', 'track:sentry:track:SIM-01']);
    assert.equal(viewer.trackedEntity.show, true);
    viewer.events.length = 0;
    assert.equal(layer.focusAirport(), true);
    assert.deepEqual(viewer.events, ['exit-cockpit', 'release', 'fly']);
    assert.equal(layer.getSnapshot().followingId, null);
    viewer.events.length = 0;
    layer.follow(null);
    assert.deepEqual(viewer.events, [], 'stopping tracking must not seize another layer camera');
  } finally { layer.destroy(); }
});

test('failed GEV camera preparation leaves the previous owner untouched', async () => {
  const layer = createSentryLayer({ client: makeClient() });
  const viewer = makeViewer();
  await layer.init(viewer); layer.enable(); await layer.update(viewer);
  const existing = new Cesium.Entity({ id: 'original-flight' });
  viewer.trackedEntity = existing; viewer.events.length = 0;
  layer.setCameraPreparation(() => { throw new Error('camera mode is busy'); });
  try {
    assert.equal(layer.follow('SIM-01'), false);
    assert.equal(layer.focusAirport(), false);
    assert.equal(viewer.trackedEntity, existing);
    assert.deepEqual(viewer.events, []);
    assert.ok(layer.getSnapshot().error);
    layer.disable();
    assert.equal(viewer.trackedEntity, existing, 'disable clears only owned follow camera');
  } finally { layer.destroy(); }
});

test('reference failure stays visible and recovers on update without duplicate geometry', async () => {
  const client = makeClient(); client.referencesFail = true;
  const layer = createSentryLayer({ client });
  const viewer = makeViewer();
  await layer.init(viewer); layer.enable();
  try {
    assert.equal(await layer.update(viewer), true, 'available aircraft can still be displayed');
    assert.equal(layer.getSnapshot().session.traffic_count, 1);
    assert.equal(layer.getSnapshot().scenario, null);
    assert.match(layer.getSnapshot().error, /공역과 단계/);
    client.referencesFail = false;
    assert.equal(await layer.update(viewer), true);
    assert.equal(layer.getSnapshot().scenario.scenario_id, client.session.scenario_id);
    assert.equal(layer.getSnapshot().error, null);
    const references = viewer.dataSources.getByName('SENTRY RKTU')[0];
    const ids = references.entities.values.map((entity) => entity.id);
    assert.equal(ids.length, 2);
    const referenceCalls = client.calls.filter((path) => path.startsWith('/reference/')).length;
    await layer.update(viewer);
    assert.equal(client.calls.filter((path) => path.startsWith('/reference/')).length, referenceCalls);
    assert.deepEqual(references.entities.values.map((entity) => entity.id), ids);
    // Backend replacement must not leave the previous scenario's jump buttons.
    client.session.scenario_id = 'OTHER-SIM'; client.session.session_id = 'OTHER-RUN';
    client.referencesFail = true;
    await layer.update(viewer);
    assert.equal(layer.getSnapshot().scenario, null);
    assert.equal(references.entities.values.length, 0);
    assert.ok(layer.getSnapshot().error);
    client.referencesFail = false;
    await layer.update(viewer);
    assert.equal(layer.getSnapshot().scenario.scenario_id, 'OTHER-SIM');
    assert.equal(references.entities.values.length, 2);
  } finally { layer.destroy(); }
});

test('disabled pending reference fetch cannot republish a layer or stale descriptor', async () => {
  const client = makeClient();
  let finishReference;
  const original = client.get;
  client.get = async (path) => path === '/reference/scenario'
    ? new Promise((resolve) => { finishReference = resolve; }) : original(path);
  const layer = createSentryLayer({ client });
  const viewer = makeViewer();
  await layer.init(viewer); layer.enable();
  try {
    const pending = layer.update(viewer);
    while (!finishReference) await Promise.resolve();
    layer.disable();
    finishReference({ scenario_id: client.session.scenario_id, steps: [] });
    assert.equal(await pending, false);
    assert.equal(layer.getSnapshot().enabled, false);
    assert.equal(layer.getSnapshot().scenario, null);
    assert.equal(viewer.dataSources.getByName('SENTRY RKTU')[0].entities.values.length, 0);
    assert.equal(isOwnedByOtherLayer('flights', 'sentry:track:SIM-01'), false);
  } finally { layer.destroy(); }
});


test('integration startup preserves restored tracking and storage; user focus still releases it', async () => {
  const viewer = makeViewer();
  const trackedFlight = new Cesium.Entity({ id: 'original-flight' });
  const layer = createSentryLayer({ client: makeClient() });
  const manager = new DataLayerManager(viewer);
  manager.register(layer);
  for (const id of ['flights', 'military']) {
    let params = { models3d: true, models3dMode: 'proximity' };
    manager.register({
      id, name: id,
      init() {},
      setParams(next) { params = { ...params, ...next }; },
      getParams() { return { ...params }; },
      enable() { if (params.selectedFlightsTrackingId) viewer.trackedEntity = trackedFlight; },
      disable() {},
      update() {},
    });
  }
  manager.finalizeRegistrations(LAYER_STATE_REGISTRY.filter(({ id }) => manager.layers.has(id)));
  const local = createDefaultLayerState();
  local.enabledLayerIds = ['cctv', 'flights', 'military', 'sentry-demo'];
  local.options.flights.selectedFlightsTrackingId = 'abcdef';
  const originalStored = serializeStoredLayerState(local);
  let stored = originalStored;
  const writes = [];
  const coordinator = new LayerStateCoordinator(manager, null, { storage: {
    getItem(key) { return key === LAYER_STATE_STORAGE_KEY ? stored : null; },
    setItem(key, value) { stored = value; writes.push([key, value]); },
  } });
  let navigations = 0;
  const styleManager = {
    hasShareState: false,
    initialRestorePromise: coordinator.start(),
    beginLocationNavigation() {
      navigations += 1;
      manager.setLayerParams('flights', { selectedFlightsTrackingId: null }, { origin: 'tool' });
      manager.setLayerParams('military', { selectedMilitaryTrackingId: null }, { origin: 'tool' });
      viewer.trackedEntity = undefined;
    },
  };
  let callbacks;
  // Exercise real session/map integration with isolated API data and a stubbed panel.
  const integrationSource = fs.readFileSync(new URL('./integration.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export function initSentryIntegration', 'function initSentryIntegration');
  const initIntegration = vm.runInNewContext(integrationSource + '\ninitSentryIntegration;', {
    createSentryController: () => {
      const controller = createSentryController({ client: makeClient() });
      return { ...controller, start() {} };
    },
    createSentryPanel(options) {
      callbacks = options;
      return { render() {}, setStatus() {}, setBusy() {}, destroy() {} };
    },
    URLSearchParams, location: { search: '?sentry=1' },
  });
  let integration;
  try {
    integration = initIntegration({ dataManager: manager, styleManager, layer });
    await integration.ready;
    assert.equal(manager.isEnabled('sentry-demo'), true);
    assert.equal(viewer.trackedEntity, trackedFlight, 'startup must preserve the restored aircraft tracker');
    assert.equal(manager.getLayerParams('flights').selectedFlightsTrackingId, 'abcdef');
    assert.equal(navigations, 0, 'startup is not an explicit navigation gesture');
    assert.deepEqual(writes, []);
    assert.equal(stored, originalStored, 'legacy local state is not migrated just by opening the app');

    callbacks.onFocusAirport();
    assert.equal(navigations, 1, 'the user airport button still releases other camera owners');
    assert.equal(manager.getLayerParams('flights').selectedFlightsTrackingId, null);
    assert.ok(writes.length > 0, 'the explicit button may persist its tracking clear');
    assert.ok(viewer.events.includes('fly'));
    callbacks.onFollow('SIM-01');
    assert.equal(navigations, 2);
    assert.equal(viewer.trackedEntity.id, 'sentry:track:SIM-01');
  } finally {
    integration?.destroy();
    coordinator.destroy();
    for (const id of ['sentry-demo', 'flights', 'military']) await manager.destroyLayer(id);
  }
});


test('hidden SENTRY map consumes shared session updates without owning simulation time', async () => {
  const client = makeClient(), layer = createSentryLayer({ client });
  const viewer = makeViewer();
  let listener;
  let state = { session: client.session, prediction: null, advisory: null, scenario: null,
    geometry: null, stale: false, error: null };
  layer.setSessionSource({ getSnapshot: () => state, subscribe(fn) { listener = fn; return () => { listener = null; }; } });
  await layer.init(viewer); layer.enable(); await layer.update(viewer);
  layer.disable();
  state = { ...state, session: { ...client.session, session_id: 'SIM-RESET', elapsed_seconds: 50,
    traffic: client.session.traffic.map(item => ({ ...item, altitude_ft: 12345 })) } };
  listener(state);
  assert.equal(layer.getSnapshot().session.session_id, 'SIM-RESET');
  assert.equal(layer.getSnapshot().enabled, false);
  assert.equal(viewer.dataSources.getByName('SENTRY DEMO')[0].show, false);
  assert.equal(client.calls.length, 0, 'attached layer must not poll or advance the session itself');
  layer.enable();
  assert.equal(layer.getSubject('SIM-01').altitudeFt, 12345);
  await assert.rejects(layer.command({ command: 'RESET' }), /시연 화면/);
  layer.destroy(); assert.equal(listener, null);
});
