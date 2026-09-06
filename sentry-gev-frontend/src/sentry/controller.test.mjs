import test from 'node:test';
import assert from 'node:assert/strict';
import { createSentryController } from './controller.js';
import { decisionKey } from './decision.js';

const state = () => ({ session_id: 'TEST-RUN-1', scenario_id: 'TEST', run_number: 1,
  stage: 'CONFLICT_DETECTED', step_id: 'STEP-1', elapsed_seconds: 70,
  simulation_time_utc: '2026-09-01T00:01:10Z', traffic: [] });
function clientFixture() {
  const client = { session: state(), operator: true, writes: [], reads: [], fail: false,
    async get(path) {
      client.reads.push(path);
      if (client.fail) throw new Error('offline');
      if (path === '/golden-demo/session') return structuredClone(client.session);
      if (path === '/reference/access') return { operator: client.operator };
      if (path === '/reference/scenario') return { scenario_id: client.session.scenario_id };
      if (path === '/reference/geometry') return { rings: [], fixes: [] };
      if (path === '/advisory') return { step_id: client.session.step_id };
      return null;
    },
    async command(body) {
      client.writes.push(body);
      client.session = { ...client.session, stage: 'RECOMMENDATION_AVAILABLE', step_id: 'STEP-2' };
      return structuredClone(client.session);
    },
  };
  return client;
}

test('session polling works without a Cesium viewer or enabled map layer and never posts', async () => {
  const client = clientFixture();
  const controller = createSentryController({ client });
  await controller.refresh();
  assert.equal(controller.getSnapshot().session.stage, 'CONFLICT_DETECTED');
  assert.equal(controller.getSnapshot().access.canControl, true);
  client.session = { ...client.session, session_id: 'TEST-RUN-2', elapsed_seconds: 0, stage: 'READY' };
  await controller.refresh();
  assert.equal(controller.getSnapshot().session.session_id, 'TEST-RUN-2');
  assert.deepEqual(client.writes, []);
  controller.destroy();
});

test('reset in the scenario window invalidates a pending Globe decision before POST', async () => {
  const client = clientFixture(), controller = createSentryController({ client });
  await controller.refresh();
  const key = decisionKey(controller.getSnapshot().session);
  client.session = { ...client.session, session_id: 'TEST-RUN-2', stage: 'READY' };
  await assert.rejects(controller.command({ command: 'GENERATE_RECOMMENDATION' }, key), /변경/);
  assert.deepEqual(client.writes, []);
  assert.equal(controller.getSnapshot().busy, false);
  controller.destroy();
});

test('access loss and offline state each prevent decisions', async () => {
  for (const mode of ['viewer', 'offline']) {
    const client = clientFixture(), controller = createSentryController({ client });
    await controller.refresh();
    const key = decisionKey(controller.getSnapshot().session);
    if (mode === 'viewer') client.operator = false; else client.fail = true;
    await assert.rejects(controller.command({ command: 'GENERATE_RECOMMENDATION' }, key), /권한/);
    assert.deepEqual(client.writes, []);
    assert.equal(controller.getSnapshot().access.canControl, false);
    controller.destroy();
  }
});

test('Globe cannot send playback commands even with current evidence and operator access', async () => {
  const client = clientFixture(), controller = createSentryController({ client });
  await controller.refresh();
  for (const command of ['START', 'ADVANCE', 'RESET', 'ADVANCE_TO_CONFLICT']) {
    await assert.rejects(controller.command({ command }, decisionKey(controller.getSnapshot().session)), /관제 판단/);
  }
  assert.deepEqual(client.writes, []);
  controller.destroy();
});

test('one pending decision prevents a second click and old reads cannot overwrite its response', async () => {
  const client = clientFixture(), controller = createSentryController({ client });
  await controller.refresh();
  let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  client.command = async body => {
    client.writes.push(body); started();
    await new Promise(resolve => { finish = resolve; });
    client.session = { ...client.session, stage: 'RECOMMENDATION_AVAILABLE' };
    return structuredClone(client.session);
  };
  const key = decisionKey(controller.getSnapshot().session);
  const request = controller.command({ command: 'GENERATE_RECOMMENDATION' }, key);
  await began;
  await assert.rejects(controller.command({ command: 'GENERATE_RECOMMENDATION' }, key), /이전 판단/);
  finish(); await request;
  assert.equal(client.writes.length, 1);
  assert.equal(controller.getSnapshot().session.stage, 'RECOMMENDATION_AVAILABLE');
  assert.equal(controller.getSnapshot().busy, false);
  controller.destroy();
});

test('a timed-out decision is reconciled from the server without repeating the POST', async () => {
  const client = clientFixture(), controller = createSentryController({ client });
  await controller.refresh();
  client.command = async body => {
    client.writes.push(body);
    client.session = { ...client.session, stage: 'RECOMMENDATION_AVAILABLE' };
    throw new Error('response timed out');
  };
  await assert.rejects(controller.command({ command: 'GENERATE_RECOMMENDATION' }, decisionKey(controller.getSnapshot().session)), /timed out/);
  assert.equal(client.writes.length, 1);
  assert.equal(controller.getSnapshot().session.stage, 'RECOMMENDATION_AVAILABLE');
  assert.equal(controller.getSnapshot().stale, false);
  controller.destroy();
});

test('stopping the controller prevents a delayed response from publishing', async () => {
  const client = clientFixture();
  const get = client.get;
  let finish;
  client.get = path => path === '/golden-demo/session'
    ? new Promise(resolve => { finish = resolve; }) : get(path);
  const controller = createSentryController({ client });
  let emitted = 0; controller.subscribe(() => emitted++);
  const pending = controller.refresh();
  controller.destroy(); finish(client.session); await pending;
  assert.equal(emitted, 0);
  assert.equal(controller.getSnapshot().session, null);
});
