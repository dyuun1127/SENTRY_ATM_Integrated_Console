import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../ui.js', import.meta.url), 'utf8');

// Exercise the production panel methods without constructing the WebGL viewer.
function panelController(panels) {
  const specs = source.match(/const SHARE_PANEL_STATE_SPECS = Object.freeze\(\[[\s\S]*?\]\);/);
  assert.ok(specs);
  const methods = ['_buildSharePanelState', '_restorePanelState', 'setPanelCollapsed'].map(name => {
    const match = source.match(new RegExp(`\\n  ${name}\\([\\s\\S]*?\\n  \\}(?=\\r?\\n|$)`));
    assert.ok(match, `production ${name} must exist`);
    return match[0];
  });
  const Controller = new Function('document', 'requestAnimationFrame',
    `${specs[0]} return class { ${methods.join('\n')} }`)(
    { getElementById: id => panels.get(id) || null }, callback => callback());
  const controller = new Controller();
  controller._syncPanelCollapseButton = () => {};
  controller._updateCommandDockTrayStack = () => {};
  controller._scheduleLeftPanelLayout = () => {};
  controller._savePanelCollapsedState = () => assert.fail('restoring a share must not overwrite local preferences');
  return controller;
}

function panel(id) {
  const classes = new Set(['collapsed']);
  return { id, classList: {
    contains: value => classes.has(value),
    remove: value => classes.delete(value),
    toggle(value, on) { if (on) classes.add(value); else classes.delete(value); },
  } };
}

test('SENTRY console omits the Scenes panel and retains DATA LAYERS and CONTACTS', () => {
  assert.doesNotMatch(html, /\bid="scene-(?:panel|select|shot-list|status|progress-fill|[a-z-]+-btn)"|data-collapse-target="scene-panel"/);
  for (const id of ['left-panel-stack', 'data-panel', 'data-toggles', 'global-context-panel',
    'global-context-flights-btn', 'context-flights-view', 'military-awareness-panel', 'scene-runtime']) {
    assert.ok(html.includes(`id="${id}"`), `${id} must remain mounted`);
  }
});

test('legacy expanded Scenes state is ignored while DATA LAYERS and CONTEXT restore', () => {
  const panels = new Map(['data-panel', 'global-context-panel'].map(id => [id, panel(id)]));
  const controller = panelController(panels);
  controller._restorePanelState({ specs: [
    { id: 'scene-panel', collapsed: false },
    { id: 'data-panel', collapsed: false },
    { id: 'global-context-panel', collapsed: false },
  ] });
  assert.equal(panels.get('data-panel').classList.contains('collapsed'), false);
  assert.equal(panels.get('global-context-panel').classList.contains('collapsed'), false);
  assert.deepEqual(controller._buildSharePanelState(), { specs: [
    { id: 'data-panel', collapsed: false },
    { id: 'global-context-panel', collapsed: false },
  ] });
});

test('opening an absent Scenes panel cannot claim restore ownership or persist state', () => {
  const controller = panelController(new Map());
  controller.shareLinkManager = {
    claimRestoreLane: () => assert.fail('missing panel cannot claim a lane'),
    onPanelStateChange: () => assert.fail('missing panel cannot rewrite the share'),
  };
  controller._scheduleLeftPanelLayout = () => assert.fail('missing panel cannot displace DATA LAYERS');
  controller.setPanelCollapsed('scene-panel', false, { explicit: true });
  assert.equal(controller._buildSharePanelState(), null);
});
