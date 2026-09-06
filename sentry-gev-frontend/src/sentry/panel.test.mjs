import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { elapsedLabel, primaryRecommendation, panelAccess, stageLabel } from './panel.js';

test('Globe mounts controller decisions and leaves playback to the separate scenario page', () => {
  const source = fs.readFileSync(new URL('./panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /id="snt-(?:reset|advance|next)"/);
  assert.match(source, /createDecisionView/);
  assert.match(source, /access\.scenarioUrl/);
});

test('use the backend designated primary recommendation', () => {
  const primary = { recommendation_id: 'B' };
  assert.equal(primaryRecommendation({ recommendation: { primary_recommendation_id: 'B',
    recommendations: [{ recommendation_id: 'A' }, primary] } }), primary);
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
});

test('modified stage labels depend on safety evidence, not the checkpoint name alone', () => {
  const session = { stage: 'MODIFICATION_REVALIDATED' };
  assert.match(stageLabel(session), /확인 필요/);
  assert.match(stageLabel({ ...session, modified_revalidation: { safe_to_apply: false, verdict: 'UNSAFE' } }), /적용 불가/);
  assert.match(stageLabel({ ...session, modified_revalidation: { safe_to_apply: true, verdict: 'SAFE' } }), /적용 대기/);
});
