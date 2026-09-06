"""Exercise the Windows PowerShell 5.1 ownership-file reader without live processes."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform != "win32", reason="Windows PowerShell 5.1 regression"),
]

_REPOSITORY = Path(__file__).resolve().parents[2]
_MISSING_PID = 2_147_483_647
_TICKS = (date(2026, 9, 7) - date(1, 1, 1)).days * 864_000_000_000 + 1_234_567


def _run_powershell(executable: Path, arguments: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(executable), "-NoProfile", "-ExecutionPolicy", "RemoteSigned", *arguments],
        cwd=_REPOSITORY,
        capture_output=True,
        timeout=30,
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def _assert_success(result: subprocess.CompletedProcess) -> None:
    assert result.returncode == 0, (
        result.stdout.decode("utf-8", errors="replace")
        + result.stderr.decode("utf-8", errors="replace")
    )


@pytest.mark.parametrize("ticks_as_string", [False, True], ids=["int64-ticks", "string-ticks"])
def test_stop_public_demo_reads_bomless_utf8_in_windows_powershell_51(
    ticks_as_string: bool,
) -> None:
    powershell = (
        Path(os.environ.get("SystemRoot", r"C:\Windows"))
        / "System32/WindowsPowerShell/v1.0/powershell.exe"
    )
    if not powershell.is_file():
        pytest.skip("Windows PowerShell 5.1 is not installed")
    version = _run_powershell(
        powershell,
        ["-Command", "$PSVersionTable.PSVersion.ToString()"],
    )
    _assert_success(version)
    assert version.stdout.decode("ascii").strip().startswith("5.1."), (
        "This regression must run on Windows PowerShell 5.1, not pwsh 7."
    )

    log_root = (_REPOSITORY / "logs/gev-public").resolve()
    log_root.mkdir(parents=True, exist_ok=True)
    run_directory = Path(tempfile.mkdtemp(prefix="pytest-stop-utf8-", dir=log_root))
    try:
        # The real default stop command searches public-processes.json only.
        # A different filename keeps this fixture out of that discovery path.
        state_file = run_directory / "utf8-regression-state.json"
        working_directory = run_directory / "한글 작업 공간"
        exact_ticks = str(_TICKS) if ticks_as_string else _TICKS
        original = {
            "schemaVersion": 1,
            "kind": "sentry-public-demo",
            "status": "ready",
            "description": "공개 데모 종료 회귀 검사",
            "gateway": {
                "pid": _MISSING_PID,
                "executable": str(working_directory / "노드 런타임/node.exe"),
                "startedAtUtc": "2026-09-07T00:00:00.1234567Z",
                "startedAtUtcTicks": exact_ticks,
                "arguments": [str(working_directory / "게이트웨이.mjs"), "--control", "any"],
                "workingDirectory": str(working_directory),
                "stdout": str(run_directory / "게이트웨이.stdout.log"),
                "stderr": str(run_directory / "게이트웨이.stderr.log"),
                "status": "running",
            },
            "tunnel": {
                "pid": _MISSING_PID,
                "executable": str(working_directory / "터널 도구/cloudflared.exe"),
                "startedAtUtc": "2026-09-07T00:00:00.1234567Z",
                "startedAtUtcTicks": exact_ticks,
                "arguments": ["tunnel", "--url", "http://127.0.0.1:8783"],
                "workingDirectory": str(working_directory),
                "stdout": str(run_directory / "터널.stdout.log"),
                "stderr": str(run_directory / "터널.stderr.log"),
                "status": "running",
            },
        }
        state_file.write_text(
            json.dumps(original, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        assert not state_file.read_bytes().startswith(b"\xef\xbb\xbf")
        assert "한글 작업 공간" in state_file.read_text(encoding="utf-8")

        for _ in range(2):
            # Refuse to run the stop script if this sentinel PID unexpectedly exists.
            missing = _run_powershell(
                powershell,
                [
                    "-Command",
                    f"if (Get-Process -Id {_MISSING_PID} -ErrorAction SilentlyContinue) "
                    "{ exit 17 }; exit 0",
                ],
            )
            _assert_success(missing)
            stopped = _run_powershell(
                powershell,
                [
                    "-File",
                    str(_REPOSITORY / "tools/stop_public_demo.ps1"),
                    "-StateFile",
                    str(state_file),
                ],
            )
            _assert_success(stopped)

            # PowerShell 5.1 writes UTF-8 with a BOM; accept it while verifying Unicode.
            persisted = json.loads(state_file.read_text(encoding="utf-8-sig"))
            assert persisted["status"] == "stopped"
            assert persisted["description"] == original["description"]
            assert persisted["stoppedAtUtc"]
            for role in ("gateway", "tunnel"):
                assert persisted[role] == {**original[role], "status": "already-exited"}
                assert persisted[role]["startedAtUtcTicks"] == exact_ticks
                assert type(persisted[role]["startedAtUtcTicks"]) is type(exact_ticks)
    finally:
        # Validate the exact freshly-created directory before recursive cleanup.
        resolved = run_directory.resolve(strict=True)
        assert resolved.parent == log_root
        assert resolved.name.startswith("pytest-stop-utf8-")
        assert not run_directory.is_symlink() and not run_directory.is_junction()
        shutil.rmtree(resolved)
