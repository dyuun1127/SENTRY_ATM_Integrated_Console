import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cockpitUnsupportedReason, resolveTrackedAircraftInfo } from './cockpitMath.js';

// Exercise the actual UI methods without constructing Cesium or starting feeds.
const uiSource = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
function method(name) {
  const result = uiSource.match(new RegExp(`\\n  ${name}\\([\\s\\S]*?\\n  \\}(?=\\r?\\n|$)`));
  assert.ok(result, `Missing UI method ${name}`);
  return result[0];
}
function harness() {
  const viewer = { trackedEntity: { gevTrackedId: 'sentry-demo:AAR1405', position: {} } };
  const selected = { layerId: 'sentry-demo' };
  const LiveController = new Function('cockpitUnsupportedReason', 'resolveTrackedAircraftInfo',
    'getSelectedEntityContext', 'flightsLayer', 'militaryFlightsLayer',
    `return class { ${['unsupportedSourceReason', 'readAircraftInfo', 'syncEntry'].map(method).join('\n')} }`)(
    cockpitUnsupportedReason, resolveTrackedAircraftInfo, () => selected,
    { getTrackedInfo: () => ({ icao24: 'aaa077', callsign: 'OLD LIVE' }) }, { getTrackedInfo: () => null },
  );
  const controller = new LiveController();
  const label = { textContent: '' };
  const entry = { hidden: true, disabled: false, title: '', setAttribute() {}, querySelector: () => label };
  Object.assign(controller, { viewer, entry, trackedEntity: null, active: false,
    isEntryAllowed: () => true, syncTr3bToggle() {} });
  const UIController = new Function('cockpitUnsupportedReason', 'militaryAwarenessLayer',
    `return class { ${['getCockpitState', 'controlCockpit'].map(method).join('\n')} }`)(
    cockpitUnsupportedReason, { getContextSnapshot: () => null },
  );
  const ui = new UIController(); Object.assign(ui, { viewer, cockpitView: controller });
  return { viewer, controller, entry, label, ui };
}

test('SENTRY tracking cannot enter Cockpit using a leftover live-aircraft descriptor', () => {
  const f = harness();
  assert.equal(f.controller.readAircraftInfo(), null);
  const originalEntity = f.viewer.trackedEntity;
  const state = f.ui.getCockpitState();
  assert.equal(state.entryAllowed, false);
  assert.equal(state.entryBlockedReason, 'sentry-demo-unsupported');
  assert.match(state.entryBlockedMessage, /SENTRY.*MAP/);
  const result = f.ui.controlCockpit('enter');
  assert.equal(result.ok, false); assert.match(result.error, /SENTRY.*MAP/);
  assert.equal(f.viewer.trackedEntity, originalEntity);
});

test('untracked SENTRY selection shows a disabled MAP-only entry and a later live track restores it', () => {
  const f = harness(); f.viewer.trackedEntity = null;
  f.controller.syncEntry();
  assert.equal(f.entry.hidden, false); assert.equal(f.entry.disabled, true);
  assert.match(f.entry.title, /SENTRY.*MAP/); assert.equal(f.label.textContent, 'COCKPIT · MAP ONLY');
  f.viewer.trackedEntity = { gevTrackedId: 'flights:aaa077', position: {} };
  f.controller.syncEntry();
  assert.equal(f.entry.hidden, false); assert.equal(f.entry.disabled, false);
  assert.equal(f.label.textContent, 'COCKPIT');
  assert.equal(f.controller.readAircraftInfo().icao24, 'aaa077');
});

test('an explicit SENTRY Cockpit target is rejected before changing the current live tracker', () => {
  const f = harness(); f.viewer.trackedEntity = { gevTrackedId: 'flights:aaa077', position: {} };
  const originalEntity = f.viewer.trackedEntity;
  const result = f.ui.controlCockpit('enter', { selectedTarget: { layerId: 'sentry-demo', id: 'AAR1405' } });
  assert.equal(result.ok, false); assert.match(result.error, /SENTRY/);
  assert.equal(f.viewer.trackedEntity, originalEntity);
});
