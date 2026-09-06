import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
function controllerFor(names, document, environment = {}) {
  const methods = names.map(name => {
    const start = source.indexOf('\n  ' + name + '(');
    const end = source.indexOf('\n  }', start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end + 4);
  });
  const Controller = new Function('document', 'ResizeObserver', 'MutationObserver',
    'window', 'requestAnimationFrame', 'return class {' + methods.join('\n') + '}')(
    document, undefined, undefined, environment.window, environment.requestAnimationFrame,
  );
  return new Controller();
}
function panel(id) {
  const classes = new Set(['collapsed']);
  const attributes = new Map();
  return { id, attributes, style: { removeProperty() {} },
    matches: selector => selector === '[data-panel-id]',
    classList: { contains: value => classes.has(value), remove(...values) { values.forEach(value => classes.delete(value)); },
      toggle(value, on) { if(on) classes.add(value); else classes.delete(value); } },
    querySelector: () => null,
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key),
  };
}

test('mounting Display retains Data → Display → Context order and existing panel identity', () => {
  const data = panel('data-panel'), display = panel('pp-toggles'), context = panel('global-context-panel');
  const stack = { children: [data, context], querySelector: () => data };
  data.after = child => {
    stack.children = stack.children.filter(item => item !== child);
    stack.children.splice(stack.children.indexOf(data) + 1, 0, child);
  };
  const controller = controllerFor(['_initRightPanelAdaptiveLayout'], {
    getElementById: id => id === context.id ? context : null,
  });
  controller._rightPanelStack = stack; controller._ppToggles = display;
  controller._syncPanelCollapseButton = () => {};
  controller._scheduleRightPanelLayout = () => {};
  controller._initRightPanelAdaptiveLayout();
  controller._initRightPanelAdaptiveLayout();
  assert.deepEqual(stack.children, [data, display, context]);
  assert.equal(stack.children[1], display);
  assert.ok(display.classList.contains('collapsed'), 'mounting must not change the saved disclosure');
});

test('the combined sidebar never hides collapsed peers when Display or Context expands', () => {
  const data = panel('data-panel'), display = panel('pp-toggles'), context = panel('global-context-panel');
  const stack = { children: [data, display, context], dataset: { sentrySidebar: 'true' } };
  const controller = controllerFor(['_syncRightPanelAdaptiveLayout'], {});
  controller._rightPanelStack = stack;
  for (const expanded of [data, display, context]) {
    expanded.classList.toggle('collapsed', false);
    controller._syncRightPanelAdaptiveLayout();
    assert.equal(expanded.classList.contains('collapsed'), false);
    for (const peer of stack.children) assert.equal(peer.attributes.get('aria-hidden'), undefined);
    expanded.classList.toggle('collapsed', true);
  }
  assert.equal(stack.dataset.layoutMode, 'sentry-flow');
});

test('left sidebar disclosures keep expanded accessibility state with vertical-stack glyphs', () => {
  const display = panel('pp-toggles');
  const attributes = new Map();
  const button = { closest: () => display, setAttribute: (key, value) => attributes.set(key, value) };
  display.closest = () => ({ dataset: { sentrySidebar: 'true' } });
  display.querySelectorAll = () => [button];
  display.querySelector = selector => selector === '.panel-title, .pp-header-label' ? { textContent: 'DISPLAY' } : null;
  const controller = controllerFor(['_syncPanelCollapseButton'], {});
  controller._syncPanelCollapseButton(display);
  assert.equal(button.textContent, '+');
  assert.equal(attributes.get('aria-expanded'), 'false');
  assert.equal(attributes.get('aria-label'), 'Expand DISPLAY');
  display.classList.toggle('collapsed', false);
  controller._syncPanelCollapseButton(display);
  assert.equal(button.textContent, '−');
  assert.equal(attributes.get('aria-expanded'), 'true');
  assert.equal(attributes.get('aria-label'), 'Collapse DISPLAY');
});


function scrollSurface(id, scrollTop) {
  const surface = panel(id);
  const listeners = new Map();
  Object.assign(surface, {
    scrollTop,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    emitScroll() { listeners.get('scroll')?.(); },
    hasScrollListener: () => listeners.has('scroll'),
  });
  return surface;
}

function displayPortalFixture(sidebar) {
  const frames = [];
  const display = scrollSurface('pp-toggles', 21);
  const rail = scrollSurface('right-context-rail', 84);
  rail.dataset = { sentrySidebar: sidebar ? 'true' : 'false' };
  const cockpit = scrollSurface('cockpit-display-panel', 12);
  const group = { parentNode: display, contains: () => false };
  const slot = { append(child) { child.parentNode = slot; } };
  const anchor = { parentNode: display, after(child) { child.parentNode = display; } };
  group.before = inserted => assert.equal(inserted, anchor);
  cockpit.querySelector = selector => selector.includes('="hud"') ? slot : null;
  const controller = controllerFor([
    '_initCockpitDisplayPortal', '_setCockpitDisplayPortalActive', '_revealStyleParameters',
  ], {
    body: { classList: { contains: () => false } },
    createComment: () => anchor,
    activeElement: null,
  }, {
    window: { addEventListener() {} },
    requestAnimationFrame: callback => frames.push(callback),
  });
  Object.assign(controller, {
    _rightPanelStack: rail,
    _ppToggles: display,
    _cockpitDisplayPanel: cockpit,
    _cockpitDisplayPortalActive: false,
    _hudBtn: { closest: () => group },
    _layoutRightPanels() {},
    _syncPanelCollapseButton() {},
    setPanelCollapsed(id, collapsed, options) {
      assert.equal(id, 'pp-toggles');
      assert.equal(collapsed, false);
      assert.equal(options.explicit, true);
    },
  });
  controller._initCockpitDisplayPortal();
  return {
    controller, rail, display, cockpit, group, slot,
    frame() {
      assert.ok(frames.length, 'a restoration frame must be scheduled');
      frames.shift()();
    },
  };
}

for (const sidebar of [true, false]) {
  const layout = sidebar ? 'native sidebar' : 'legacy Display';
  test(`${layout} reveals parameters through the actual standard scroll owner`, () => {
    const fixture = displayPortalFixture(sidebar);
    const { controller, rail, display } = fixture;
    const owner = sidebar ? rail : display;
    const untouched = sidebar ? display : rail;
    const untouchedScroll = untouched.scrollTop;
    const slider = panel('param-slider-panel');
    slider.classList.toggle('active', true);
    slider.getBoundingClientRect = () => ({ top: 430 });
    owner.getBoundingClientRect = () => ({ top: 100 });
    controller._sliderPanel = slider;
    const initialScroll = owner.scrollTop;

    controller._revealStyleParameters();
    fixture.frame();
    fixture.frame();

    assert.equal(slider.classList.contains('collapsed'), false);
    assert.equal(owner.scrollTop, initialScroll + 322);
    assert.equal(untouched.scrollTop, untouchedScroll);
  });

  test(`${layout} preserves both scroll positions through Cockpit reparenting`, () => {
    const fixture = displayPortalFixture(sidebar);
    const { controller, rail, display, cockpit, group, slot } = fixture;
    const owner = sidebar ? rail : display;
    const untouched = sidebar ? display : rail;
    assert.equal(controller._standardDisplayScrollOwner, owner);
    assert.equal(owner.hasScrollListener(), true);
    assert.equal(untouched.hasScrollListener(), false);
    owner.scrollTop = 200;
    owner.emitScroll();

    controller._setCockpitDisplayPortalActive(true);
    assert.equal(group.parentNode, slot, 'the original controls enter Cockpit');
    owner.scrollTop = 0;
    owner.emitScroll();
    assert.equal(controller._standardDisplayScrollTop, 200, 'hidden standard layout cannot overwrite its saved position');
    fixture.frame();
    fixture.frame();
    assert.equal(cockpit.scrollTop, 12);
    cockpit.scrollTop = 118;
    cockpit.emitScroll();

    controller._setCockpitDisplayPortalActive(false);
    assert.equal(group.parentNode, display, 'the same controls return to their original anchor');
    fixture.frame();
    assert.equal(owner.scrollTop, 200);
    owner.scrollTop = 0; // A settling layout pass can clamp the first restored position.
    fixture.frame();
    assert.equal(owner.scrollTop, 200, 'the settling frame restores the owning rail a second time');
    assert.equal(controller._displayPortalScrollRestoreOwner, null);

    controller._setCockpitDisplayPortalActive(true);
    cockpit.scrollTop = 0;
    fixture.frame();
    fixture.frame();
    assert.equal(cockpit.scrollTop, 118, 'returning to Cockpit keeps its independent scroll position');
  });
}
