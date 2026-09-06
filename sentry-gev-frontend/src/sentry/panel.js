/** SENTRY's deterministic demo controls, separate from God's Eye public live feeds. */
import { prepareFrame } from './adapter.js';
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
export function commandState(session, scenario) {
  const elapsed = session?.elapsed_seconds ?? 0;
  const waiting = WAITING.has(session?.stage);
  const end = Number.isFinite(scenario?.duration_seconds) ? scenario.duration_seconds : null;
  const remaining = end === null ? 30 : Math.max(0, Math.ceil(end - elapsed));
  const next = (scenario?.steps || []).filter((step) => Number.isFinite(step.t_s) && step.t_s > elapsed)
    .sort((a, b) => a.t_s - b.t_s)[0];
  return {
    waiting,
    start: session?.stage === 'READY' ? { command: 'START' } : null,
    advance: session && !waiting && remaining > 0 ? { command: 'ADVANCE', seconds: Math.min(30, remaining) } : null,
    next: session && !waiting && next ? { command: 'ADVANCE', seconds: Math.max(1, Math.ceil(next.t_s - elapsed)) } : null,
    nextName: next?.name || '마지막 이벤트',
  };
}
export function primaryRecommendation(session) {
  const set = session?.recommendation;
  return set?.recommendations?.find((item) => item.recommendation_id === set.primary_recommendation_id)
    || set?.recommendations?.[0] || null;
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
 * onLayerToggle(enabled), and onCommand({command, ...fields}) -> Promise.
 * Import panel.css from the integration entry point. No polling or mutations occur here.
 */
export function createSentryPanel({ onFocusAirport = () => {}, onSelect = () => {},
  onFollow = () => {}, onCommand = () => {}, onLayerToggle = () => {} } = {}) {
  const access = panelAccess();
  const launcher = node('button', 'snt-launcher');
  launcher.id = 'snt-launcher'; launcher.type = 'button';
  launcher.innerHTML = '<span class="snt-launch-mark" aria-hidden="true">◎</span><span>SENTRY <small>DEMO</small></span>';
  launcher.setAttribute('aria-controls', 'snt-panel');
  launcher.setAttribute('aria-expanded', 'true');
  const panel = node('aside', 'snt-panel');
  panel.id = 'snt-panel'; panel.lang = 'ko'; panel.setAttribute('aria-labelledby', 'snt-title');
  panel.innerHTML = `
    <header class="snt-header"><div><p class="snt-eyebrow">RKTU / TERMINAL SIMULATION</p><h2 id="snt-title">SENTRY <span>ATM</span></h2></div><button class="snt-icon-button" id="snt-close" type="button" aria-label="SENTRY 패널 닫기">×</button></header>
    <div class="snt-body">
      <div class="snt-provenance"><span class="snt-badge">PLAYBACK + SYNTHETIC</span><p>기록·합성 항적 시연 · 공개 실시간 피드와 별도</p></div>
      <section class="snt-section"><div class="snt-row"><h3>시뮬레이션</h3><span id="snt-stage" class="snt-stage">연결 대기</span></div><p id="snt-clock" class="snt-clock">--:--:--</p><p id="snt-utc" class="snt-meta">시뮬레이션 시각 대기</p><p id="snt-current-step" class="snt-step">시나리오를 불러오고 있습니다.</p>
        <div class="snt-commands"><button class="snt-button" id="snt-reset" type="button">처음으로</button><button class="snt-button snt-primary" id="snt-advance" type="button">+30초</button><button class="snt-button" id="snt-next" type="button">다음 이벤트 →</button></div>
        <p id="snt-waiting" class="snt-callout" hidden>관제사 판단 대기 · 2D 콘솔에서 상신·승인·수정·거부를 진행하세요.</p>
        <p class="snt-note">${access.viewer ? '외부 관람 모드 · 시나리오 조작은 발표자 PC에서 진행합니다.' : '시연 화면에서 자동 재생 중이면 먼저 일시정지해 주세요.'}</p>
      </section>
      <section class="snt-section"><div class="snt-row"><h3>항공기 <span id="snt-contact-count">0</span></h3><button id="snt-layer" class="snt-text-button" type="button" aria-pressed="true">지도 표시 켜짐</button></div><div class="snt-map-actions"><button id="snt-airport" class="snt-button" type="button">청주 공역</button><button id="snt-follow" class="snt-button" type="button" aria-pressed="false" disabled>선택 항공기 추적</button></div><div id="snt-contacts" class="snt-contacts" aria-label="SENTRY 시연 항공기 목록"></div><p class="snt-path-legend">실선: 시연 이력 · 점선: CV 예측(30·60·120초)</p><p id="snt-prediction-status" class="snt-note">현재 시각 CV 예측 대기</p></section>
      <section class="snt-section"><div class="snt-row"><h3>충돌·권고</h3><span id="snt-exception-count" class="snt-meta">—</span></div><div id="snt-conflict" class="snt-summary"></div><div id="snt-recommendation" class="snt-recommendation"></div><h4 class="snt-subtitle">접근 추천 순서</h4><p id="snt-order" class="snt-order">계산 결과 대기</p><p class="snt-note">추천은 관제사 승인 전 항공기에 적용되지 않습니다.</p></section>
      <p id="snt-status" class="snt-status" role="status" aria-live="polite">SENTRY 연결을 기다리고 있습니다.</p>
    </div>
    <footer class="snt-footer"><a id="snt-console-link" href="${access.consoleUrl}" target="_blank" rel="noopener noreferrer">2D 판단 콘솔 ↗</a><a href="${access.scenarioUrl}" target="_blank" rel="noopener noreferrer">시연 진행 화면 ↗</a><p>DEMONSTRATION · 실제 관제용 아님</p></footer>`;
  document.body.append(launcher, panel);
  const $ = (id) => panel.querySelector(`#snt-${id}`);
  let snapshot = { session: null, scenario: null, advisory: null, prediction: null, selectedId: null, followingId: null, enabled: true };
  let externalBusy = false, commandPending = false, destroyed = false;
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
  function updateControls() {
    const controls = commandState(snapshot.session, snapshot.scenario);
    const busy = externalBusy || commandPending || access.viewer;
    $('reset').disabled = busy || !snapshot.session;
    $('advance').disabled = busy || !(controls.start || controls.advance);
    $('advance').textContent = controls.start ? '시연 시작' : '+30초';
    $('next').disabled = busy || !controls.next;
    $('next').title = controls.nextName;
    $('waiting').hidden = !controls.waiting;
    $('console-link').classList.toggle('snt-needs-decision', controls.waiting);
  }
  async function command(payload) {
    if (!payload || destroyed || externalBusy || commandPending || access.viewer) return;
    commandPending = true; updateControls();
    try { await onCommand(payload); }
    catch (error) { setStatus(error?.message || String(error), 'error'); }
    finally { commandPending = false; if (!destroyed) updateControls(); }
  }
  $('reset').addEventListener('click', () => command({ command: 'RESET' }));
  $('advance').addEventListener('click', () => {
    const controls = commandState(snapshot.session, snapshot.scenario);
    void command(controls.start || controls.advance);
  });
  $('next').addEventListener('click', () => { void command(commandState(snapshot.session, snapshot.scenario).next); });
  function render(data) {
    if (destroyed) return;
    snapshot = { ...snapshot, ...data };
    const { session, scenario, prediction, selectedId, followingId, enabled } = snapshot;
    const advisory = snapshot.advisory?.step_id === session?.step_id ? snapshot.advisory : null;
    $('stage').textContent = session ? STAGES[session.stage] || session.stage : '연결 대기';
    $('stage').dataset.alert = String(WAITING.has(session?.stage));
    $('clock').textContent = elapsedLabel(session?.elapsed_seconds);
    $('clock').title = '시뮬레이션 경과 시간';
    $('utc').textContent = utcLabel(session?.simulation_time_utc);
    const current = (scenario?.steps || []).filter((step) => step.t_s <= (session?.elapsed_seconds ?? -1))
      .sort((a, b) => b.t_s - a.t_s)[0];
    $('current-step').textContent = current ? `${current.n}. ${current.name}` : '시연 준비';
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
        button.addEventListener('click', () => onSelect(aircraft.aircraft_id));
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
    $('exception-count').textContent = session ? `예외 ${session.active_exception_count ?? 0}건` : '—';
    $('conflict').replaceChildren();
    const conflict = session?.primary_conflict;
    if (conflict) {
      $('conflict').append(node('strong', 'snt-conflict-pair', (conflict.aircraft_ids || []).join(' / ')),
        node('p', '', `최근접 수평 ${fmt(conflict.horizontal_separation_nm, 2)} / 기준 ${fmt(conflict.horizontal_threshold_nm, 1)} NM`),
        node('p', '', `수직 ${fmt(conflict.vertical_separation_ft)} / 기준 ${fmt(conflict.vertical_threshold_ft)} ft`),
        node('p', 'snt-meta', `${conflict.risk_level || '—'} · TCPA ${fmt(conflict.tcpa_seconds)}초 · ${conflict.status || '—'}`),
        node('p', 'snt-evidence-time', `평가 ${utcLabel(conflict.evaluated_at_utc)}`));
    } else $('conflict').append(node('p', 'snt-empty', session ? '현재 주요 충돌 근거 없음' : '충돌 평가 대기'));
    const recommendation = primaryRecommendation(session);
    $('recommendation').replaceChildren();
    if (recommendation) {
      const maneuver = recommendation.maneuver || {};
      const summary = [recommendation.target_aircraft_id, maneuver.maneuver_type,
        Number.isFinite(maneuver.target_altitude_ft) ? `${fmt(maneuver.target_altitude_ft)} ft` : null,
        Number.isFinite(maneuver.target_heading_deg) ? `${fmt(maneuver.target_heading_deg)}°` : null,
        Number.isFinite(maneuver.target_speed_kt) ? `${fmt(maneuver.target_speed_kt)} kt` : null].filter(Boolean).join(' · ');
      $('recommendation').append(node('p', 'snt-subtitle', '서버 권고'), node('p', '', summary));
      if (recommendation.explanation) $('recommendation').append(node('p', 'snt-meta', recommendation.explanation));
    }
    $('order').textContent = advisory?.approach_order?.length ? advisory.approach_order.join(' → ')
      : session ? '현재 시점의 추천 순서 없음' : '계산 결과 대기';
    updateControls();
  }
  render({});
  return { render, setStatus, setBusy(value) { externalBusy = Boolean(value); if (!destroyed) updateControls(); },
    destroy() { destroyed = true; launcher.remove(); panel.remove(); rows.clear(); } };
}
