"""The map reads existing CV evidence; reading must never simulate or apply it."""

import json
from dataclasses import replace
from datetime import datetime, timedelta
from io import BytesIO

import pytest

from sentry_atm.domain import AltitudeManeuver
from sentry_atm.infrastructure.http.prediction import current_prediction_payload
from sentry_atm.infrastructure.http.web import GoldenDemoWebWsgiApp
from sentry_atm.prediction.run_service import PredictionRunService
from sentry_atm.runtime import build_golden_demo_session_runtime, build_sortie_session_runtime
from sentry_atm.simulation import SyntheticAircraftRuntime

PATH = "/api/v1/prediction"


def _request(app, method="GET", path=PATH):
    captured = {}

    def start_response(status, headers):
        captured["status"] = int(status.split()[0])
        captured["headers"] = dict(headers)

    body = b"".join(app({
        "REQUEST_METHOD": method, "PATH_INFO": path, "QUERY_STRING": "",
        "CONTENT_TYPE": "application/json", "CONTENT_LENGTH": "0", "wsgi.input": BytesIO(),
    }, start_response))
    return captured["status"], captured["headers"], body


def _snapshot(session):
    clock = session.runtime.simulation.clock
    return (
        session.read_api.get_current().to_dict(),
        clock.tick_count, clock.reset_count, clock.current_time_utc, clock.state,
        tuple(runtime.applied_states for runtime in session.runtime.simulation.engine.runtimes
              if isinstance(runtime, SyntheticAircraftRuntime)),
        session.step_orchestrator.last_result,
        session.runtime.prediction_scheduler.last_run,
    )


@pytest.mark.parametrize(
    "builder", [build_golden_demo_session_runtime, build_sortie_session_runtime],
)
def test_ready_has_no_predictions_and_get_head_preserve_runtime(builder, monkeypatch) -> None:
    session = builder()
    app = GoldenDemoWebWsgiApp(session.http_app, session)
    before = _snapshot(session)

    def prohibited(*args, **kwargs):
        pytest.fail("Reading the map must not run prediction or apply aircraft states")

    monkeypatch.setattr(PredictionRunService, "run", prohibited)
    monkeypatch.setattr(SyntheticAircraftRuntime, "apply_state_anchor", prohibited)
    status, headers, body = _request(app)
    assert status == 200
    payload = json.loads(body)
    assert payload["session_id"] == before[0]["session_id"]
    assert payload["simulation_time_utc"] == before[0]["simulation_time_utc"]
    assert payload["elapsed_seconds"] == 0
    assert payload["kind"] == "CONSTANT_VELOCITY"
    assert payload["horizons_seconds"] == [30, 60, 120]
    assert payload["prediction_run_id"] is None
    assert payload["input_timestamp_utc"] is None
    assert payload["trajectories"] == []
    assert headers["Content-Type"] == "application/json; charset=utf-8"
    assert headers["Cache-Control"] == "no-store"
    assert headers["Content-Security-Policy"] == _request(app, path="/")[1][
        "Content-Security-Policy"
    ]
    head_status, head_headers, head_body = _request(app, "HEAD")
    assert (head_status, head_headers, head_body) == (200, headers, b"")
    assert head_headers["Content-Length"] == str(len(body))
    assert _snapshot(session) == before


@pytest.mark.parametrize(
    "builder", [build_golden_demo_session_runtime, build_sortie_session_runtime],
)
def test_current_points_are_exact_existing_prediction_run_evidence(builder, monkeypatch) -> None:
    session = builder()
    session.command_service.execute("START")
    session.command_service.execute("ADVANCE", seconds=10)
    run = session.step_orchestrator.last_result.prediction_run
    assert run is not None
    before = _snapshot(session)
    app = GoldenDemoWebWsgiApp(session.http_app, session)
    monkeypatch.setattr(PredictionRunService, "run", lambda *args, **kwargs: pytest.fail("new run"))
    _, _, body = _request(app)
    payload = json.loads(body)
    assert payload["prediction_run_id"] == run.prediction_run_id
    assert payload["input_timestamp_utc"] == payload["simulation_time_utc"]
    assert payload["elapsed_seconds"] == 10
    assert len(payload["trajectories"]) == len(run.trajectories)
    now = datetime.fromisoformat(payload["simulation_time_utc"])
    for actual, expected in zip(payload["trajectories"], run.trajectories, strict=True):
        assert actual["aircraft_id"] == expected.aircraft_id
        assert len(actual["points"]) == 3
        for point, original, horizon in zip(
            actual["points"], expected.points, run.horizons_seconds, strict=True,
        ):
            assert (point["x_nm"], point["y_nm"], point["altitude_ft"]) == (
                original.x_nm, original.y_nm, original.altitude_ft,
            )
            assert point["horizon_seconds"] == horizon
            assert datetime.fromisoformat(point["timestamp_utc"]) == original.timestamp_utc
            assert original.timestamp_utc == now + timedelta(seconds=horizon)
    assert _request(app)[2] == body
    assert _snapshot(session) == before


def test_no_current_run_between_rolling_intervals_and_after_reset() -> None:
    session = build_golden_demo_session_runtime()
    session.command_service.execute("START")
    first = current_prediction_payload(session)
    assert first["trajectories"]
    session.command_service.execute("ADVANCE", seconds=1)
    assert session.runtime.prediction_scheduler.last_run is not None
    assert current_prediction_payload(session)["trajectories"] == []
    session.command_service.execute("ADVANCE", seconds=4)
    assert current_prediction_payload(session)["trajectories"]
    session.command_service.execute("RESET")
    reset = current_prediction_payload(session)
    assert reset["session_id"] != first["session_id"]
    assert reset["elapsed_seconds"] == 0
    assert reset["trajectories"] == []
    session.command_service.execute("START")
    restarted = current_prediction_payload(session)
    assert restarted["session_id"] == reset["session_id"]
    assert restarted["trajectories"] == first["trajectories"]


@pytest.mark.parametrize("field,delta", [
    ("input_timestamp_utc", -1), ("input_timestamp_utc", 1), ("generated_at_utc", 1),
])
def test_mismatched_prediction_timestamps_are_not_relabelled_current(field, delta) -> None:
    session = build_golden_demo_session_runtime()
    session.command_service.execute("START")
    step = session.step_orchestrator.last_result
    run = step.prediction_run
    invalid = replace(run, **{field: getattr(run, field) + timedelta(seconds=delta)})
    session.step_orchestrator._last_result = replace(step, prediction_run=invalid)
    before = _snapshot(session)
    result = current_prediction_payload(session)
    assert result["trajectories"] == []
    assert result["prediction_run_id"] is None
    assert _snapshot(session) == before


def test_prediction_points_must_match_the_reported_horizons() -> None:
    session = build_golden_demo_session_runtime()
    session.command_service.execute("START")
    step = session.step_orchestrator.last_result
    run = step.prediction_run
    trajectory = run.trajectories[0]
    invalid = replace(trajectory, points=tuple(
        replace(point, timestamp_utc=point.timestamp_utc + timedelta(seconds=1))
        for point in trajectory.points
    ))
    session.step_orchestrator._last_result = replace(
        step, prediction_run=replace(run, trajectories=(invalid,)),
    )
    assert current_prediction_payload(session)["trajectories"] == []


@pytest.mark.parametrize("modified", [False, True])
def test_post_application_prediction_wins_over_same_time_pre_application_step(modified) -> None:
    session = build_golden_demo_session_runtime()
    for command in ("START", "ADVANCE_TO_CONFLICT", "GENERATE_RECOMMENDATION"):
        session.command_service.execute(command)
    if modified:
        session.command_service.execute(
            "MODIFY_RECOMMENDATION", rationale="Preserve additional vertical margin",
            modified_maneuver=AltitudeManeuver(target_altitude_ft=8800),
        )
        session.command_service.execute("REVALIDATE_MODIFIED_MANEUVER")
        application_command = "APPLY_VALIDATED_MODIFIED_MANEUVER"
        source = session.modified_application_orchestrator
    else:
        session.command_service.execute("ACCEPT_RECOMMENDATION")
        application_command = "APPLY_APPROVED_MANEUVER"
        source = session.application_orchestrator
    prior = current_prediction_payload(session)
    assert prior["prediction_run_id"] == (
        session.step_orchestrator.last_result.prediction_run.prediction_run_id
    )
    session.command_service.execute(application_command)
    before = _snapshot(session)
    result = current_prediction_payload(session)
    assert result["simulation_time_utc"] == prior["simulation_time_utc"]
    assert result["prediction_run_id"] == source.last_result.prediction_run.prediction_run_id
    assert result["prediction_run_id"] != prior["prediction_run_id"]
    target_id = source.last_result.applied_state.aircraft_id
    old = next(item for item in prior["trajectories"] if item["aircraft_id"] == target_id)
    new = next(item for item in result["trajectories"] if item["aircraft_id"] == target_id)
    assert new["points"] != old["points"]
    assert _snapshot(session) == before


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "OPTIONS"])
def test_prediction_endpoint_rejects_writes_and_keeps_runtime_unchanged(method) -> None:
    session = build_golden_demo_session_runtime()
    session.command_service.execute("START")
    before = _snapshot(session)
    status, headers, _ = _request(GoldenDemoWebWsgiApp(session.http_app, session), method)
    assert status == 405
    assert headers["Allow"] == "GET, HEAD"
    assert _snapshot(session) == before
