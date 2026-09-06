/** Controller decisions for the Globe. All judgments and mutations remain on the server. */
import { buildDecisionCommand, decisionActions, decisionKey, primaryRecommendation } from './decision.js';

const ACTION_IDS = {
  GENERATE_RECOMMENDATION: 'generate', ACCEPT_RECOMMENDATION: 'accept',
  MODIFY_RECOMMENDATION: 'modify', REJECT_RECOMMENDATION: 'reject',
  REVALIDATE_MODIFIED_MANEUVER: 'revalidate', APPLY_APPROVED_MANEUVER: 'apply',
  APPLY_VALIDATED_MODIFIED_MANEUVER: 'apply-mod',
};
const PRIORITY_LABEL = { EMERGENCY: '비상', URGENT: '긴급', ATTENTION: '주의', ROUTINE: '일반' };
const RISK_LABEL = { CRITICAL: '긴급', HIGH: '위험', MEDIUM: '주의', LOW: '낮음' };
const exceptionLabel = (item) => (item.kind === 'OPERATIONAL_PRIORITY' ? PRIORITY_LABEL
  : item.kind === 'CONFLICT_RISK' ? RISK_LABEL : {})[item.severity] || item.severity || '미분류';
const REASONS = {
  EMERGENCY_DECLARED: '비상 선언', AIRCRAFT_CONDITION: '기체 상태',
  PREDICTED_SEPARATION_LOSS: '분리 상실 예측', HORIZONTAL_THRESHOLD_BREACH: '수평 기준 미달',
  VERTICAL_THRESHOLD_BREACH: '수직 기준 미달', SHORT_TCPA: '최근접까지 시간 부족',
  ENTRY_CONFORMANCE_DEVIATION: '진입 편차',
};
const list = (value) => Array.isArray(value) ? value : [];
const fmt = (value, digits = 0) => Number.isFinite(value)
  ? value.toLocaleString('ko-KR', { maximumFractionDigits: digits }) : '—';
const boolLabel = (value, yes, no) => value === true ? yes : value === false ? no : '미제공';
const applicableModification = (value) => value?.safe_to_apply === true && value?.verdict === 'SAFE';
const reasonText = (value) => list(value).map((code) => REASONS[code] || code).join(' · ');
const utc = (value) => {
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC` : '—';
};
function node(tag, className = '', text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = String(text ?? '—');
  return item;
}
function paragraph(text, className = 'snt-decision-meta') { return node('p', className, text); }
function metrics(rows) {
  const box = node('dl', 'snt-decision-evidence');
  for (const [label, value] of rows) {
    const row = node('div', 'snt-decision-kv');
    row.append(node('dt', '', label), node('dd', '', value)); box.append(row);
  }
  return box;
}
function maneuverText(maneuver = {}) {
  return [maneuver.maneuver_type,
    Number.isFinite(maneuver.target_altitude_ft) ? `${fmt(maneuver.target_altitude_ft)} ft` : null,
    Number.isFinite(maneuver.target_heading_deg) ? `침로 ${fmt(maneuver.target_heading_deg, 1)}°` : null,
    Number.isFinite(maneuver.target_ground_speed_kt) ? `${fmt(maneuver.target_ground_speed_kt)} kt` : null,
    Number.isFinite(maneuver.delay_seconds) ? `지연 ${fmt(maneuver.delay_seconds)}초` : null,
    Number.isFinite(maneuver.target_sequence_position) ? `순서 ${fmt(maneuver.target_sequence_position)}` : null,
  ].filter(Boolean).join(' · ') || '기동 정보 없음';
}

/** onCommand(payload, expectedDecisionKey) must reject failures; this view never retries. */
export function createDecisionView({ onCommand = async () => { throw new Error('명령 전송이 연결되지 않았습니다.'); }, onSelect = () => {} } = {}) {
  const element = node('div', 'snt-decision'); element.id = 'snt-decision-view'; element.lang = 'ko';
  const notice = paragraph('', 'snt-decision-notice'); notice.hidden = true;
  const status = paragraph('', 'snt-decision-status'); status.id = 'snt-decision-status';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  element.append(notice);
  const sections = new Map(), memoKeys = new Map(), buttons = new Map();
  let snapshot = { session: null, advisory: null, selectedId: null, stale: true, access: { canControl: false } };
  let externalBusy = false, pending = false, destroyed = false, formKey;
  function section(id, title, collapsible = false) {
    const shell = node(collapsible ? 'details' : 'section',
      collapsible ? 'snt-decision-section snt-decision-details' : 'snt-decision-section');
    shell.id = `snt-decision-${id}`;
    const heading = node(collapsible ? 'summary' : 'h3', 'snt-decision-heading', title);
    const body = node('div', 'snt-decision-content'); shell.append(heading, body); element.append(shell);
    const value = { shell, heading, body }; sections.set(id, value); return value;
  }
  section('queue', '예외 큐');
  section('deviation', '진입 편차');
  section('conflict', '주요 충돌 · 판단 근거');
  section('recommendation', '서버 권고');
  section('candidates', '후보 비교', true);
  const decisionSection = section('controls', '관제사 판단');
  const form = node('form', 'snt-decision-form');
  const altitudeField = node('label', 'snt-decision-field', '수정 고도 (ft)');
  const altitude = node('input'); altitude.id = 'snt-decision-altitude'; altitude.type = 'number';
  altitude.step = 'any'; altitude.inputMode = 'decimal'; altitude.autocomplete = 'off';
  altitudeField.htmlFor = altitude.id; altitudeField.append(altitude);
  const rationaleField = node('label', 'snt-decision-field', '수정·거부 사유');
  const rationale = node('textarea'); rationale.id = 'snt-decision-rationale'; rationale.rows = 3;
  rationale.placeholder = '판단 근거를 입력하세요.'; rationaleField.htmlFor = rationale.id;
  rationaleField.append(rationale);
  const actionsBox = node('div', 'snt-decision-actions');
  const decisionHint = paragraph('', 'snt-decision-note');
  form.append(altitudeField, rationaleField, actionsBox, decisionHint);
  decisionSection.body.append(paragraph('승인과 적용은 별도 단계입니다. 수정안은 재검증을 통과해야 적용할 수 있습니다.', 'snt-decision-note'), form, status);
  section('modified', '수정안 재검증');
  section('applied', '적용 후 검증');
  section('audit', '관제사 결정 기록', true);
  section('advisory', '접근·활주로·체공·복귀 권고', true);

  const stopSubmit = (event) => event.preventDefault();
  form.addEventListener('submit', stopSubmit);
  const selectAircraft = async (event) => {
    const button = event.target?.closest?.('button[data-aircraft-id]');
    if (!button || !element.contains(button) || destroyed) return;
    try { await onSelect(button.dataset.aircraftId); }
    catch (error) { setStatus(error?.message || String(error), 'error'); }
  };
  element.addEventListener('click', selectAircraft);
  function aircraftButtons(ids) {
    const box = node('div', 'snt-decision-aircraft-list');
    for (const id of list(ids).filter((value) => typeof value === 'string' && value)) {
      const button = node('button', 'snt-decision-aircraft', id); button.type = 'button';
      button.dataset.aircraftId = id; button.setAttribute('aria-pressed', String(snapshot.selectedId === id));
      button.title = `${id} 지도에서 선택`; box.append(button);
    }
    return box;
  }
  // Keep input/button nodes and unchanged readout DOM across polling refreshes.
  function updateSection(id, values, visible, draw) {
    const target = sections.get(id); target.shell.hidden = !visible;
    const key = JSON.stringify([values, snapshot.selectedId]);
    if (memoKeys.get(id) === key) return;
    memoKeys.set(id, key);
    const focusedId = target.body.contains(document.activeElement)
      ? document.activeElement?.dataset?.aircraftId : null;
    target.body.replaceChildren();
    if (visible) draw(target.body);
    if (focusedId) [...target.body.querySelectorAll('button[data-aircraft-id]')]
      .find((button) => button.dataset.aircraftId === focusedId)?.focus({ preventScroll: true });
  }
  function setStatus(text, kind = '') {
    if (destroyed) return;
    status.textContent = String(text ?? ''); status.dataset.kind = kind;
  }
  const canSend = () => !destroyed && !pending && !externalBusy && !snapshot.busy
    && !snapshot.stale && Boolean(snapshot.session) && snapshot.access?.canControl === true;
  function updateControls() {
    if (destroyed) return;
    const actions = decisionActions(snapshot.session), available = new Map(actions.map((item) => [item.command, item]));
    for (const [command, button] of buttons) {
      const action = available.get(command); button.hidden = !action;
      if (action) { button.textContent = action.label; button.dataset.tone = action.tone || 'secondary'; }
      const unsafeModified = command === 'APPLY_VALIDATED_MODIFIED_MANEUVER'
        && !applicableModification(snapshot.session?.modified_revalidation);
      button.disabled = !canSend() || !action || unsafeModified;
    }
    const canModify = available.has('MODIFY_RECOMMENDATION');
    const canReject = available.has('REJECT_RECOMMENDATION');
    altitudeField.hidden = !canModify; rationaleField.hidden = !canModify && !canReject;
    altitude.disabled = !canSend() || !canModify;
    rationale.disabled = !canSend() || (!canModify && !canReject);
    element.setAttribute('aria-busy', String(Boolean(pending || externalBusy || snapshot.busy)));
    const modified = snapshot.session?.modified_revalidation;
    decisionHint.textContent = !snapshot.session ? '판단 정보를 기다리고 있습니다.'
      : snapshot.stale ? '최신 서버 상태가 확인될 때까지 판단 명령을 보낼 수 없습니다.'
      : snapshot.access?.canControl !== true ? '관람 모드 · 판단과 적용은 조작 가능한 화면에서 진행하세요.'
      : pending || externalBusy || snapshot.busy ? '서버 응답을 기다리고 있습니다.'
      : modified && !applicableModification(modified) && snapshot.session.stage === 'MODIFICATION_REVALIDATED'
        ? '수정안 적용 불가 · 아래 재검증 근거를 확인하세요.'
        : actions.length ? '선택한 명령만 전송합니다. 다음 단계는 결과를 확인한 뒤 직접 실행하세요.'
          : '현재 단계에서 실행할 판단 명령이 없습니다. 시연 진행은 별도 시나리오 화면을 사용하세요.';
  }
  async function submit(command) {
    if (!canSend()) return;
    const currentKey = decisionKey(snapshot.session);
    let payload;
    try { payload = buildDecisionCommand(command, snapshot.session, { altitude: altitude.value, rationale: rationale.value }); }
    catch (error) { setStatus(error?.message || String(error), 'error'); return; }
    if (command === 'APPLY_VALIDATED_MODIFIED_MANEUVER'
        && !applicableModification(snapshot.session.modified_revalidation)) {
      setStatus('서버가 안전하다고 검증한 수정안만 적용할 수 있습니다.', 'error'); return;
    }
    const label = decisionActions(snapshot.session).find((item) => item.command === command)?.label || command;
    pending = true; setStatus(`${label} 처리 중…`, 'pending'); updateControls();
    try {
      await onCommand(payload, currentKey);
      if (!destroyed) setStatus(`${label} 완료 · 서버 결과를 확인하세요.`, 'good');
    } catch (error) {
      if (!destroyed) setStatus(error?.message || String(error), 'error');
    } finally { pending = false; updateControls(); }
  }
  const actionListeners = [];
  for (const [command, id] of Object.entries(ACTION_IDS)) {
    const button = node('button', 'snt-button', command); button.type = 'button';
    button.id = `snt-decision-${id}`; button.hidden = true; button.dataset.decisionCommand = command;
    button.setAttribute('aria-describedby', status.id);
    const handler = () => { void submit(command); };
    button.addEventListener('click', handler); actionListeners.push([button, handler]);
    buttons.set(command, button); actionsBox.append(button);
  }

  function render(data = {}) {
    if (destroyed) return;
    snapshot = { ...snapshot, ...data };
    const session = snapshot.session, primary = primaryRecommendation(session);
    const currentKey = decisionKey(session);
    if (currentKey !== formKey) {
      formKey = currentKey;
      const entries = list(session?.controller_decision?.entries);
      const latest = entries.find((entry) => entry.decision_id === session?.controller_decision?.latest_decision_id);
      const proposed = latest?.recommendation_id === primary?.recommendation_id
        ? latest?.modified_maneuver?.target_altitude_ft : undefined;
      const initialAltitude = Number.isFinite(proposed) ? proposed : primary?.maneuver?.target_altitude_ft;
      altitude.value = Number.isFinite(initialAltitude) ? String(initialAltitude) : '';
      rationale.value = '';
      if (!pending) setStatus('', '');
    }
    notice.hidden = !snapshot.stale && !snapshot.error;
    notice.dataset.kind = snapshot.stale ? 'error' : 'warning';
    notice.textContent = snapshot.stale
      ? `마지막 수신 정보 · 연결 회복 전 조작 제한${snapshot.error ? ` — ${snapshot.error}` : ''}`
      : snapshot.error ? String(snapshot.error) : '';

    updateSection('queue', [session?.exception_queue, Boolean(session)], true, (body) => {
      // The server orders risk and operational priority together using its queue policy,
      // including resolution/acknowledgement state and TCPA. Do not rerank them by score.
      const items = list(session?.exception_queue?.items);
      sections.get('queue').heading.textContent = `예외 큐 · ${items.length}건`;
      if (!items.length) { body.append(paragraph(session ? '현재 표시할 예외가 없습니다.' : '예외 정보 연결 대기')); return; }
      body.append(paragraph(`갱신 ${utc(session.exception_queue.generated_at_utc)}`));
      const queue = node('ol', 'snt-decision-queue');
      for (const item of items) {
        const row = node('li', 'snt-decision-card'); row.dataset.severity = item.severity || 'UNKNOWN';
        row.dataset.selected = String(list(item.subject_aircraft_ids).includes(snapshot.selectedId));
        const head = node('div', 'snt-decision-header');
        head.append(aircraftButtons(item.subject_aircraft_ids), node('span', 'snt-badge', exceptionLabel(item)));
        row.append(head, paragraph(reasonText(item.reason_codes) || '근거 코드 없음'),
          paragraph(`${item.kind === 'CONFLICT_RISK' ? '분리 위험' : item.kind === 'OPERATIONAL_PRIORITY' ? '운영 우선순위' : item.kind || '예외'} · ${item.status || '—'} · 점수 ${fmt(item.score, 1)}`));
        if (Number.isFinite(item.tcpa_seconds)) row.append(paragraph(`최근접까지 ${fmt(item.tcpa_seconds)}초 · 수평 기준 대비 ${fmt(Number.isFinite(item.horizontal_separation_ratio) ? item.horizontal_separation_ratio * 100 : null)}% · 수직 기준 대비 ${fmt(Number.isFinite(item.vertical_separation_ratio) ? item.vertical_separation_ratio * 100 : null)}%`));
        queue.append(row);
      }
      body.append(queue);
    });
    const deviation = session?.deviation;
    updateSection('deviation', deviation, Boolean(deviation), (body) => {
      body.append(aircraftButtons([deviation.aircraft_id]), paragraph(`${deviation.expected_entry_point || '진입 지점 미제공'} · 탐지 ${utc(deviation.detected_at_utc)}`),
        metrics([['고도 · 실제 / 계획', `${fmt(deviation.actual_altitude_ft)} / ${fmt(deviation.expected_altitude_ft)} ft`],
          ['침로 · 실제 / 계획', `${fmt(deviation.actual_heading_deg, 1)}° / ${fmt(deviation.expected_heading_deg, 1)}°`],
          ['측방 편차', `${fmt(deviation.lateral_deviation_nm, 2)} NM`], ['시간 편차', `${fmt(deviation.time_deviation_seconds)}초`],
          ['수직 편차', `${fmt(deviation.vertical_deviation_ft)} ft`], ['침로 편차', `${fmt(deviation.heading_deviation_deg, 1)}°`]]),
        paragraph('진입 계획과의 편차이며, 그 자체가 충돌 판정은 아닙니다.', 'snt-decision-note'));
    });
    const conflict = session?.primary_conflict;
    updateSection('conflict', conflict, Boolean(conflict), (body) => {
      body.append(aircraftButtons(conflict.aircraft_ids),
        metrics([['수평 · 평가 / 적용 기준', `${fmt(conflict.horizontal_separation_nm, 2)} / ${fmt(conflict.horizontal_threshold_nm, 1)} NM`],
          ['수직 · 평가 / 적용 기준', `${fmt(conflict.vertical_separation_ft)} / ${fmt(conflict.vertical_threshold_ft)} ft`],
          ['최근접까지', `${fmt(conflict.tcpa_seconds)}초`], ['위험도 / 점수', `${conflict.risk_level || '—'} / ${fmt(conflict.risk_score, 1)}`]]),
        paragraph(reasonText(conflict.risk_reason_codes) || '추가 위험 근거 없음'),
        paragraph(`평가 ${utc(conflict.evaluated_at_utc)} · 상태 ${conflict.status || '—'}`),
        paragraph(`최근접 ${utc(conflict.closest_approach_time_utc)} · 기준 ${conflict.rule_profile_id || '—'}`),
        paragraph('권고의 기준이 된 충돌 근거입니다. 적용 결과는 아래 적용 후 검증에서 확인하세요.', 'snt-decision-note'));
    });
    updateSection('recommendation', session?.recommendation, true, (body) => {
      if (!primary) { body.append(paragraph(session?.recommendation ? `주 권고 없음 · ${session.recommendation.availability || '결과 확인 필요'}` : '상신된 권고가 없습니다.')); return; }
      body.append(aircraftButtons([primary.target_aircraft_id]), paragraph(maneuverText(primary.maneuver), 'snt-decision-recommendation'),
        paragraph(primary.explanation || '설명 미제공'),
        metrics([['서버 안전 판정', primary.safety?.verdict || '미제공'], ['운영 비용 점수', fmt(primary.cost?.operational_cost_score, 1)],
          ['예상 지연', `${fmt(primary.cost?.estimated_delay_seconds)}초`], ['경로 증가', `${fmt(primary.cost?.estimated_path_extension_nm, 2)} NM`]]),
        paragraph(reasonText(primary.reason_codes) || '추가 권고 근거 없음'),
        paragraph(`권고 ${primary.recommendation_id} · 생성 ${utc(session.recommendation.generated_at_utc)}`));
    });
    const candidates = list(session?.candidate_comparisons);
    updateSection('candidates', candidates, candidates.length > 0, (body) => {
      const wrap = node('div', 'snt-decision-table-wrap'); wrap.tabIndex = 0;
      wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '후보 비교 표 · 가로 스크롤');
      const table = node('table', 'snt-decision-table');
      table.append(node('caption', '', '적용 전 후보별 독립 안전 검증'));
      const head = node('thead'), header = node('tr');
      for (const label of ['후보·기동', '종합 판정', '주요 쌍 분리', '근거·비용']) { const cell = node('th', '', label); cell.scope = 'col'; header.append(cell); }
      head.append(header); const rows = node('tbody');
      for (const candidate of candidates) {
        const row = node('tr'); row.dataset.verdict = candidate.verdict || 'UNKNOWN'; row.dataset.recommended = String(candidate.recommended === true);
        const identity = node('td'); identity.append(node('strong', '', `${candidate.recommended ? '선정 · ' : ''}${candidate.candidate_id}`), aircraftButtons([candidate.target_aircraft_id]), paragraph(maneuverText(candidate)));
        const verdict = node('td', '', candidate.verdict || '미제공');
        verdict.append(paragraph(`성능 ${boolLabel(candidate.performance_feasible, '충족', '불가')}`));
        const separation = node('td', '', `${fmt(candidate.primary_horizontal_separation_nm, 2)} NM / ${fmt(candidate.primary_vertical_separation_ft)} ft`);
        separation.append(paragraph(`주요 쌍: ${candidate.primary_conflict_status || '상태 미제공'}`));
        const evidence = node('td'); evidence.append(paragraph(`비용 ${fmt(candidate.operational_cost_score, 1)}`), paragraph(reasonText(candidate.reason_codes) || '추가 근거 없음'));
        if (list(candidate.rule_violation_ids).length) evidence.append(paragraph(`규칙 위반: ${candidate.rule_violation_ids.join(' · ')}`));
        for (const pair of list(candidate.secondary_conflict_aircraft_ids)) evidence.append(paragraph('2차 충돌'), aircraftButtons(pair));
        evidence.append(paragraph(`검증 ${candidate.validation_profile_id || '—'}`));
        row.append(identity, verdict, separation, evidence); rows.append(row);
      }
      table.append(head, rows); wrap.append(table); body.append(wrap);
    });
    const modified = session?.modified_revalidation;
    updateSection('modified', modified, Boolean(modified), (body) => {
      const box = node('div', 'snt-decision-validation'); box.dataset.verdict = modified.verdict || 'UNKNOWN';
      box.dataset.safe = String(applicableModification(modified));
      box.append(node('strong', '', `${modified.verdict || '미제공'} · ${applicableModification(modified) ? '서버 적용 허용' : '적용 불가'}`),
        metrics([['수평 분리', `${fmt(modified.primary_horizontal_separation_nm, 2)} NM`], ['수직 분리', `${fmt(modified.primary_vertical_separation_ft)} ft`],
          ['최근접까지', `${fmt(modified.tcpa_seconds)}초`], ['성능', boolLabel(modified.performance_feasible, '충족', '불가')]]),
        paragraph(`주요 쌍: ${modified.primary_conflict_status || '—'} · 평가 ${utc(modified.evaluated_at_utc)}`),
        paragraph(reasonText(modified.reason_codes) || '추가 근거 없음'));
      if (list(modified.rule_violation_ids).length) box.append(paragraph(`규칙 위반: ${modified.rule_violation_ids.join(' · ')}`));
      for (const pair of list(modified.secondary_conflict_aircraft_ids)) box.append(paragraph('2차 충돌'), aircraftButtons(pair));
      box.append(paragraph(`검증 ${modified.validation_profile_id || '—'} · 후보 ${modified.candidate_id || '—'}`),
        paragraph('재검증은 항공기에 기동을 적용하지 않습니다.', 'snt-decision-note')); body.append(box);
    });
    const applied = session?.revalidation;
    updateSection('applied', applied, Boolean(applied), (body) => {
      const box = node('div', 'snt-decision-validation'); box.dataset.safe = String(applied.resolved === true);
      box.append(node('strong', '', boolLabel(applied.resolved, '서버 확인: 기존 충돌 해소', '서버 확인: 충돌 미해소')),
        aircraftButtons([applied.applied_aircraft_id]), metrics([
          ['고도 · 적용 전 → 후', `${fmt(applied.before_altitude_ft)} → ${fmt(applied.applied_altitude_ft)} ft`],
          ['수평 / 수직 분리', `${fmt(applied.horizontal_separation_nm, 2)} NM / ${fmt(applied.vertical_separation_ft)} ft`],
          ['충돌 / 위험도', `${applied.conflict_status || '—'} / ${applied.risk_level || '—'}`],
          ['예외 상태', applied.source_exception_status || '—']]),
        paragraph(`적용 경로 ${applied.application_source || '—'} · 기동 ${applied.applied_maneuver_type || '—'}`),
        paragraph(`적용 ${applied.application_step_id || '—'} · 원 결정 ${applied.source_decision_step_id || '—'}`),
        paragraph(`예측 ${applied.prediction_run_id || '—'} · 충돌 평가 ${applied.conflict_run_id || '—'}`));
      if (applied.authorization_id) box.append(paragraph(`인가 ${applied.authorization_id} · ${utc(applied.authorized_at_utc)}`));
      body.append(box);
    });
    const audit = session?.controller_decision;
    updateSection('audit', audit, list(audit?.entries).length > 0, (body) => {
      body.append(paragraph(`기록 revision ${fmt(audit.revision)} · 갱신 ${utc(audit.generated_at_utc)}`));
      const log = node('ol', 'snt-decision-audit');
      for (const entry of [...audit.entries].reverse()) {
        const row = node('li', 'snt-decision-card');
        row.append(node('strong', '', `${entry.decision_type} · ${utc(entry.decided_at_utc)}`),
          paragraph(entry.rationale || '사유 미기재'), paragraph(`관제 위치 ${entry.controller_position_id || '—'} · 결정 ${entry.decision_id}`),
          paragraph(`권고 ${entry.recommendation_id || '—'} · 후보 ${entry.candidate_id || '—'}`),
          paragraph(`적용 승인 ${boolLabel(entry.authorizes_application, '있음', '없음')} · 재검증 ${boolLabel(entry.requires_revalidation, '필요', '불필요')}`));
        if (entry.modified_maneuver) row.append(paragraph(`수정 기동 ${maneuverText(entry.modified_maneuver)}`));
        log.append(row);
      }
      body.append(log);
    });
    const advisory = session?.step_id && snapshot.advisory?.step_id === session.step_id ? snapshot.advisory : null;
    updateSection('advisory', advisory, true, (body) => {
      if (!advisory) { body.append(paragraph('현재 단계의 운영 권고를 기다리고 있습니다.')); return; }
      body.append(paragraph('운영 권고 · 관제사 검토 전 항공기에 자동 적용되지 않습니다.', 'snt-decision-note'));
      if (list(advisory.approach_order).length) body.append(node('h4', 'snt-subtitle', '접근 추천 순서'), aircraftButtons(advisory.approach_order));
      if (list(advisory.runway_slots).length) {
        body.append(node('h4', 'snt-subtitle', '활주로 순서'));
        const slots = node('ol', 'snt-decision-queue');
        for (const slot of [...advisory.runway_slots].sort((a, b) => a.position - b.position)) {
          const row = node('li', 'snt-decision-card');
          row.dataset.severity = slot.aircraft_id === advisory.emergency_aircraft_id ? 'EMERGENCY' : '';
          row.append(aircraftButtons([slot.aircraft_id]), paragraph(`${slot.operation || '—'} · 문턱까지 ${fmt(slot.distance_to_threshold_nm, 1)} NM`),
            paragraph(`필요 간격 ${fmt(slot.required_gap_seconds)}초 · ${slot.binding || '—'}`), paragraph(list(slot.clauses).join(' · ')));
          slots.append(row);
        }
        body.append(slots);
      }
      for (const hold of list(advisory.holdings)) body.append(node('h4', 'snt-subtitle', '체공 권고'), aircraftButtons([hold.aircraft_id]),
        paragraph(hold.phraseology || '관제 문구 미제공'), paragraph(`${hold.fix || '—'} · ${fmt(hold.level_ft)} ft · ${fmt(hold.circuits)}회 · 지연 ${fmt(hold.delay_seconds)}초`));
      const route = advisory.recovery_route;
      if (route) body.append(node('h4', 'snt-subtitle', '복귀 경로'), aircraftButtons([route.aircraft_id]), paragraph(route.clearance || '관제 문구 미제공'),
        paragraph(list(route.fixes).join(' → ')), paragraph(`${fmt(route.total_nm, 1)} NM · 우회 ${fmt(route.detour_nm, 1)} NM`));
      if (list(advisory.control_units).length) {
        body.append(node('h4', 'snt-subtitle', '항공기별 관제 구역'));
        for (const unit of advisory.control_units) body.append(aircraftButtons([unit.aircraft_id]), paragraph(`${unit.unit || '—'}${unit.lateral ? ' · 측방' : ''} · ${fmt(unit.altitude_ft)} ft`));
      }
    });
    updateControls();
  }
  render();
  return {
    element, render, setStatus,
    setBusy(value) { externalBusy = Boolean(value); updateControls(); },
    destroy() {
      destroyed = true; form.removeEventListener('submit', stopSubmit);
      element.removeEventListener('click', selectAircraft);
      for (const [button, handler] of actionListeners) button.removeEventListener('click', handler);
      memoKeys.clear(); element.remove();
    },
  };
}
