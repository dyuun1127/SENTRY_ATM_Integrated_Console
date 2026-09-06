"""Serialize existing current-time CV evidence without advancing or predicting."""

from datetime import datetime
from typing import TYPE_CHECKING

from sentry_atm.prediction.baseline import ConstantVelocityPredictor

if TYPE_CHECKING:
    from sentry_atm.runtime.session import GoldenDemoSessionRuntime


def current_prediction_payload(session: "GoldenDemoSessionRuntime") -> dict[str, object]:
    """Expose only actual runs belonging to the current clock and runtime state.

    The rolling predictor runs every five simulation seconds. Between those runs,
    there may be no prediction for the current time: return an empty collection
    rather than relabel old points or consult the scenario's future playback.
    Applied-action evidence wins over the pre-action Step at the same timestamp.
    """
    runtime = session.runtime
    clock = runtime.simulation.clock
    now = clock.current_time_utc
    horizons = runtime.prediction_scheduler.service.predictor.horizons_seconds
    payload: dict[str, object] = {
        "session_id": f"{runtime.definition.scenario_id}-RUN-{clock.reset_count:06d}",
        "simulation_time_utc": _utc_text(now),
        "elapsed_seconds": clock.elapsed_seconds,
        "kind": "CONSTANT_VELOCITY",
        "horizons_seconds": list(horizons),
        "prediction_run_id": None,
        "input_timestamp_utc": None,
        "trajectories": [],
    }
    # These existing read facades clear stale evidence on an explicit run reset;
    # none steps the clock, starts inference, applies anchors, or issues decisions.
    results = (
        session.modified_application_orchestrator.last_result,
        session.application_orchestrator.last_result,
        session.step_orchestrator.last_result,
    )
    evidence = next((result for result in results
                     if result is not None and result.timestamp_utc == now), None)
    run = evidence.prediction_run if evidence is not None else None
    if (run is None or run.input_timestamp_utc != now or run.generated_at_utc != now
            or run.model_name != ConstantVelocityPredictor.MODEL_NAME
            or run.horizons_seconds != horizons):
        return payload

    trajectories = []
    for trajectory in run.trajectories:
        offsets = tuple((point.timestamp_utc - now).total_seconds() for point in trajectory.points)
        if offsets != horizons:
            continue
        trajectories.append({
            "aircraft_id": trajectory.aircraft_id,
            "points": [{
                "x_nm": point.x_nm,
                "y_nm": point.y_nm,
                "altitude_ft": point.altitude_ft,
                "horizon_seconds": horizon,
                "timestamp_utc": _utc_text(point.timestamp_utc),
            } for horizon, point in zip(horizons, trajectory.points, strict=True)],
        })
    payload.update(
        prediction_run_id=run.prediction_run_id,
        input_timestamp_utc=_utc_text(run.input_timestamp_utc),
        trajectories=trajectories,
    )
    return payload


def _utc_text(value: datetime) -> str:
    return value.isoformat(timespec="microseconds").replace("+00:00", "Z")
