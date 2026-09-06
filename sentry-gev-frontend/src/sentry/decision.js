/** Pure command contracts for the Globe's controller workflow; /scenario owns playback. */
const MANEUVER_FIELDS = [
  'maneuver_type', 'target_heading_deg', 'target_altitude_ft',
  'target_ground_speed_kt', 'delay_seconds', 'target_sequence_position',
];
const COMMANDS = new Map([
  ['GENERATE_RECOMMENDATION', { label: '회피안 상신', tone: 'primary' }],
  ['ACCEPT_RECOMMENDATION', { label: '승인', tone: 'primary' }],
  ['MODIFY_RECOMMENDATION', { label: '수정안 제출', tone: 'secondary' }],
  ['REJECT_RECOMMENDATION', { label: '거부', tone: 'danger' }],
  ['REVALIDATE_MODIFIED_MANEUVER', { label: '수정안 재검증', tone: 'primary' }],
  ['APPLY_APPROVED_MANEUVER', { label: '승인 기동 적용', tone: 'primary' }],
  ['APPLY_VALIDATED_MODIFIED_MANEUVER', { label: '수정 기동 적용', tone: 'primary' }],
]);
const STAGE_COMMANDS = new Map([
  ['CONFLICT_DETECTED', ['GENERATE_RECOMMENDATION']],
  ['RECOMMENDATION_AVAILABLE', [
    'ACCEPT_RECOMMENDATION', 'MODIFY_RECOMMENDATION', 'REJECT_RECOMMENDATION',
  ]],
  ['DECISION_ACCEPTED', ['APPLY_APPROVED_MANEUVER']],
  ['DECISION_MODIFIED', ['REVALIDATE_MODIFIED_MANEUVER']],
  ['MODIFICATION_REVALIDATED', ['APPLY_VALIDATED_MODIFIED_MANEUVER']],
]);

/** Never substitute a different candidate when the backend's designated primary is missing. */
export function primaryRecommendation(session) {
  const set = session?.recommendation;
  if (typeof set?.primary_recommendation_id !== 'string' || !set.primary_recommendation_id
    || !Array.isArray(set.recommendations)) return null;
  return set.recommendations.find((item) => item?.recommendation_id === set.primary_recommendation_id) || null;
}

function timeKey(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : value;
}

/** Evidence identity for drafts and pending commands, independent of map selection/polling. */
export function decisionKey(session) {
  if (!session) return '';
  const set = session.recommendation;
  const primary = primaryRecommendation(session);
  const audit = session.controller_decision;
  const modified = session.modified_revalidation;
  const applied = session.revalidation;
  return JSON.stringify([
    session.session_id, session.scenario_id, session.run_number, session.stage,
    session.step_id, session.resolution_step_id, session.decision_step_id, session.application_step_id,
    timeKey(session.simulation_time_utc), session.elapsed_seconds,
    set?.recommendation_set_id, set?.primary_recommendation_id,
    primary?.recommendation_id, primary?.candidate_id, primary?.target_aircraft_id,
    MANEUVER_FIELDS.map((field) => primary?.maneuver?.[field]),
    audit?.audit_log_id, audit?.revision, audit?.latest_decision_id,
    modified?.revalidation_step_id, modified?.source_decision_step_id, modified?.validation_run_id,
    timeKey(modified?.evaluated_at_utc), modified?.safe_to_apply, modified?.verdict,
    applied?.application_step_id, applied?.source_decision_step_id, applied?.prediction_run_id,
  ]);
}

/** Stage availability is backend-owned; only explicitly SAFE modifications may be applied. */
export function decisionActions(session) {
  if (session?.stage === 'MODIFICATION_REVALIDATED'
    && (session.modified_revalidation?.safe_to_apply !== true
      || session.modified_revalidation?.verdict !== 'SAFE')) return [];
  return (STAGE_COMMANDS.get(session?.stage) || []).map((command) => ({
    command, ...COMMANDS.get(command),
  }));
}

function requiredRationale(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('수정·거부에는 사유가 필요합니다.');
  return value.trim();
}

function altitudeNumber(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
      throw new Error('변경 고도를 숫자로 입력해 주세요.');
    }
    value = Number(text);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('변경 고도는 0 이상의 유한한 숫자여야 합니다.');
  }
  return value;
}

/** Produce the exact Golden Demo command body, leaving safety validation to the backend. */
export function buildDecisionCommand(command, session, { altitude, rationale } = {}) {
  if (!COMMANDS.has(command)) throw new Error('Globe에서는 관제 판단 명령만 실행할 수 있습니다.');
  if (!decisionActions(session).some((action) => action.command === command)) {
    if (command === 'APPLY_VALIDATED_MODIFIED_MANEUVER'
      && session?.stage === 'MODIFICATION_REVALIDATED') {
      throw new Error('수정안이 안전 검증을 통과하지 않아 적용할 수 없습니다.');
    }
    throw new Error('현재 단계에서는 이 판단을 실행할 수 없습니다. 최신 상태를 확인해 주세요.');
  }
  const needsPrimary = ['ACCEPT_RECOMMENDATION', 'MODIFY_RECOMMENDATION', 'REJECT_RECOMMENDATION'].includes(command);
  const primary = primaryRecommendation(session);
  if (needsPrimary && !primary) throw new Error('현재 상신된 권고를 확인할 수 없습니다. 최신 상태를 확인해 주세요.');
  if (command === 'REJECT_RECOMMENDATION') return { command, rationale: requiredRationale(rationale) };
  if (command !== 'MODIFY_RECOMMENDATION') return { command };

  const reason = requiredRationale(rationale);
  const targetAltitude = altitudeNumber(altitude);
  const base = primary.maneuver;
  if (base?.maneuver_type !== 'ALTITUDE') throw new Error('고도 수정은 고도 변경 권고에만 사용할 수 있습니다.');
  if (!MANEUVER_FIELDS.every((field) => Object.hasOwn(base, field))
    || !Number.isFinite(base.target_altitude_ft) || base.target_altitude_ft < 0
    || MANEUVER_FIELDS.some((field) => !['maneuver_type', 'target_altitude_ft'].includes(field) && base[field] !== null)) {
    throw new Error('권고 기동의 필드가 올바르지 않습니다. 최신 상태를 확인해 주세요.');
  }
  if (targetAltitude === base.target_altitude_ft) throw new Error('권고와 다른 고도를 입력해 주세요.');
  const modified = Object.fromEntries(MANEUVER_FIELDS.map((field) => [field, base[field]]));
  modified.target_altitude_ft = targetAltitude;
  return { command, rationale: reason, modified_maneuver: modified };
}
