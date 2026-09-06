# SENTRY ATM Integrated Console

**SENTRY의 관제 의사결정 지원 데모와 GOD’s EYE의 3D 지구·항공기 추적 화면을 연결한 통합 콘솔입니다.** 청주공항(RKTU) 터미널 시뮬레이션 영역에서 항적, 미래 위치, 분리 위험과 권고를 확인하는 PoC이며 실제 관제용 시스템이 아닙니다.

## 주요 기능

- **3D 지도와 SENTRY 레이어:** 항공기 선택, MAP 따라가기, 시연 이력, 충돌 연결선과 현재 시각의 CV 예측 경로를 표시합니다.
- **CONTACTS:** 공개 항공기와 SENTRY 시나리오 항공기를 출처별로 확인하고 선택 정보·지도 추적으로 연결합니다. SENTRY 항공기는 MAP 추적을 지원하며 Cockpit 진입은 지원하지 않습니다.
- **시나리오 조작:** `START`, `+30초`, `다음 이벤트`, `RESET`과 UTC·경과 시각을 제공합니다. 기본 시나리오는 `sortie`이며 진행 단계에 따라 활성 항공기가 달라집니다.
- **판단과 승인:** 충돌·접근 순서·권고 요약을 확인하고 별도 2D 콘솔에서 Accept / Modify / Reject를 수행합니다. 관제사 결정 전에는 권고가 항공기 런타임을 변경하지 않습니다.
- **임시 HTTPS 공유:** 관람 전용 또는 공동 조작 모드로 같은 데모 세션을 공유할 수 있습니다.

공개 라이브 피드의 관측 시각과 SENTRY 시나리오의 시뮬레이션 시각은 분리됩니다. 지도에 함께 보이는 라이브 항공기가 SENTRY 분리 판단의 입력으로 자동 편입되지는 않습니다. 현재 3D 화면의 미래 항적은 **등속도(CV) 모델의 30·60·120초 예측**이며, 현재 시각과 일치하는 결과만 표시합니다. 저장소의 LSTM·MBE 모델 파일이 이 V2 화면에 연결되었다는 의미는 아닙니다.

## 구성

| 경로 | 역할 |
| --- | --- |
| `sentry-gev-frontend/` | GOD’s EYE 기반 Cesium 화면, SENTRY 레이어·패널, API 프록시 |
| `sentry-gev-v2/` | SENTRY V2 시뮬레이션, 예측·규칙 판단 API, 2D 콘솔·테스트 |
| `start-demo.ps1` | 로컬 프런트엔드·백엔드 함께 실행 |
| `start-public-demo.ps1` / `stop-public-demo.ps1` | 공개 게이트웨이·임시 터널 실행 및 종료 |

화면은 백엔드 API 결과를 표시하며, 시뮬레이션·예측·분리 판단·관제사 승인 처리는 백엔드에 남아 있습니다. 자세한 설계는 [통합 문서](sentry-gev-v2/docs/gev_integration.md)를 참고하세요.

## Windows에서 실행

Git, **Node.js 24.14.0 이상인 24.x 또는 26.x**, **Python 3.12 이상**을 준비하고 새 PowerShell 창을 엽니다. `node -v`, `npm.cmd -v`, `py -3 --version`으로 설치된 버전을 확인하세요.

```powershell
git clone https://github.com/dyuun1127/SENTRY_ATM_Integrated_Console.git
cd SENTRY_ATM_Integrated_Console
py -3 -m venv .\sentry-gev-v2\.venv
Set-Location .\sentry-gev-frontend
npm.cmd ci
npm.cmd run build
Set-Location ..
.\start-demo.ps1
```

기본 백엔드 데모는 Python 표준 라이브러리로 실행됩니다. 런처가 이 저장소의 `src`를 `PYTHONPATH`로 지정하므로 기본 실행에 학습용 패키지 설치는 필요하지 않습니다. 지도·라이브 데이터에는 인터넷 연결이 필요하며 외부 제공업체 상태에 따라 일부 표시가 달라질 수 있습니다.

| 화면 | 기본 주소 |
| --- | --- |
| SENTRY 통합 3D 콘솔 | [127.0.0.1:8781/?sentry=1](http://127.0.0.1:8781/?sentry=1) |
| 상세 판단·승인 콘솔 | [127.0.0.1:8782/](http://127.0.0.1:8782/) |
| 시나리오 진행 화면 | [127.0.0.1:8782/scenario](http://127.0.0.1:8782/scenario) |

스크립트가 실행 정책으로 차단되면 현재 PowerShell 창에만 적용합니다.

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force
.\start-demo.ps1
```

기본 포트는 프런트엔드 **8781**, 백엔드 **8782**, 공개 게이트웨이 **8783**입니다. 사용 중인 포트에서는 실행기가 중단되며 기존 프로세스를 종료하지 않습니다. 이미 실행 중이라면 서버를 다시 시작하지 말고 브라우저에서 위 주소를 여세요. 서버는 런처 종료 후에도 유지되며 실행 기록은 `sentry-gev-v2/logs/gev-demo/`에 저장됩니다. 포트 변경은 `-FrontendPort`, `-BackendPort` 옵션을 사용합니다.

## 외부 접속 공유 · 선택 사항

`cloudflared`를 설치하고 프런트엔드 빌드를 준비한 뒤 사용합니다. 기본값 `local`은 외부 관람 전용입니다. 위의 로컬 데모가 실행 중인 상태에서:

```powershell
.\start-public-demo.ps1
```

외부 사용자에게도 시작·진행·승인·수정·거부를 허용하려면, **로컬 데모를 처음 시작할 때부터** 두 실행기에 `any`를 동일하게 지정합니다. 이 모드에서는 주소를 아는 사람이 같은 세션을 조작합니다.

```powershell
.\start-demo.ps1 -Control any
.\start-public-demo.ps1 -Control any
```

백엔드가 다른 제어 모드로 이미 실행 중이면 공개 실행기는 중단합니다. 기존 서버를 자동 재시작하지 않습니다. `cloudflared` 설치 위치를 직접 지정하려면 `sentry-gev-v2/tools/run_public_demo.ps1`의 `-Cloudflared` 옵션을 사용하세요.

실행기가 출력하는 HTTPS 주소에 `/?sentry=1`, `/console/`, `/scenario`를 붙여 접속합니다. 주소는 다시 실행하면 바뀔 수 있으며 PC·로컬 서버·터널이 실행되는 동안 유효합니다. 프런트엔드 수정 후에는 `npm.cmd run build`를 다시 실행해야 공개 화면에 반영됩니다. 기존 Cloudflare 설정이나 명명 터널 환경변수를 발견하면 실행기는 이를 수정하지 않고 중단합니다.

```powershell
.\stop-public-demo.ps1
```

종료 명령은 최신 실행 기록의 PID·실행 파일·시작 시각을 검증해 해당 공개 게이트웨이와 터널만 종료합니다. 로컬 8781/8782 서버는 유지됩니다. 특정 실행을 종료할 때는 `-StateFile`에 `sentry-gev-v2/logs/gev-public/<실행>/public-processes.json` 경로를 지정합니다.

## API 키와 개발 환경

외부 지도·라이브 피드의 추가 기능은 제공업체별 설정이 필요할 수 있습니다. 프런트엔드의 `.env.example`과 Provider Settings를 참고하고, 자신의 키만 로컬에서 설정하세요. `.env`, 인증정보, 실행 로그·캐시는 저장소에 포함하지 않습니다. 공개 게이트웨이는 로컬 Provider Settings와 Vite 개발 파일을 제공하지 않습니다.

테스트·저장소 연동·학습 기능의 패키지는 별도 설치합니다. 백엔드 폴더에서:

```powershell
Set-Location .\sentry-gev-v2
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
# 저장소 연동·학습 기능 또는 전체 테스트 환경이 필요할 때 추가
.\.venv\Scripts\python.exe -m pip install -e ".[persistence,learning]"
New-Item -ItemType Directory -Path '.pytest_cache' -Force | Out-Null
$testTemp = Join-Path $PWD ('.pytest_cache\run-' + [guid]::NewGuid().ToString('N'))
.\.venv\Scripts\python.exe -m pytest --basetemp $testTemp
.\.venv\Scripts\python.exe -m ruff check .
Set-Location ..\sentry-gev-frontend
npm.cmd test
npm.cmd run build
```

Windows 긴 경로 설치 및 PowerShell 모듈 경로 관련 확인 사항은 [통합 문서](sentry-gev-v2/docs/gev_integration.md)에 있습니다. **2026-09-07 검증:** 백엔드 `1552 passed`·Ruff 통과, 프런트엔드 `2767 passed, 2 skipped`·공개 게이트웨이 10건·빌드 통과. 이는 해당 시점의 검증 결과이며 외부 데이터 제공업체의 가용성을 보장하지 않습니다. 새 복사본의 설치·빌드와 테스트도 확인했습니다. 기존 잠금 파일을 유지했으며, `npm ci`의 의존성 감사는 11건(중간 2·높음 9)을 보고했습니다. 의존성 보안 업데이트는 이 소스 업로드에 포함하지 않았습니다.

## 출처와 라이선스

이 프로젝트는 [Sentry_ATM_V2](https://github.com/dyuun1127/Sentry_ATM_V2)와 Bilawal Sidhu의 [GOD’s EYE View](https://github.com/bilawalsidhu/gods-eye-view)를 바탕으로 통합한 별도 저장소입니다. SENTRY 연동, 시나리오 표시·추적, CONTACTS 연결 및 공유 실행 도구가 추가되어 있습니다.

**저장소 전체가 MIT인 것은 아닙니다.** GOD’s EYE 프런트엔드 소스에는 원본 [MIT 고지](sentry-gev-frontend/LICENSE)를 유지하고, SENTRY 백엔드는 [pyproject.toml](sentry-gev-v2/pyproject.toml)의 `Proprietary` 표기를 유지합니다. 데이터와 3D 모델에는 각 출처의 별도 조건이 적용됩니다. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하세요.
