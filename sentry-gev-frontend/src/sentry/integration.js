import { createSentryPanel } from './panel.js';
import { createSentryController } from './controller.js';
import './panel.css';

export function initSentryIntegration({ dataManager, styleManager, layer }) {
  const controller = createSentryController();
  layer.setCameraPreparation(() => styleManager.beginLocationNavigation());
  layer.setSessionSource(controller);
  const panel = createSentryPanel({
    onFocusAirport: () => layer.focusAirport(),
    onSelect: async (id) => {
      // Queue selection explicitly enables its map representation when necessary.
      if (!layer.getSnapshot().enabled) await dataManager.setEnabled(layer.id, true);
      if (!layer.select(id)) throw new Error(layer.getSnapshot().error || '항공기를 선택할 수 없습니다. 최신 항적을 확인해 주세요.');
    },
    onFollow: (id) => layer.follow(id),
    onLayerToggle: async (enabled) => {
      try { await dataManager.setEnabled(layer.id, enabled); }
      catch { panel.setStatus('SENTRY 레이어 연결을 확인해 주세요.', 'error'); }
    },
    onCommand: (payload, key) => controller.command(payload, key),
  });
  function render() {
    const map = layer.getSnapshot();
    const state = controller.getSnapshot();
    const error = state.error || map.error;
    panel.render({ ...map, ...state, error });
    panel.setBusy(state.busy);
    if (error) panel.setStatus(error, 'error');
    else if (state.session) panel.setStatus(state.access.canControl
      ? 'SENTRY 연결됨 · 관제 판단 가능' : 'SENTRY 연결됨 · 관람 모드', 'ready');
  }
  const unsubscribeMap = layer.subscribe(render);
  const unsubscribeSession = controller.subscribe(render);
  render();
  controller.start();
  // Map visibility remains the user's choice, including historical shared links.
  const ready = Promise.resolve(styleManager.initialRestorePromise).then(async () => {
    if (!styleManager.hasShareState) await dataManager.setEnabled(layer.id, true);
    await controller.refresh();
  }).catch(() => panel.setStatus('SENTRY 지도 연결을 확인해 주세요.', 'error'));
  return { layer, panel, controller, ready, destroy() {
    unsubscribeMap(); unsubscribeSession(); controller.destroy(); panel.destroy();
  } };
}
