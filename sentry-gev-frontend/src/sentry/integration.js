import { createSentryPanel } from './panel.js';
import './panel.css';

export function initSentryIntegration({ dataManager, styleManager, layer }) {
  layer.setCameraPreparation(() => styleManager.beginLocationNavigation());
  const panel = createSentryPanel({
    onFocusAirport: () => layer.focusAirport(),
    onSelect: (id) => layer.select(id),
    onFollow: (id) => layer.follow(id),
    onLayerToggle: async (enabled) => {
      try { await dataManager.setEnabled(layer.id, enabled); }
      catch { panel.setStatus('SENTRY 레이어 연결을 확인해 주세요.', 'error'); }
    },
    onCommand: async (payload) => {
      panel.setBusy(true);
      try { await layer.command(payload); }
      catch (error) { panel.setStatus(error.message, 'error'); }
      finally { panel.setBusy(false); }
    },
  });
  layer.subscribe((snapshot) => {
    panel.render(snapshot);
    if (snapshot.error) panel.setStatus(snapshot.error, 'error');
    else if (snapshot.session) panel.setStatus('V2 데모 연결됨 · 실제 교통 분석과 별도', 'ready');
  });
  panel.render(layer.getSnapshot());
  // Preserve authored shared layer state. The SENTRY entry only opts in on a
  // fresh view; the original GEV layer manager remains the lifecycle owner.
  const ready = Promise.resolve(styleManager.initialRestorePromise).then(async () => {
    if (!styleManager.hasShareState) {
      await dataManager.setEnabled(layer.id, true);
      // main.js placed the initial camera before restore; preserve any restored Follow.
    }
  }).catch(() => panel.setStatus('SENTRY 레이어를 켜서 다시 연결할 수 있습니다.', 'error'));
  return { layer, panel, ready };
}
