import { createSentryClient } from './client.js';
import { buildDecisionCommand, decisionKey } from './decision.js';

/** One read/decision source for the console, independent of map-layer visibility. */
export function createSentryController({ client = createSentryClient(), intervalMs = 1000,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  let snapshot = { session: null, prediction: null, advisory: null, scenario: null, geometry: null,
    access: { canControl: false }, stale: true, error: null, busy: false };
  let pending = null, timer = null, stopped = true, destroyed = false;
  const abort = new AbortController();
  const listeners = new Set();
  const emit = () => { if (!destroyed) for (const listener of listeners) listener(snapshot); };
  const set = values => { snapshot = { ...snapshot, ...values }; emit(); };

  function refresh() {
    if (destroyed) return Promise.resolve(snapshot);
    if (pending) return pending;
    pending = (async () => {
      try {
        const [session, prediction, advisory, access] = await Promise.all([
          client.get('/golden-demo/session', abort.signal),
          client.get('/prediction', abort.signal).catch(() => null),
          client.get('/advisory', abort.signal).catch(() => null),
          client.get('/reference/access', abort.signal).catch(() => null),
        ]);
        if (destroyed) return snapshot;
        if (!session?.session_id || !session?.stage) throw new Error('시뮬레이션 응답을 확인할 수 없습니다.');
        let { scenario, geometry } = snapshot;
        if (scenario?.scenario_id !== session.scenario_id || !geometry) {
          scenario = null; geometry = null;
          const reference = await Promise.all([
            client.get('/reference/scenario', abort.signal),
            client.get('/reference/geometry', abort.signal),
          ]).catch(() => null);
          if (destroyed) return snapshot;
          if (reference?.[0]?.scenario_id === session.scenario_id) [scenario, geometry] = reference;
        }
        set({ session, prediction,
          advisory: advisory?.step_id === session.step_id ? advisory : null,
          scenario, geometry, access: { canControl: access?.operator === true },
          stale: false, error: !access ? '조작 권한을 확인하지 못했습니다. 조회를 다시 시도합니다.'
            : !scenario || !geometry ? '항적 연결됨 · 공역과 단계 정보를 다시 불러오는 중입니다.' : null });
      } catch (error) {
        if (!destroyed) set({ stale: true, access: { canControl: false },
          error: error?.message || 'SENTRY 서버 연결을 확인해 주세요.' });
      }
      return snapshot;
    })().finally(() => { pending = null; });
    return pending;
  }

  async function command(payload, expectedKey) {
    if (destroyed) throw new Error('관제 콘솔이 종료되었습니다.');
    if (snapshot.busy) throw new Error('이전 판단 요청을 처리하고 있습니다.');
    if (!expectedKey || expectedKey !== decisionKey(snapshot.session)) {
      throw new Error('판단 대상이 변경되었습니다. 최신 권고를 확인해 주세요.');
    }
    set({ busy: true });
    try {
      // Finish an older poll, then re-read before acting. No time command is accepted here.
      if (pending) await pending;
      await refresh();
      if (destroyed || snapshot.stale || !snapshot.access.canControl) {
        throw new Error('연결 상태 또는 조작 권한을 확인해 주세요.');
      }
      if (expectedKey !== decisionKey(snapshot.session)) {
        throw new Error('시나리오 또는 권고가 변경되어 요청을 보내지 않았습니다. 최신 내용을 확인해 주세요.');
      }
      const body = buildDecisionCommand(payload?.command, snapshot.session, {
        altitude: payload?.modified_maneuver?.target_altitude_ft, rationale: payload?.rationale,
      });
      const result = await client.command(body);
      if (!destroyed && result?.session_id) {
        set({ session: result, prediction: null, advisory: null, stale: false, error: null });
      }
      await refresh();
      return result;
    } catch (error) {
      // A timed-out POST may already have applied. Read the server; never replay it.
      if (!destroyed) await refresh();
      throw error;
    } finally {
      if (!destroyed) set({ busy: false });
    }
  }

  async function tick() {
    if (destroyed || stopped) return;
    if (!snapshot.busy) await refresh();
    if (!destroyed && !stopped) timer = schedule(tick, intervalMs);
  }
  return {
    refresh, command, getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start() { if (!stopped || destroyed) return; stopped = false; void tick(); },
    destroy() { destroyed = true; stopped = true; abort.abort(); cancel(timer); listeners.clear(); },
  };
}
