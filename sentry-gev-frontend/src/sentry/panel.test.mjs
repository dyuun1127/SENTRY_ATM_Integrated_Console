import test from 'node:test';
import assert from 'node:assert/strict';
import { commandState, elapsedLabel, primaryRecommendation, panelAccess } from './panel.js';

test('an unconnected panel cannot issue a time command', () => {
  assert.equal(commandState(null, null).start, null);
  assert.equal(commandState(null, null).advance, null);
  assert.equal(commandState(null, null).next, null);
});
test('explicit READY start and timed advancement match V2 command API', () => {
  assert.deepEqual(commandState({ stage: 'READY', elapsed_seconds: 0 }, {}).start, { command: 'START' });
  assert.deepEqual(commandState({ stage: 'MONITORING', elapsed_seconds: 30 }, {}).advance, { command: 'ADVANCE', seconds: 30 });
});
test('next event advances by the positive difference and rounds fractional seconds upward', () => {
  const scenario = { steps: [{ t_s: 100, name: '이전' }, { t_s: 189.2, name: '다음' }, { t_s: 250, name: '나중' }] };
  assert.deepEqual(commandState({ stage: 'MONITORING', elapsed_seconds: 150 }, scenario).next, { command: 'ADVANCE', seconds: 40 });
});
test('controller review stages do not expose time advancement', () => {
  for (const stage of ['CONFLICT_DETECTED', 'RECOMMENDATION_AVAILABLE', 'DECISION_ACCEPTED', 'DECISION_MODIFIED', 'MODIFICATION_REVALIDATED', 'BLOCKED_MODIFICATION']) {
    const controls = commandState({ stage, elapsed_seconds: 100 }, { steps: [{ t_s: 120 }] });
    assert.equal(controls.advance, null); assert.equal(controls.next, null); assert.equal(controls.waiting, true);
  }
});
test('advance respects the scenario end and no future event is invented', () => {
  const scenario = { duration_seconds: 100, steps: [{ t_s: 0 }] };
  assert.deepEqual(commandState({ stage: 'MONITORING', elapsed_seconds: 90 }, scenario).advance, { command: 'ADVANCE', seconds: 10 });
  assert.equal(commandState({ stage: 'MONITORING', elapsed_seconds: 100 }, scenario).advance, null);
  assert.equal(commandState({ stage: 'MONITORING', elapsed_seconds: 90 }, scenario).next, null);
});
test('use backend primary recommendation instead of assuming the first candidate', () => {
  const primary = { recommendation_id: 'B' };
  assert.equal(primaryRecommendation({ recommendation: { primary_recommendation_id: 'B', recommendations: [{ recommendation_id: 'A' }, primary] } }), primary);
  assert.equal(primaryRecommendation(null), null);
});
test('elapsed display is the simulation clock, never the workstation clock', () => {
  assert.equal(elapsedLabel(3661), '01:01:01'); assert.equal(elapsedLabel(undefined), '--:--:--');
});


test('public gateway links never send an external visitor to their localhost', () => {
  assert.deepEqual(panelAccess({ viewer: false }), {
    consoleUrl: '/console/', scenarioUrl: '/scenario', viewer: false,
  });
  assert.equal(panelAccess({ viewer: true }).viewer, true);
  assert.equal(panelAccess(null).consoleUrl, 'http://127.0.0.1:8782/');
  assert.equal(panelAccess(null).viewer, false);
});
