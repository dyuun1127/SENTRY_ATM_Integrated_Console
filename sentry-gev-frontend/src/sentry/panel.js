/** SENTRY monitoring and controller decisions; /scenario owns playback controls. */
import { prepareFrame } from './adapter.js';
import { createDecisionView } from './decisionView.js';
export { primaryRecommendation } from './decision.js';
const LOCAL_CONSOLE_URL = (import.meta.env?.SENTRY_BACKEND_URL || 'http://127.0.0.1:8782').replace(/\/+$/, '') + '/';
/** The public gateway supplies same-origin links; the local console keeps its own port. */
export function panelAccess(config = globalThis.__SENTRY_PUBLIC_CONFIG__) {
  return config ? { consoleUrl: '/console/', scenarioUrl: '/scenario', viewer: config.viewer === true }
    : { consoleUrl: LOCAL_CONSOLE_URL, scenarioUrl: `${LOCAL_CONSOLE_URL}scenario`, viewer: false };
}
const WAITING = new Set(['CONFLICT_DETECTED', 'RECOMMENDATION_AVAILABLE',
  'DECISION_ACCEPTED', 'DECISION_MODIFIED', 'MODIFICATION_REVALIDATED', 'BLOCKED_MODIFICATION']);
const STAGES = { READY: '시연 준비', MONITORING: '감시 중', DEVIATION_DETECTED: '진입 편차',
  CONFLICT_DETECTED: '충돌 탐지', RECOMMENDATION_AVAILABLE: '관제사 판단 대기',
  DECISION_ACCEPTED: '승인 · 적용 대기', DECISION_MODIFIED: '수정 · 검증 대기',
  MODIFICATION_REVALIDATED: '검증 완료 · 적용 대기', BLOCKED_MODIFICATION: '수정안 반려',
  DECISION_REJECTED: '권고 거부', CONFLICT_RESOLVED: '충돌 해소' };
const fmt = (value, digits = 0) => Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
export function elapsedLabel(seconds) {
  if (!Number.isFinite(seconds)) return '--:--:--';
  const whole = Math.max(0, Math.floor(seconds));
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
    .map((value) => String(value).padStart(2, '0')).join(':');
}
export function stageLabel(session) {
  if (session?.stage === 'MODIFICATION_REVALIDATED') {
    const evidence = session.modified_revalidation;
    if (evidence?.safe_to_apply === true && evidence?.verdict === 'SAFE') return '검증 완료 · 적용 대기';
    return evidence ? '수정안 적용 불가' : '수정안 검증 결과 확인 필요';
  }
  return session ? STAGES[session.stage] || session.stage : '연결 대기';
}
function utcLabel(value) {
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '시뮬레이션 시각 대기';
}
function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

/**
 * Callbacks: onSelect(id), onFollow(id|null), onFocusAirport(),
 * onLayerToggle(enabled), and onCommand(payload, expectedDecisionKey) -> Promise.
 * Import panel.css from the integration entry point. No polling or mutations occur here.
 */
export function createSentryPanel({ onFocusAirport = () => {}, onSelect = () => {},
  onFollow = () => {}, onCommand = () => {}, onLayerToggle = () => {} } = {}) {
  const access = panelAccess();
  const scenarioLink = new URL(access.scenarioUrl, globalThis.location?.href || LOCAL_CONSOLE_URL);
  if (globalThis.location?.origin) scenarioLink.searchParams.set('globe', globalThis.location.origin + '/?sentry=1');
  const launcher = node('button', 'snt-launcher');
  launcher.id = 'snt-launcher'; launcher.type = 'button';
  launcher.innerHTML = '<span class="snt-launch-mark" aria-hidden="true">◎</span><span>SENTRY <small>CONSOLE</small></span>';
  launcher.setAttribute('aria-controls', 'snt-panel');
  launcher.setAttribute('aria-expanded', 'true');
  const panel = node('aside', 'snt-panel');
  panel.id = 'snt-panel'; panel.lang = 'ko'; panel.setAttribute('aria-labelledby', 'snt-title');
  panel.innerHTML = `
    <header class="snt-header"><div><p class="snt-eyebrow">RKTU / CONTROLLER WORKSPACE</p><h2 id="snt-title">SENTRY <span>ATM</span></h2></div><button class="snt-icon-button" id="snt-close" type="button" aria-label="SENTRY 패널 닫기">×</button></header>
    <div class="snt-body">
      <div class="snt-provenance"><span class="snt-badge">PLAYBACK + SYNTHETIC</span><p>기록·합성 항적 시연 · 공개 실시간 피드와 별도</p></div>
      <section class="snt-section"><div class="snt-row"><h3>시뮬레이션 상태</h3><span id="snt-stage" class="snt-stage">연결 대기</span></div><p id="snt-clock" class="snt-clock">--:--:--</p><p id="snt-utc" class="snt-meta">시뮬레이션 시각 대기</p><p id="snt-current-step" class="snt-step">시나리오를 불러오고 있습니다.</p>
        <p class="snt-note">재생·정지·배속·초기화는 별도 시연 진행 화면에서 조작합니다.</p>
      </section>
      <div id="snt-decision-host"></div>
      <section class="snt-section"><div class="snt-row"><h3>항공기 <span id="snt-contact-count">0</span></h3><button id="snt-layer" class="snt-text-button" type="button" aria-pressed="true">지도 표시 켜짐</button></div><div class="snt-map-actions"><button id="snt-airport" class="snt-button" type="button">청주 공역</button><button id="snt-follow" class="snt-button" type="button" aria-pressed="false" disabled>선택 항공기 추적</button></div><div id="snt-contacts" class="snt-contacts" aria-label="SENTRY 시연 항공기 목록"></div><p class="snt-path-legend">실선: 시연 이력 · 점선: CV 예측(30·60·120초)</p><p id="snt-prediction-status" class="snt-note">현재 시각 CV 예측 대기</p></section>
      <p id="snt-status" class="snt-status" role="status" aria-live="polite">SENTRY 연결을 기다리고 있습니다.</p>
    </div>
    <footer class="snt-footer"><a id="snt-console-link" href="${access.consoleUrl}" target="_blank" rel="noopener noreferrer">보조 2D 콘솔 ↗</a><a href="${scenarioLink.href}" target="_blank" rel="noopener noreferrer">시연 진행 화면 ↗</a><p>DEMONSTRATION · 실제 관제용 아님</p></footer>`;
  document.body.append(launcher, panel);
  const $ = (id) => panel.querySelector(`#snt-${id}`);
  let snapshot = { session: null, scenario: null, advisory: null, prediction: null, selectedId: null, followingId: null, enabled: true };
  let destroyed = false;
  const decisionView = createDecisionView({ onCommand, onSelect });
  $('decision-host').append(decisionView.element);
  const rows = new Map();
  function setOpen(open) {
    const focusWasInside = panel.contains(document.activeElement);
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    if (!open && focusWasInside) launcher.focus();
    if (open) $('close').focus();
  }
  launcher.addEventListener('click', () => setOpen(panel.hidden));
  $('close').addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', (event) => {
    // Let map and original GOD's EYE shortcuts keep their own context.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
  });
  $('airport').addEventListener('click', () => onFocusAirport());
  $('layer').addEventListener('click', () => onLayerToggle(!snapshot.enabled));
  $('follow').addEventListener('click', () => {
    if (snapshot.followingId) onFollow(null);
    else if (snapshot.selectedId) onFollow(snapshot.selectedId);
  });
  function setStatus(text, kind = '') {
    if (destroyed) return;
    $('status').textContent = text;
    $('status').dataset.kind = kind;
  }
  function render(data) {
    if (destroyed) return;
    snapshot = { ...snapshot, ...data };
    const { session, scenario, prediction, selectedId, followingId, enabled } = snapshot;
    $('stage').textContent = stageLabel(session);
    $('stage').dataset.alert = String(WAITING.has(session?.stage));
    $('clock').textContent = elapsedLabel(session?.elapsed_seconds);
    $('clock').title = '시뮬레이션 경과 시간';
    $('utc').textContent = utcLabel(session?.simulation_time_utc);
    const current = (scenario?.steps || []).filter((step) => step.t_s <= (session?.elapsed_seconds ?? -1))
      .sort((a, b) => b.t_s - a.t_s)[0];
    $('current-step').textContent = current ? `${current.n}. ${current.name}` : session && !scenario ? '단계 정보 연결 대기' : '시연 준비';
    $('current-step').title = current?.detail || scenario?.title || '';
    $('layer').setAttribute('aria-pressed', String(Boolean(enabled)));
    $('layer').textContent = enabled ? '지도 표시 켜짐' : '지도 표시 꺼짐';
    $('follow').disabled = !enabled || (!selectedId && !followingId);
    $('follow').setAttribute('aria-pressed', String(Boolean(followingId)));
    $('follow').textContent = followingId ? '추적 해제' : '선택 항공기 추적';
    $('follow').title = followingId || selectedId || '항공기를 먼저 선택하세요.';
    const traffic = [...(session?.traffic || [])].sort((a, b) =>
      Number(b.emergency_status === 'DECLARED') - Number(a.emergency_status === 'DECLARED') || a.aircraft_id.localeCompare(b.aircraft_id));
    const ids = new Set(traffic.map((item) => item.aircraft_id));
    for (const [id, row] of rows) if (!ids.has(id)) { row.button.remove(); rows.delete(id); }
    $('contacts').querySelector('.snt-empty')?.remove();
    for (const aircraft of traffic) {
      let row = rows.get(aircraft.aircraft_id);
      if (!row) {
        const button = node('button', 'snt-contact'); button.type = 'button';
        const head = node('span', 'snt-contact-head');
        const callsign = node('strong', '', aircraft.aircraft_id), source = node('span', 'snt-source');
        const meta = node('span', 'snt-contact-meta');
        head.append(callsign, source); button.append(head, meta);
        button.addEventListener('click', () => {
          Promise.resolve().then(() => onSelect(aircraft.aircraft_id))
            .catch(error => setStatus(error.message, 'error'));
        });
        row = { button, source, meta }; rows.set(aircraft.aircraft_id, row);
        $('contacts').append(button);
      }
      const emergency = aircraft.emergency_status === 'DECLARED';
      row.source.textContent = emergency ? '비상' : aircraft.source === 'OPENSKY' ? 'OpenSky 기록' : aircraft.source === 'SYNTHETIC' ? '합성' : aircraft.source || '출처 미상';
      row.button.dataset.emergency = String(emergency);
      row.button.setAttribute('aria-pressed', String(aircraft.aircraft_id === selectedId));
      row.meta.textContent = `${aircraft.aircraft_type} · ${fmt(aircraft.altitude_ft)} ft · ${fmt(aircraft.ground_speed_kt)} kt`;
      row.button.title = `${aircraft.aircraft_id} · ${aircraft.source} · ${aircraft.flight_phase}`;
    }
    // Keep the same button nodes so periodic snapshots do not steal keyboard focus.
    const order = traffic.map((aircraft) => rows.get(aircraft.aircraft_id).button);
    order.forEach((button, i) => { if ($('contacts').children[i] !== button) $('contacts').insertBefore(button, $('contacts').children[i] || null); });
    if (!traffic.length) $('contacts').append(node('p', 'snt-empty', session ? '현재 시각에 표시할 항공기가 없습니다.' : '항적 연결 대기'));
    $('contact-count').textContent = String(traffic.length);
    const predictedCount = prepareFrame(session, prediction).paths.length;
    $('prediction-status').textContent = !enabled ? 'SENTRY 지도 표시 꺼짐'
      : predictedCount ? `현재 시각 CV 예측 ${predictedCount}대` : '현재 시각 CV 예측 대기';
    decisionView.render(snapshot);
  }
  render({});
  return { render, setStatus, setBusy(value) { if (!destroyed) decisionView.setBusy(value); },
    destroy() { destroyed = true; decisionView.destroy(); launcher.remove(); panel.remove(); rows.clear(); } };
}
