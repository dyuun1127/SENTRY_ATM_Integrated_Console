import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DataLayerManager } from '../data/manager.js';
import { LAYER_STATE_REGISTRY } from '../data/layerState.js';

test('demo startup exposes three aircraft layers and registers the hidden CONTACTS coordinator', () => {
  const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const start = source.indexOf('    const sentryLayer = createSentryLayer();');
  const end = source.indexOf('    if (import.meta.env.DEV)', start);
  assert.ok(start >= 0 && end > start, 'startup registration boundary must exist');
  const dataManager = new DataLayerManager({});
  let provider, attachedManager;
  vm.runInNewContext(source.slice(start, end), {
    dataManager,
    createSentryLayer: () => ({ id: 'sentry-demo' }),
    flightsLayer: { id: 'flights' },
    militaryFlightsLayer: { id: 'military' },
    militaryAwarenessLayer: {
      id: 'military-awareness', showInTogglePanel: false,
      attachDataManager(manager) { attachedManager = manager; },
      registerAircraftSource(layer, metadata) { provider = { layer, metadata }; },
    },
    LAYER_STATE_REGISTRY,
  });
  assert.deepEqual([...dataManager.layers.keys()], ['sentry-demo', 'flights', 'military', 'military-awareness']);
  assert.deepEqual(dataManager.getAll().filter(layer => layer.showInTogglePanel).map(layer => layer.id),
    ['sentry-demo', 'flights', 'military']);
  assert.equal(provider.layer, dataManager.layers.get('sentry-demo').module);
  assert.equal(provider.metadata.source, 'SENTRY simulation');
  assert.equal(attachedManager, dataManager, 'CONTACTS must receive the real manager for source discovery and activation');
  assert.equal(dataManager.registrationsFinalized, true);
});

test('aircraft-only CONTACTS hides the unavailable installation search action', () => {
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const button = html.match(/<button\b[^>]*id="installations-search-btn"[^>]*>/)?.[0];
  assert.ok(button);
  assert.match(button, /\bhidden\b/);
});
