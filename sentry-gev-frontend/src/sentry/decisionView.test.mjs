import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionView } from './decisionView.js';
import { decisionKey } from './decision.js';

// A DOM seam for behavior tests; no WebGL, browser package, network, or server is needed.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.document = document; this.children = [];
    this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.parentElement = null; this._text = ''; this.value = ''; this.hidden = false;
    this.disabled = false; this.className = ''; this.id = ''; this.open = false;
  }
  set innerHTML(_) { throw new Error('Decision readouts must never parse server text as HTML'); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  append(...nodes) {
    for (const child of nodes) { child.remove(); child.parentElement = this; this.children.push(child); }
  }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this._text = ''; this.append(...nodes); }
  remove() {
    if (!this.parentElement) return;
    const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null;
    if (this.contains(this.document.activeElement)) this.document.activeElement = null;
  }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  matches(selector) {
    const data = selector.match(/^(\w+)?\[data-([\w-]+)\]$/);
    if (data) return (!data[1] || this.tagName === data[1].toUpperCase())
      && Object.hasOwn(this.dataset, data[2].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) { if (child.matches(selector)) matches.push(child); matches.push(...child.querySelectorAll(selector)); }
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  focus() { this.document.activeElement = this; }
  click() {
    if (this.disabled) return;
    const event = { target: this, preventDefault() {} };
    for (let current = this; current; current = current.parentElement) {
      for (const listener of current.listeners.get('click') || []) listener(event);
    }
  }
}
function mount(t, options = {}) {
  const previous = globalThis.document;
  const document = { activeElement: null, createElement: (tag) => new Element(tag, document) };
  document.body = document.createElement('body'); globalThis.document = document;
  const view = createDecisionView(options); document.body.append(view.element);
  t.after(() => { view.destroy(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  return { view, document, get: (id) => view.element.querySelector(`#snt-decision-${id}`) };
}
function fixture() {
  return {
    session_id: 'DEMO-RUN-1', scenario_id: 'DEMO', run_number: 1,
    stage: 'RECOMMENDATION_AVAILABLE', step_id: 'STEP-75', resolution_step_id: 'RESOLVE-75',
    simulation_time_utc: '2026-09-07T00:01:15Z', elapsed_seconds: 75,
    recommendation: { recommendation_set_id: 'SET-75', primary_recommendation_id: 'REC-A', recommendations: [
      { recommendation_id: 'REC-A', candidate_id: 'CAND-A', target_aircraft_id: 'SIM-01', explanation: '후보 근거',
        maneuver: { maneuver_type: 'ALTITUDE', target_heading_deg: null, target_altitude_ft: 9000,
          target_ground_speed_kt: null, delay_seconds: null, target_sequence_position: null } },
    ] },
    exception_queue: { items: [{ exception_id: 'EX-01', kind: 'CONFLICT_RISK', subject_aircraft_ids: ['SIM-01'], severity: 'HIGH', score: 50 }] },
    candidate_comparisons: [{ candidate_id: 'CAND-A', verdict: 'SAFE', target_aircraft_id: 'SIM-01' }],
  };
}
const connected = (session = fixture()) => ({ session, access: { canControl: true }, stale: false, busy: false });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('polling preserves the active draft, focus and open evidence; a new run resets the draft', (t) => {
  const { view, get, document } = mount(t);
  const state = connected(); view.render(state);
  const altitude = get('altitude'), rationale = get('rationale');
  altitude.value = '8500'; rationale.value = '운용 여건 검토'; rationale.focus(); get('candidates').open = true;
  const refreshed = structuredClone(state); refreshed.selectedId = 'SIM-01';
  refreshed.session.traffic = [{ aircraft_id: 'SIM-01', x_nm: 4 }];
  view.render(refreshed);
  assert.equal(get('altitude'), altitude); assert.equal(altitude.value, '8500');
  assert.equal(rationale.value, '운용 여건 검토'); assert.equal(document.activeElement, rationale);
  assert.equal(get('candidates').open, true);
  refreshed.session.session_id = 'DEMO-RUN-2'; refreshed.session.run_number = 2;
  view.render(refreshed);
  assert.equal(altitude.value, '9000'); assert.equal(rationale.value, '');
});

test('modified command sends the displayed decision key once and never chains a second command', async (t) => {
  const calls = []; let finish;
  const { view, get } = mount(t, { onCommand: (payload, key) => {
    calls.push({ payload, key }); return new Promise((resolve) => { finish = resolve; });
  } });
  const state = connected(); view.render(state);
  get('altitude').value = '8500'; get('rationale').value = '  수직 분리 확보  ';
  get('modify').click(); get('modify').click(); get('accept').click();
  assert.equal(calls.length, 1); assert.equal(get('modify').disabled, true);
  assert.equal(calls[0].key, decisionKey(state.session));
  assert.deepEqual(calls[0].payload, { command: 'MODIFY_RECOMMENDATION', rationale: '수직 분리 확보',
    modified_maneuver: { ...state.session.recommendation.recommendations[0].maneuver, target_altitude_ft: 8500 } });
  finish(); await settle();
  assert.equal(calls.length, 1, 'completion is not permission to revalidate or apply');
  assert.equal(get('modify').disabled, false);
});

test('read-only, stale and busy states block commands but retain aircraft selection', (t) => {
  const calls = [], selections = [];
  const { view, get } = mount(t, { onCommand: (payload) => calls.push(payload), onSelect: (id) => selections.push(id) });
  for (const denied of [
    { access: { canControl: false } }, { access: {} }, { access: null }, { stale: true }, { busy: true },
  ]) {
    view.render({ ...connected(), ...denied }); get('accept').click(); assert.equal(get('accept').disabled, true);
  }
  assert.equal(calls.length, 0);
  get('queue').querySelector('button[data-aircraft-id]').click(); assert.deepEqual(selections, ['SIM-01']);
  view.render({ ...connected(), error: '선택적 지도 기준정보 연결 실패' });
  assert.equal(get('accept').disabled, false, 'optional reference errors do not invalidate a current session');
  view.setBusy(true); get('accept').click(); assert.equal(calls.length, 0); view.setBusy(false);
  assert.equal(get('accept').disabled, false);
});

test('modified application requires explicit SAFE evidence, not a completed stage alone', (t) => {
  const calls = [];
  const { view, get } = mount(t, { onCommand: (payload) => calls.push(payload) });
  const session = fixture(); session.stage = 'MODIFICATION_REVALIDATED';
  for (const evidence of [null, {}, { verdict: 'SAFE' }, { safe_to_apply: false, verdict: 'UNSAFE' },
    { safe_to_apply: true, verdict: 'UNSAFE' }, { safe_to_apply: true }, { safe_to_apply: 'true', verdict: 'SAFE' }]) {
    session.modified_revalidation = evidence; view.render(connected(session));
    get('apply-mod').click(); assert.equal(get('apply-mod').disabled, true);
    if (evidence) assert.match(get('modified').textContent, /적용 불가/);
  }
  assert.equal(calls.length, 0);
  session.modified_revalidation = { safe_to_apply: true, verdict: 'SAFE' }; view.render(connected(session));
  assert.equal(get('apply-mod').disabled, false);
});

test('invalid input and transport failures are shown without replay or erasing the same-decision draft', async (t) => {
  let sent = 0;
  const { view, get } = mount(t, { onCommand: async () => { sent += 1; throw new Error('서버 상태가 변경되었습니다.'); } });
  const state = connected(); view.render(state); get('modify').click();
  assert.equal(sent, 0); assert.match(get('status').textContent, /사유/);
  get('rationale').value = '진입 순서 재검토'; get('reject').click(); await settle();
  assert.equal(sent, 1); assert.equal(get('status').textContent, '서버 상태가 변경되었습니다.');
  view.render(structuredClone(state)); await settle();
  assert.equal(sent, 1); assert.equal(get('status').textContent, '서버 상태가 변경되었습니다.');
  assert.equal(get('rationale').value, '진입 순서 재검토');
});

test('Globe decisions contain no clock controls and render server text without HTML interpretation', (t) => {
  const { view, get } = mount(t); const session = fixture();
  const untrusted = '<img src=x onerror=alert(1)>';
  session.recommendation.recommendations[0].explanation = untrusted;
  session.exception_queue.items.unshift({ exception_id: 'PRIORITY', kind: 'OPERATIONAL_PRIORITY', subject_aircraft_ids: ['SIM-02'], severity: 'EMERGENCY', score: 1 });
  view.render(connected(session));
  assert.ok(get('recommendation').textContent.includes(untrusted));
  assert.equal(view.element.querySelectorAll('img').length, 0);
  assert.equal(get('queue').querySelector('button[data-aircraft-id]').textContent, 'SIM-02');
  const commands = view.element.querySelectorAll('[data-decision-command]').map((button) => button.dataset.decisionCommand);
  assert.ok(commands.includes('ACCEPT_RECOMMENDATION'));
  assert.ok(commands.every((command) => !['START', 'ADVANCE', 'ADVANCE_TO_CONFLICT', 'RESET'].includes(command)));
});

test('operational advice must match the session step, and applied results reflect explicit server evidence', (t) => {
  const { view, get } = mount(t); const session = fixture();
  session.revalidation = { resolved: false, applied_aircraft_id: 'SIM-01', before_altitude_ft: 9000, applied_altitude_ft: 8500 };
  const advisory = { step_id: 'OLD', recovery_route: { aircraft_id: 'SIM-01', clearance: '서버 복귀 경로' } };
  view.render({ ...connected(session), advisory });
  assert.doesNotMatch(get('advisory').textContent, /서버 복귀 경로/);
  assert.match(get('applied').textContent, /충돌 미해소/);
  advisory.step_id = session.step_id; view.render({ advisory });
  assert.match(get('advisory').textContent, /서버 복귀 경로/);
});

test('destroy during an awaited command detaches the view and does not replay the command', async (t) => {
  let finish, calls = 0;
  const { view, get, document } = mount(t, { onCommand: () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); } });
  view.render(connected()); get('accept').click(); view.destroy(); finish(); await settle();
  assert.equal(calls, 1); assert.equal(document.body.children.length, 0);
  view.render(connected()); view.setBusy(false); assert.equal(document.body.children.length, 0);
});

test('operational priority labels and the server queue order remain distinct from conflict risk scores', (t) => {
  const { view, get } = mount(t); const session = fixture();
  session.exception_queue.items = [
    { exception_id: 'E1', kind: 'OPERATIONAL_PRIORITY', severity: 'EMERGENCY', score: 1, subject_aircraft_ids: ['EMERGENCY-01'] },
    { exception_id: 'E2', kind: 'CONFLICT_RISK', severity: 'HIGH', tcpa_seconds: 10, score: 20, subject_aircraft_ids: ['RISK-NEAR'] },
    { exception_id: 'E3', kind: 'CONFLICT_RISK', severity: 'HIGH', tcpa_seconds: 40, score: 99, subject_aircraft_ids: ['RISK-LATER'] },
    { exception_id: 'E4', kind: 'OPERATIONAL_PRIORITY', severity: 'ATTENTION', score: 10, subject_aircraft_ids: ['PRIORITY-01'] },
    { exception_id: 'E5', kind: 'CONFLICT_RISK', severity: 'MEDIUM', score: 80, subject_aircraft_ids: ['RISK-02'] },
  ];
  view.render(connected(session));
  const rows = get('queue').querySelectorAll('li');
  assert.deepEqual(rows.map((row) => row.querySelector('button').textContent),
    ['EMERGENCY-01', 'RISK-NEAR', 'RISK-LATER', 'PRIORITY-01', 'RISK-02']);
  assert.equal(rows[3].querySelector('.snt-badge').textContent, '주의');
  assert.match(rows[3].textContent, /운영 우선순위/);
  assert.match(rows[4].textContent, /분리 위험/);
});

test('a safe primary pair is labeled separately from an unsafe overall candidate', (t) => {
  const { view, get } = mount(t); const session = fixture();
  session.candidate_comparisons = [{ candidate_id: 'CAND-B', verdict: 'UNSAFE', primary_conflict_status: 'SAFE',
    primary_horizontal_separation_nm: 4, primary_vertical_separation_ft: 1200,
    secondary_conflict_aircraft_ids: [['SIM-01', 'SIM-03']] }];
  view.render(connected(session));
  const row = get('candidates').querySelector('tbody').children[0];
  assert.match(row.children[1].textContent, /^UNSAFE/);
  assert.match(row.children[2].textContent, /주요 쌍: SAFE/);
  assert.match(row.children[3].textContent, /2차 충돌/);
  assert.ok(get('candidates').querySelectorAll('th').some((cell) => cell.textContent === '종합 판정'));
});

test('an asynchronous map selection failure is handled visibly without a decision command or retry', async (t) => {
  const selected = []; let commands = 0;
  const { view, get } = mount(t, {
    onSelect: async (id) => { selected.push(id); await Promise.resolve(); throw new Error('지도 레이어를 켜지 못했습니다.'); },
    onCommand: () => { commands += 1; },
  });
  const state = connected(); view.render(state);
  get('queue').querySelector('button[data-aircraft-id]').click(); await settle();
  assert.deepEqual(selected, ['SIM-01']); assert.equal(commands, 0);
  assert.equal(get('status').textContent, '지도 레이어를 켜지 못했습니다.');
  assert.equal(get('status').dataset.kind, 'error');
  view.render(structuredClone(state)); await settle();
  assert.deepEqual(selected, ['SIM-01']); assert.equal(commands, 0);
  assert.equal(get('status').textContent, '지도 레이어를 켜지 못했습니다.');
});
