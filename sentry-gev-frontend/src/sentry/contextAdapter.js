import * as Cesium from 'cesium';
import { selectTrackedSubjectContext, refreshTrackedSubjectContext,
  clearTrackedSubjectContext } from '../data/contextStore.js';

export const SENTRY_LAYER_ID = 'sentry-demo';
const finite = (value) => Number.isFinite(value) ? value : null;

/** Snapshot coordinates only: simulation time never follows the wall clock. */
export function describeSentrySubject(track, position, session, stale = false) {
  if (!track || !position || typeof track.aircraft_id !== 'string') return null;
  const source = track.source || null;
  return {
    layerId: SENTRY_LAYER_ID, id: track.aircraft_id, label: track.aircraft_id,
    position: Cesium.Cartesian3.clone(position), simulation: true, source,
    sourceDescription: source === 'OPENSKY' ? 'OPENSKY recording · SENTRY simulation'
      : source === 'SYNTHETIC' ? 'SYNTHETIC · SENTRY simulation' : 'SENTRY simulation',
    aircraftType: track.aircraft_type || null,
    altitudeFt: finite(track.altitude_ft), speedKt: finite(track.ground_speed_kt),
    headingDeg: finite(track.heading_deg), verticalRateFpm: finite(track.vertical_speed_fpm),
    emergencyStatus: track.emergency_status || null,
    simulationTimeUtc: session?.simulation_time_utc || null,
    elapsedSeconds: finite(session?.elapsed_seconds), sessionId: session?.session_id || null,
    scenarioId: session?.scenario_id || null, stale, staleReason: stale ? 'network-error' : null,
  };
}

export function sentryContextMetadata(subject) {
  if (!subject) return null;
  const cartographic = Cesium.Cartographic.fromCartesian(subject.position);
  const value = (number, unit) => Number.isFinite(number) ? `${number} ${unit}` : '';
  return {
    ...subject, id: `${SENTRY_LAYER_ID}:${subject.id}`, subjectId: subject.id, layerName: 'SENTRY · V2 Demo',
    latitude: Cesium.Math.toDegrees(cartographic.latitude),
    longitude: Cesium.Math.toDegrees(cartographic.longitude),
    properties: {
      name: subject.label, callsign: subject.id, type: subject.aircraftType || '',
      source: subject.sourceDescription, status: subject.stale ? 'STALE · last snapshot' : 'SIMULATION',
      altitude: value(subject.altitudeFt, 'ft'), speed: value(subject.speedKt, 'kt'),
      heading: value(subject.headingDeg, '°'), verticalRate: value(subject.verticalRateFpm, 'ft/min'),
      emergency: subject.emergencyStatus || '', simulationTime: subject.simulationTimeUtc || '',
    },
  };
}

function awarenessEvent(type, detail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function'
    || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

/** Explicit selection publishes; polling refreshes without claiming the slot. */
export function createSentryContextBridge() {
  let publishedId = null, publishing = false;
  return {
    publish(subject, origin = 'user') {
      if (!subject || publishing) return false;
      publishing = true;
      try {
        publishedId = subject.id;
        selectTrackedSubjectContext(sentryContextMetadata(subject));
        awarenessEvent('gev:awareness-subject-selected', { ...subject, origin });
      } finally { publishing = false; }
      return true;
    },
    refresh(subject) {
      if (subject && subject.id === publishedId) refreshTrackedSubjectContext(sentryContextMetadata(subject));
    },
    clear(reason = 'deselected', origin = 'programmatic') {
      const id = publishedId;
      publishedId = null;
      clearTrackedSubjectContext(SENTRY_LAYER_ID);
      if (id) awarenessEvent('gev:awareness-subject-cleared', { layerId: SENTRY_LAYER_ID, id, reason, origin });
    },
    listen(onForeignSelection, onSelectionCleared) {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
      const host = window;
      const selected = (event) => {
        if (event.detail?.layerId && event.detail.layerId !== SENTRY_LAYER_ID) onForeignSelection(event.detail);
      };
      const cleared = (event) => {
        if (!event.detail?.layerId || event.detail.layerId === SENTRY_LAYER_ID) onSelectionCleared(event.detail);
      };
      host.addEventListener('gev:awareness-subject-selected', selected);
      host.addEventListener('gev:entity-selected', selected);
      host.addEventListener('gev:entity-selection-cleared', cleared);
      return () => {
        host.removeEventListener('gev:awareness-subject-selected', selected);
        host.removeEventListener('gev:entity-selected', selected);
        host.removeEventListener('gev:entity-selection-cleared', cleared);
      };
    },
  };
}