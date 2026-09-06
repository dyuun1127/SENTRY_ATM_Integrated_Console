import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { registerPickOwner, unregisterPickOwner } from '../data/pickRegistry.js';
import { ARP, prepareFrame, updateHistory } from './adapter.js';
import { createSentryClient } from './client.js';
import { createSentryContextBridge, describeSentrySubject } from './contextAdapter.js';
import { refreshTrackedReadout } from '../data/trackedReadout.js';

const color = (value) => Cesium.Color.fromCssColorString(value);
const world = (point) => Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.height);
const PREFIX = 'sentry:track:';

export function createSentryLayer({ client = createSentryClient() } = {}) {
  let viewer, source, reference, removeSelection, removeTracking, removeContextListeners;
  let sessionSource = null, removeSessionListener = null, lastGeometry = null, navigationError = null;
  let selectedId = null, followingId = null, enabled = false, lastError = null, lastUpdate = null;
  let session = null, scenario = null, advisory = null, prediction = null;
  let pending, epoch = 0;
  let referenceReady = false, prepareCamera = null, networkStale = false, selecting = false;
  const frameTracks = new Map(), framePositions = new Map(), ownedEntities = new WeakSet();
  const contextBridge = createSentryContextBridge();
  const listeners = new Set();
  const history = { sessionId: null, time: 0, tracks: new Map() };
  const snapshot = () => ({ session, scenario, advisory, prediction, selectedId, followingId, enabled, error: navigationError || lastError, stale: networkStale });
  const emit = () => { for (const listener of listeners) listener(snapshot()); };
  const ownTracked = () => Boolean(viewer?.trackedEntity && ownedEntities.has(viewer.trackedEntity));

  function consumeSession(next) {
    if (next.session) {
      const state = next.session;
      if (session && (session.session_id !== state.session_id || state.elapsed_seconds < session.elapsed_seconds)) {
        clearSelection('reset-or-run-changed'); history.tracks.clear();
      }
      session = state; scenario = next.scenario; prediction = next.prediction; advisory = next.advisory;
    }
    networkStale = next.stale; lastError = next.error;
    if (reference && next.geometry !== lastGeometry) {
      reference.entities.removeAll();
      if (next.geometry) drawGeometry(next.geometry);
      lastGeometry = next.geometry;
    }
    if (!next.stale && next.session) lastUpdate = Date.now();
    draw(); emit();
  }
  function subjectFor(id) {
    if (!enabled || !id) return null;
    return describeSentrySubject(frameTracks.get(id), framePositions.get(id), session, networkStale);
  }

  function clearSelection(reason = 'deselected', origin = 'programmatic') {
    selectedId = null; followingId = null;
    // Clear local state before Cesium's synchronous tracking callback runs.
    if (ownTracked()) viewer.trackedEntity = undefined;
    if (viewer?.selectedEntity && ownedEntities.has(viewer.selectedEntity)) viewer.selectedEntity = undefined;
    contextBridge.clear(reason, origin);
  }

  function publishSelection(origin = 'user') {
    const subject = subjectFor(selectedId);
    if (subject) contextBridge.publish(subject, origin);
  }

  function releaseCameraOwner() {
    try {
      // The integration supplies GEV's public beginLocationNavigation facade.
      // Exit its cockpit before a CustomDataSource entity can be adopted there.
      prepareCamera?.();
      if (globalThis.document?.body?.classList.contains('cockpit-mode')) {
        navigationError = 'MAP 화면으로 돌아온 뒤 SENTRY 항공기를 추적해 주세요.';
        emit(); return false;
      }
      navigationError = null;
      return true;
    } catch {
      navigationError = '현재 카메라 모드를 종료한 뒤 다시 시도해 주세요.';
      emit(); return false;
    }
  }

  async function refreshReference(signal, currentEpoch, scenarioId) {
    try {
      const [geometry, descriptor] = await Promise.all([
        client.get('/reference/geometry', signal), client.get('/reference/scenario', signal),
      ]);
      if (currentEpoch !== epoch || signal?.aborted || !reference) return false;
      if (!geometry || !descriptor || descriptor.scenario_id !== scenarioId) return false;
      reference.entities.removeAll();
      drawGeometry(geometry);
      scenario = descriptor; referenceReady = true;
      return true;
    } catch {
      // The manager may already consider init complete. Keep this retryable in
      // update so starting/restarting the backend later recovers the full demo.
      return false;
    }
  }

  function drawGeometry(geometry) {
    let serial = 0;
    const line = (points, tint, width = 1, closed = false) => {
      if (!Array.isArray(points) || points.length < 2 || !points.every((p) =>
        Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite))) return;
      const vertices = closed ? [...points, points[0]] : points;
      reference.entities.add({ id: `sentry:reference:${serial++}`, polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(vertices.flatMap(([lat, lon]) => [lon, lat])),
        width, clampToGround: true, material: color(tint),
      } });
    };
    for (const ring of geometry.rings || []) line(ring.points, '#639ea080', 1, true);
    for (const region of geometry.restricted || []) line(region.points, '#e38d6b', 1.5, true);
    for (const region of geometry.moa || []) line(region.points, '#d8b16e99', 1, true);
    for (const hold of geometry.holds || []) line(hold.points, '#a5bf8299');
    line(geometry.centreline, '#aacddd88');
    line([geometry.runway?.thr06l, geometry.runway?.thr24r], '#f0eeee', 5);
    for (const fix of geometry.fixes || []) {
      if (![fix.lat, fix.lon].every(Number.isFinite)) continue;
      reference.entities.add({ id: `sentry:fix:${fix.name}`, position: Cesium.Cartesian3.fromDegrees(fix.lon, fix.lat),
        point: { pixelSize: 4, color: color('#99c6bf'), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
        label: { text: fix.name, font: '10px monospace', fillColor: color('#b8d5d4'),
          style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
          pixelOffset: new Cesium.Cartesian2(8, 0), horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 160000) },
      });
    }
  }

  function draw() {
    if (!source || !session) return;
    const frame = prepareFrame(session, prediction);
    frameTracks.clear(); framePositions.clear();
    for (const track of frame.tracks) {
      frameTracks.set(track.aircraft_id, track);
      framePositions.set(track.aircraft_id, world(track.position));
    }
    updateHistory(history, session, frame.tracks);
    const current = new Set();
    source.entities.suspendEvents();
    try {
      for (const track of frame.tracks) {
        const id = PREFIX + track.aircraft_id; current.add(id);
        const position = framePositions.get(track.aircraft_id);
        let entity = source.entities.getById(id);
        if (!entity) entity = source.entities.add({ id, name: `${track.aircraft_id} · SENTRY DEMO`,
          viewFrom: new Cesium.Cartesian3(0, -9000, 5000),
          model: { uri: track.military ? '/models/jet.glb' : '/models/airplane.glb', minimumPixelSize: 26,
            maximumScale: 160, scale: 1, colorBlendMode: Cesium.ColorBlendMode.MIX, colorBlendAmount: .85,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 300000) },
          point: { pixelSize: 6, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(300000, 10000000) },
          label: { font: '12px monospace', showBackground: true,
            backgroundColor: color('#07141bdd'), backgroundPadding: new Cesium.Cartesian2(6, 4),
            pixelOffset: new Cesium.Cartesian2(20, -24), horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 350000) },
        });
        ownedEntities.add(entity);
        entity.gevTrackedId = `${layer.id}:${track.aircraft_id}`;
        entity.gevDisplayPosition = () => enabled && framePositions.has(track.aircraft_id)
          ? Cesium.Cartesian3.clone(framePositions.get(track.aircraft_id)) : null;
        entity.gevVisualPosition = entity.gevDisplayPosition;
        const described = describeSentrySubject(track, position, session, networkStale);
        entity.gevLabelModel = { title: `${track.aircraft_id} · SIM`, accent: track.color, details: [
          described.sourceDescription,
          `${Math.round(track.altitude_ft).toLocaleString()} ft · ${Math.round(track.ground_speed_kt)} kt · ${Math.round(track.heading_deg)}°`,
          `SIM UTC ${session.simulation_time_utc || '—'}`,
          ...(networkStale ? ['STALE · last snapshot'] : []),
        ] };
        entity.position = position;
        refreshTrackedReadout(entity);
        entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(position,
          new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(track.heading_deg + 180), 0, 0));
        entity.model.color = color(track.color);
        entity.model.silhouetteSize = selectedId === track.aircraft_id ? 2 : 0;
        entity.model.silhouetteColor = color('#ffffff');
        entity.point.color = color(track.color);
        entity.label.text = `${track.aircraft_id}  SIM\n${Math.round(track.altitude_ft).toLocaleString()} FT · ${Math.round(track.ground_speed_kt)} KT`;
        entity.label.fillColor = color(track.color);
        const past = history.tracks.get(track.aircraft_id) || [];
        if (past.length > 1) {
          const trailId = `sentry:trail:${track.aircraft_id}`; current.add(trailId);
          const trail = source.entities.getById(trailId) || source.entities.add({ id: trailId, polyline: { width: 1, material: color(track.color).withAlpha(.4) } });
          trail.polyline.positions = past.map(world);
        }
      }
      for (const path of frame.paths) {
        const id = `sentry:prediction:${path.aircraftId}`; current.add(id);
        const entity = source.entities.getById(id) || source.entities.add({ id, polyline: {
          width: 2, material: new Cesium.PolylineDashMaterialProperty({ color: color('#aefdf4'), dashLength: 14 }),
        } });
        entity.polyline.positions = path.positions.map(world);
      }
      const pair = frame.conflictIds.map((id) => frame.tracks.find((track) => track.aircraft_id === id));
      if (pair.length === 2 && pair.every(Boolean)) {
        const id = 'sentry:conflict'; current.add(id);
        const entity = source.entities.getById(id) || source.entities.add({ id, polyline: { width: 2, material: color('#ff7e77') } });
        entity.polyline.positions = pair.map((track) => world(track.position));
      }
      for (const entity of [...source.entities.values]) if (!current.has(entity.id)) source.entities.remove(entity);
      if ((selectedId && !frameTracks.has(selectedId)) || (followingId && !frameTracks.has(followingId))) {
        clearSelection('removed');
      }
      // This refresh never claims selection or dispatches another select event.
      contextBridge.refresh(subjectFor(selectedId));
    } finally { source.entities.resumeEvents(); }
    governorRequestRender('sentry-frame');
  }

  const layer = {
    id: 'sentry-demo', name: 'SENTRY · V2 Demo', icon: '✈', source: 'SENTRY scenario', updateInterval: 1000,
    async init(targetViewer) {
      viewer = targetViewer;
      source = new Cesium.CustomDataSource('SENTRY DEMO');
      reference = new Cesium.CustomDataSource('SENTRY RKTU');
      source.show = reference.show = false;
      await Promise.all([viewer.dataSources.add(source), viewer.dataSources.add(reference)]);
      removeSelection = viewer.selectedEntityChanged.addEventListener((entity) => {
        if (entity && ownedEntities.has(entity)) layer.select(entity.id.slice(PREFIX.length));
        else if (selectedId && !selecting) { clearSelection(entity ? 'selection-replaced' : 'deselected'); draw(); emit(); }
      });
      removeTracking = viewer.trackedEntityChanged.addEventListener((entity) => {
        const wasFollowing = followingId;
        followingId = entity && ownedEntities.has(entity) ? entity.id.slice(PREFIX.length) : null;
        if (wasFollowing && !followingId) clearSelection('tracking-replaced');
        emit();
      });
      removeContextListeners = contextBridge.listen(
        () => { clearSelection('selection-replaced'); draw(); emit(); },
        () => { clearSelection('deselected'); draw(); emit(); },
      );
    },
    setSessionSource(controller) {
      removeSessionListener?.();
      sessionSource = controller;
      removeSessionListener = controller.subscribe(consumeSession);
      consumeSession(controller.getSnapshot());
    },
    enable() {
      enabled = true;
      if (sessionSource) consumeSession(sessionSource.getSnapshot());
      registerPickOwner(layer.id, (id) => enabled && id.startsWith('sentry:'));
      if (source) source.show = reference.show = true;
      emit();
    },
    disable() {
      enabled = false; epoch++; unregisterPickOwner(layer.id);
      if (source) source.show = reference.show = false;
      clearSelection('disabled'); emit();
    },
    async update(_viewer, { signal } = {}) {
      if (sessionSource) {
        consumeSession(sessionSource.getSnapshot());
        // Map lifecycle can succeed while the independent session reconnects.
        // Freshness remains visible in getStats and gates controller commands.
        return true;
      }
      if (pending) return pending;
      const currentEpoch = epoch;
      pending = (async () => {
        try {
          const [state, forecast, advice] = await Promise.all([
            client.get('/golden-demo/session', signal),
            client.get('/prediction', signal).catch(() => null),
            client.get('/advisory', signal).catch(() => null),
          ]);
          if (currentEpoch !== epoch || signal?.aborted || !source) return false;
          if (session && (session.session_id !== state.session_id || session.scenario_id !== state.scenario_id
            || state.elapsed_seconds < session.elapsed_seconds
            || Date.parse(state.simulation_time_utc) < Date.parse(session.simulation_time_utc))) {
            clearSelection('reset-or-run-changed');
          }
          session = state; prediction = forecast; advisory = advice; networkStale = false;
          if (scenario?.scenario_id !== state.scenario_id) {
            referenceReady = false; scenario = null; reference.entities.removeAll();
          }
          if (!referenceReady) await refreshReference(signal, currentEpoch, state.scenario_id);
          if (currentEpoch !== epoch || signal?.aborted || !source) return false;
          lastError = referenceReady ? null : '항적 연결됨 · 공역과 단계 정보를 다시 불러오는 중입니다.';
          lastUpdate = Date.now(); draw(); emit(); return true;
        } catch (error) {
          if (currentEpoch !== epoch || signal?.aborted) return false;
          lastError = 'SENTRY 백엔드에 연결할 수 없습니다. 데모 서버 상태를 확인해 주세요.';
          networkStale = true; draw(); emit(); return false;
        } finally { pending = null; }
      })();
      return pending;
    },
    select(id, { origin = 'user' } = {}) {
      if (selecting) return selectedId === id;
      if (!id) { clearSelection('deselected', origin); draw(); emit(); return true; }
      if (!subjectFor(id) || networkStale) return false;
      selecting = true;
      try {
        if (viewer?.trackedEntity && (!ownTracked() || followingId !== id)) {
          if (ownTracked()) clearSelection('selection-changed', origin);
          else if (!releaseCameraOwner()) return false;
        }
        selectedId = id;
        const entity = source.entities.getById(PREFIX + id);
        if (viewer.selectedEntity !== entity) viewer.selectedEntity = entity;
        draw(); publishSelection(origin); emit(); return true;
      } finally { selecting = false; }
    },
    setCameraPreparation(callback) { prepareCamera = typeof callback === 'function' ? callback : null; },
    follow(id, { origin = 'user' } = {}) {
      if (!id) return layer.stopTracking({ origin });
      if (selecting) return ownTracked() && followingId === id;
      const entity = enabled && !networkStale ? source?.entities.getById(PREFIX + id) : null;
      if (!entity || !subjectFor(id)) return false;
      selecting = true;
      try {
        if (!releaseCameraOwner()) return false;
        selectedId = id; entity.gevSelectionOrigin = origin;
        if (viewer.selectedEntity !== entity) viewer.selectedEntity = entity;
        viewer.trackedEntity = entity; followingId = id;
        draw(); publishSelection(origin); emit(); return true;
      } finally { selecting = false; }
    },
    getSubject: subjectFor,
    getSelectedSubject() { return subjectFor(selectedId); },
    getTrackedSubject() { return ownTracked() ? subjectFor(followingId) : null; },
    hasContact(id) { return enabled && frameTracks.has(id); },
    getAllPositions(maxCount = 500) {
      const limit = Number.isFinite(maxCount) ? Math.max(0, Math.floor(maxCount)) : 500;
      return enabled ? [...frameTracks.keys()].slice(0, limit).map(subjectFor) : [];
    },
    getNearby(center, range, maxCount = 50, _options = {}) {
      if (!enabled || !center || ![center.x, center.y, center.z].every(Number.isFinite)) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(0, Math.floor(maxCount)) : 50;
      const maxRange = Number.isFinite(range) && range >= 0 ? range : Infinity;
      return [...frameTracks.keys()].map((id) => {
        const subject = subjectFor(id), distanceM = Cesium.Cartesian3.distance(center, subject.position);
        return { ...subject, callsign: id, type: subject.aircraftType, distanceM, distance: distanceM,
          data: { ...subject, callsign: id, type: subject.aircraftType } };
      }).filter((row) => row.distanceM <= maxRange).sort((a, b) => a.distanceM - b.distanceM).slice(0, limit);
    },
    trackById(id, options = {}) { return layer.follow(id, options); },
    refocusTrackedById(id, options = {}) { return layer.follow(id, options); },
    stopTracking({ origin = 'programmatic' } = {}) {
      clearSelection('deselected', origin); draw(); emit(); return true;
    },
    focusAirport() {
      if (!viewer || !releaseCameraOwner()) return false;
      layer.follow(null);
      viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(ARP.lon, ARP.lat - .5, 145000),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-65), roll: 0 }, duration: 1.4 });
      return true;
    },
    async command(payload) {
      if (sessionSource) throw new Error('판단 명령은 관제 콘솔에서 실행해 주세요. 시나리오 진행은 시연 화면을 사용합니다.');
      if (pending) await pending;
      const result = await client.command(payload);
      // An explicit RESET at t=0 can preserve both timestamp and callsign.
      if (payload?.command === 'RESET') {
        clearSelection('reset', 'user'); history.tracks.clear(); emit();
      }
      await layer.update(viewer);
      return result;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: snapshot,
    getStats() { return { count: enabled ? frameTracks.size : 0, lastUpdate, error: lastError,
      stale: networkStale, staleReason: networkStale ? 'network-error' : null, simulation: true }; },
    destroy() {
      epoch++; enabled = false; unregisterPickOwner(layer.id);
      removeSessionListener?.(); sessionSource = null; lastGeometry = null;
      removeContextListeners?.(); clearSelection('destroyed');
      removeSelection?.(); removeTracking?.();
      if (source) viewer.dataSources.remove(source, true);
      if (reference) viewer.dataSources.remove(reference, true);
      source = reference = null; session = prediction = scenario = null; referenceReady = false;
      prepareCamera = null; networkStale = false; history.tracks.clear();
      frameTracks.clear(); framePositions.clear(); listeners.clear();
    },
  };
  return layer;
}
