import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionCommand, decisionActions, decisionKey, primaryRecommendation } from './decision.js';

function fixture(stage = 'RECOMMENDATION_AVAILABLE') {
  return {
    session_id: 'DEMO-RUN-000001', scenario_id: 'DEMO', run_number: 1,
    stage, step_id: 'STEP-75', resolution_step_id: 'RESOLVE-75',
    simulation_time_utc: '2026-09-05T00:01:15Z', elapsed_seconds: 75,
    recommendation: {
      recommendation_set_id: 'SET-75', primary_recommendation_id: 'REC-B',
      recommendations: [
        { recommendation_id: 'REC-A', candidate_id: 'CANDIDATE-A' },
        { recommendation_id: 'REC-B', candidate_id: 'CANDIDATE-B', target_aircraft_id: 'SIM-01',
          maneuver: {
            maneuver_type: 'ALTITUDE', target_heading_deg: null, target_altitude_ft: 9000,
            target_ground_speed_kt: null, delay_seconds: null, target_sequence_position: null,
          } },
      ],
    },
  };
}

function commands(session) {
  return decisionActions(session).map((action) => action.command);
}

test('the designated primary is used even when another candidate comes first', () => {
  const session = fixture();
  assert.equal(primaryRecommendation(session), session.recommendation.recommendations[1]);
  session.recommendation.primary_recommendation_id = 'missing';
  assert.equal(primaryRecommendation(session), null);
  session.recommendation.primary_recommendation_id = null;
  assert.equal(primaryRecommendation(session), null);
  assert.equal(primaryRecommendation({ recommendation: { recommendations: {} } }), null);
  assert.equal(primaryRecommendation(null), null);
});

test('decision stages expose only their own checkpoint actions, including interrupted workflows', () => {
  const expected = [
    ['CONFLICT_DETECTED', ['GENERATE_RECOMMENDATION']],
    ['RECOMMENDATION_AVAILABLE', ['ACCEPT_RECOMMENDATION', 'MODIFY_RECOMMENDATION', 'REJECT_RECOMMENDATION']],
    ['DECISION_ACCEPTED', ['APPLY_APPROVED_MANEUVER']],
    ['DECISION_MODIFIED', ['REVALIDATE_MODIFIED_MANEUVER']],
  ];
  for (const [stage, actionNames] of expected) assert.deepEqual(commands({ stage }), actionNames);
  for (const stage of ['READY', 'MONITORING', 'DEVIATION_DETECTED', 'DECISION_REJECTED', 'CONFLICT_RESOLVED', 'BLOCKED_MODIFICATION', '__proto__']) {
    assert.deepEqual(commands({ stage }), []);
  }
  assert.deepEqual(commands(null), []);
  const actions = decisionActions(fixture());
  actions[0].label = 'changed in a consumer';
  assert.equal(decisionActions(fixture())[0].label, '승인');
});

test('a modified maneuver requires explicit safe evidence; truthy and absent values cannot authorize', () => {
  for (const safe of [undefined, null, false, 0, 1, 'true']) {
    const session = { stage: 'MODIFICATION_REVALIDATED', modified_revalidation: { safe_to_apply: safe } };
    assert.deepEqual(commands(session), []);
    assert.throws(() => buildDecisionCommand('APPLY_VALIDATED_MODIFIED_MANEUVER', session), /안전 검증/);
  }
  for (const verdict of [undefined, null, 'UNSAFE', 'SAFE ']) {
    const inconsistent = { stage: 'MODIFICATION_REVALIDATED', modified_revalidation: { safe_to_apply: true, verdict } };
    assert.deepEqual(commands(inconsistent), []);
    assert.throws(() => buildDecisionCommand('APPLY_VALIDATED_MODIFIED_MANEUVER', inconsistent), /안전 검증/);
  }
  const safe = { stage: 'MODIFICATION_REVALIDATED', modified_revalidation: { safe_to_apply: true, verdict: 'SAFE' } };
  assert.deepEqual(commands(safe), ['APPLY_VALIDATED_MODIFIED_MANEUVER']);
  assert.deepEqual(buildDecisionCommand('APPLY_VALIDATED_MODIFIED_MANEUVER', safe), { command: 'APPLY_VALIDATED_MODIFIED_MANEUVER' });
});

test('clock commands and decisions from an obsolete stage cannot be built', () => {
  for (const command of ['START', 'ADVANCE', 'ADVANCE_TO_CONFLICT', 'RESET', 'SUBMIT', 'unknown']) {
    assert.throws(() => buildDecisionCommand(command, fixture()), /관제 판단 명령/);
  }
  assert.throws(() => buildDecisionCommand('ACCEPT_RECOMMENDATION', fixture('DECISION_ACCEPTED')), /현재 단계/);
  assert.throws(() => buildDecisionCommand('GENERATE_RECOMMENDATION', null), /현재 단계/);
  const missing = fixture();
  missing.recommendation.primary_recommendation_id = 'missing';
  for (const command of ['ACCEPT_RECOMMENDATION', 'MODIFY_RECOMMENDATION', 'REJECT_RECOMMENDATION']) {
    assert.throws(() => buildDecisionCommand(command, missing, { altitude: 8500, rationale: '사유' }), /상신된 권고/);
  }
});

test('approval and post-failure recovery remain separate commands with no stray form fields', () => {
  for (const [command, stage] of [
    ['GENERATE_RECOMMENDATION', 'CONFLICT_DETECTED'],
    ['ACCEPT_RECOMMENDATION', 'RECOMMENDATION_AVAILABLE'],
    ['APPLY_APPROVED_MANEUVER', 'DECISION_ACCEPTED'],
    ['REVALIDATE_MODIFIED_MANEUVER', 'DECISION_MODIFIED'],
  ]) {
    assert.deepEqual(buildDecisionCommand(command, fixture(stage), { altitude: 1, rationale: 'old draft' }), { command });
  }
});

test('modification preserves exactly the backend six-field maneuver and never changes the recommendation', () => {
  const session = fixture();
  const base = primaryRecommendation(session).maneuver;
  base.display_only = 'must not reach the API';
  Object.freeze(base);
  const before = JSON.stringify(session);
  assert.deepEqual(buildDecisionCommand('MODIFY_RECOMMENDATION', session, { altitude: ' 8500.5 ', rationale: '  다른 분리 고도 확인  ' }), {
    command: 'MODIFY_RECOMMENDATION', rationale: '다른 분리 고도 확인',
    modified_maneuver: {
      maneuver_type: 'ALTITUDE', target_heading_deg: null, target_altitude_ft: 8500.5,
      target_ground_speed_kt: null, delay_seconds: null, target_sequence_position: null,
    },
  });
  assert.equal(JSON.stringify(session), before);
  const zero = buildDecisionCommand('MODIFY_RECOMMENDATION', session, { altitude: 0, rationale: '서버 재검증 확인' });
  assert.equal(zero.modified_maneuver.target_altitude_ft, 0, 'numeric validity never claims operational safety');
  assert.equal(zero.command, 'MODIFY_RECOMMENDATION');
});

test('empty and malformed numeric inputs cannot silently become zero or truncated altitude', () => {
  for (const altitude of ['', '  ', null, undefined, true, false, [], {}, '8500 ft', '8,500', '0x2000', '9000oops', 'Infinity', Infinity, NaN, -1, '-1']) {
    assert.throws(() => buildDecisionCommand('MODIFY_RECOMMENDATION', fixture(), { altitude, rationale: '사유' }), /고도/);
  }
  assert.throws(() => buildDecisionCommand('MODIFY_RECOMMENDATION', fixture(), { altitude: '9000', rationale: '사유' }), /다른 고도/);
  assert.equal(buildDecisionCommand('MODIFY_RECOMMENDATION', fixture(), { altitude: '8.5e3', rationale: '사유' }).modified_maneuver.target_altitude_ft, 8500);
});

test('modify and reject require a real rationale; reject contains no maneuver', () => {
  for (const command of ['MODIFY_RECOMMENDATION', 'REJECT_RECOMMENDATION']) {
    for (const rationale of [undefined, null, '', '  ', 123, {}]) {
      assert.throws(() => buildDecisionCommand(command, fixture(), { altitude: 8500, rationale }), /사유/);
    }
  }
  assert.deepEqual(buildDecisionCommand('REJECT_RECOMMENDATION', fixture(), { rationale: '  운용상 부적합  ', altitude: 8500 }), {
    command: 'REJECT_RECOMMENDATION', rationale: '운용상 부적합',
  });
});

test('altitude editing refuses incompatible or malformed server maneuvers rather than inventing fields', () => {
  for (const mutate of [
    (base) => { base.maneuver_type = 'HEADING'; base.target_heading_deg = 90; base.target_altitude_ft = null; },
    (base) => { delete base.delay_seconds; },
    (base) => { base.target_ground_speed_kt = 250; },
    (base) => { base.target_altitude_ft = '9000'; },
    (base) => { base.target_altitude_ft = NaN; },
  ]) {
    const session = fixture();
    mutate(primaryRecommendation(session).maneuver);
    assert.throws(() => buildDecisionCommand('MODIFY_RECOMMENDATION', session, { altitude: 8500, rationale: '사유' }), /권고|기동/);
  }
});

test('decision keys survive ordinary polling and equivalent UTC formatting, not run or evidence changes', () => {
  const session = fixture();
  const key = decisionKey(session);
  const poll = structuredClone(session);
  poll.traffic = [{ aircraft_id: 'SIM-01', x_nm: 1 }];
  poll.simulation_time_utc = '2026-09-05T00:01:15.000000+00:00';
  assert.equal(decisionKey(poll), key, 'polling and map-only data must not erase a draft');
  for (const mutate of [
    (next) => { next.session_id = 'DEMO-RUN-000002'; },
    (next) => { next.stage = 'DECISION_ACCEPTED'; },
    (next) => { next.step_id = 'STEP-76'; },
    (next) => { next.elapsed_seconds = 76; },
    (next) => { next.recommendation.recommendation_set_id = 'SET-NEW'; },
    (next) => { next.recommendation.primary_recommendation_id = 'REC-A'; },
    (next) => { next.decision_step_id = 'DECISION-NEW'; },
    (next) => { next.controller_decision = { latest_decision_id: 'AUDIT-NEW', revision: 2 }; },
    (next) => { next.modified_revalidation = { revalidation_step_id: 'CHECK-NEW', safe_to_apply: false }; },
    (next) => { next.application_step_id = 'APPLY-NEW'; },
  ]) {
    const next = structuredClone(session);
    mutate(next);
    assert.notEqual(decisionKey(next), key);
  }
  const checked = { ...session, stage: 'MODIFICATION_REVALIDATED', modified_revalidation: { revalidation_step_id: 'CHECK-1', safe_to_apply: true } };
  const revoked = structuredClone(checked);
  revoked.modified_revalidation.safe_to_apply = false;
  assert.notEqual(decisionKey(checked), decisionKey(revoked));
  assert.equal(decisionKey(null), '');
});
