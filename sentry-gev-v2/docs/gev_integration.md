# GOD's EYE + SENTRY V2 통합 데모

## 1단계 범위

GOD's EYE의 원본 3D 지도·카메라와 항공기 외부 API 연결을 유지하고, Data Layers에는 SENTRY V2 (`sentry-demo`), Live Flights (`flights`), Military Flights (`military`) 세 레이어만 표시한다. CCTV 탭은 제거한다. SENTRY V2 시나리오 항공기와 판단 패널은 별도 데모 레이어로 제공하며, 시뮬레이션·규칙 판단·관제사 승인 처리는 Python 백엔드에 남긴다. 지도 조작이나 항공기 선택은 항공기 런타임을 변경하지 않는다.

백엔드는 `Sentry_ATM_V2`의 `f0dd7f0`에서 출발한 독립 로컬 복제본이다. V3의 AI 콘솔 통합을 그대로 포함하는 버전이 아니다. 프런트엔드 또한 사용자가 실행 중인 원본 GOD's EYE 작업 폴더와 분리한 로컬 복제본이다.

| 구성 | 기본 폴더 | 실행 주소 |
| --- | --- | --- |
| GOD's EYE 프런트엔드 | `sentry-gev-frontend` | `http://127.0.0.1:8781/?sentry=1` |
| SENTRY V2 백엔드 | `sentry-gev-v2` | `http://127.0.0.1:8782` |

두 폴더를 같은 상위 디렉터리에 둔다. 프런트엔드의 SENTRY 프록시 대상은 `SENTRY_BACKEND_URL`로 전달하며, 브라우저는 프런트엔드 주소를 통해 데모 API에 접근한다. 원본 GOD's EYE의 데이터 제공업체 프록시는 유지한다. 8781/8782는 기존 SENTRY·Claude·GOD's EYE 실행 포트와 분리하기 위한 기본값이며, 이미 점유되었다면 새 포트를 선택해야 한다.

## 시간과 항적의 의미

- **라이브 피드:** GOD's EYE가 외부 제공업체에서 갱신하는 공개 관측 데이터다. 제공업체의 수신 시각·갱신 지연을 가진다.
- **SENTRY 데모:** 별도의 시나리오 시간으로 움직이는 합성 항공기다. 통합 패널의 `START`, `+30초`, `다음 이벤트`, `RESET` 명시적 조작은 이 레이어의 시나리오만 변경한다. 라이브 피드의 시간을 바꾸거나 합성 항공기를 실시간 관측 항적으로 표시하지 않는다. 통합 패널에 연속 재생·정지·배속 기능을 추가한 것은 아니다.
- **판단 범위:** SENTRY V2의 예외 큐·분리 판단·권고는 SENTRY 시나리오 항공기를 대상으로 한다. 함께 보이는 외부 라이브 항공기가 자동으로 판단 입력에 포함되는 것은 아니다.
- **예측:** `/api/v1/prediction`의 CV 예측은 현재 운동 상태를 바탕으로 계산한 미래 위치다. 이 V2에는 V3의 `/api/v1/ai-analysis`가 없으며, LSTM·MBE 모델이 이 화면에 연결되었다고 표시하거나 주장하지 않는다.
- **3D 고도:** 백엔드의 ft 고도를 m로 변환해 Cesium의 타원체고로 넣는 표시용 가정을 사용한다. 실제 지형 높이·지오이드에 맞춘 고도 보정은 연결하지 않았다. 지표와의 간격을 실제 AGL 또는 정밀 지형 회피 판단으로 해석하지 않는다.

기본 `sortie` 시나리오는 총 약 4,482.01초이며 시작 시점에는 1대가 활성화된다. 이후 단계에 따라 항공기가 등장한다. 최초 화면에서 모든 시나리오 항공기가 동시에 보여야 하는 것은 아니다. API에서 받은 시각과 활성 항공기 수를 기준으로 표시한다.

Recommendation은 관제사의 Accept, Modify 또는 Reject 이전에 런타임을 변경하지 않는다. 상세 권고 비교와 승인·수정·거부는 통합 패널의 링크로 원본 2D 콘솔을 별도 탭에 열어 수행한다. 이 승인 UI 전체를 3D 패널 안으로 옮긴 것은 아니다. 화면은 RKTU 터미널 시뮬레이션 PoC이며 실제 관제용 시스템이 아니다.

## 최초 준비

Windows에서 Python 3.12 이상과 Node.js 24.14.0 이상인 24.x 또는 26.x를 준비한다. 런처는 PATH의 Node 후보와 표준 설치 경로인 `C:\Program Files\nodejs`에서 `node.exe`와 `npm.cmd`가 모두 있는 설치를 찾는다. PATH 앞쪽의 도구 내장 Node에 npm이 없더라도 이를 건너뛰고 표준 설치를 사용할 수 있다. 설치 경로는 `-NodeDirectory`로 직접 지정할 수도 있다.

백엔드에는 기본적으로 이 복제본의 `.venv\Scripts\python.exe`를 사용한다. 가상환경이 없다면 백엔드 폴더에서 생성한다.

```powershell
py -m venv .venv
```

런처는 `PYTHONPATH`를 이 복제본의 `src`로 지정한다. 백엔드 실행을 위해 다른 SENTRY 복제본을 설치하거나 그 소스를 변경할 필요가 없다. 테스트 도구는 개발 환경에 별도로 준비한다.

프런트엔드 폴더에서 잠금 파일을 기준으로 패키지를 설치한다. 런처가 설치·업데이트를 자동으로 수행하지는 않는다.

```powershell
cd ..\sentry-gev-frontend
& "C:\Program Files\nodejs\npm.cmd" ci
& "C:\Program Files\nodejs\npm.cmd" run doctor
cd ..\sentry-gev-v2
```

## 함께 실행

백엔드 폴더에서 실행한다.

```powershell
.\tools\run_gev_demo.ps1
```

현재 작업 폴더는 사용자가 지정한 `본선\SENTRY_GEV_통합데모` 아래의 두 저장소다.
백엔드는 이 저장소의 독립 `.venv`를 사용한다. 상위 폴더의 `start-demo.ps1`로
두 서버를 함께 실행할 수도 있다. 기존 CreatorTemp 복제본은 이전 시점의 백업이며,
이후 개발·서버 실행은 새 폴더에서 진행한다.

긴 Windows 경로에서 PyTorch를 다시 설치해야 하면 백엔드 폴더에서 확장 경로를 지정한다.

```powershell
$venvPrefix = '\\?\' + (Resolve-Path .\.venv).Path
.\.venv\Scripts\python.exe -m pip install --prefix $venvPrefix -e ".[dev,persistence,learning]"
```

폴더·Node 설치 위치·포트를 바꾸는 예시는 다음과 같다. `FrontendPort`와 `BackendPort`는 서로 달라야 한다.

```powershell
.\tools\run_gev_demo.ps1 `
  -Python ".\.venv\Scripts\python.exe" `
  -FrontendRoot "..\sentry-gev-frontend" `
  -NodeDirectory "C:\Program Files\nodejs" `
  -FrontendPort 8781 `
  -BackendPort 8782 `
  -Scenario sortie
```

성공 메시지가 나오면 [통합 데모](http://127.0.0.1:8781/?sentry=1)를 연다. `?sentry=1`은 원본 최초 실행 선택 화면을 건너뛰고 SENTRY 데모에 바로 연결한다. SENTRY 레이어에서 항공기를 선택하고 `START`, `+30초`, `다음 이벤트`, `RESET`으로 시나리오 진행 상황을 확인한다. 상세 판단·승인은 패널의 원본 [SENTRY V2 콘솔](http://127.0.0.1:8782) 링크로 별도 탭에서 수행하며, 두 화면은 동일한 백엔드 세션을 공유한다.

## 실행 격리와 로그

- 두 서버는 `127.0.0.1`에만 바인딩하며 외부 인터페이스를 열지 않는다.
- 두 포트를 모두 확인한 다음 서버를 시작한다. 점유 중인 포트가 있으면 기존 프로세스를 종료하거나 새 포트로 자동 이동하지 않고 실패한다. 실행 직전의 경합도 Vite `--strictPort`와 백엔드의 포트 독점 설정으로 차단한다.
- 서버는 `Start-Process -WindowStyle Hidden`으로 실행한다. 런처가 끝나도 서버는 유지된다.
- 백엔드 `PYTHONPATH`는 이 복제본만 가리킨다. 임시 환경변수와 PATH는 실행 뒤 호출한 PowerShell의 원래 값으로 복구한다. 시스템 PATH·다른 작업 폴더·`.env`는 수정하지 않는다.
- 프런트엔드 자식 프로세스의 `PSModulePath`는 Windows 기본 모듈 경로로 지정한다. 원본 키 저장 보호 함수가 호출하는 Windows PowerShell 5.1이 상위 PowerShell 7의 모듈을 잘못 선택하는 문제를 피하기 위한 실행 환경 설정이며, 호출 셸의 값은 복원한다. 시스템의 영구 모듈 경로나 실행 정책은 변경하지 않는다.
- `logs/gev-demo/<실행시각>-<고유값>/`에 두 서버의 stdout/stderr와 `processes.json`을 기록한다. JSON에는 PID, 프로세스 시작 시각(UTC), 실행 파일·작업 폴더, 접속 주소, 시작 상태가 들어간다. 이 경로는 기존 `.gitignore`의 `logs/` 규칙으로 제외된다.
- 한 서버를 띄운 뒤 다른 서버 시작에 실패할 수 있다. 이때도 프로세스를 자동 종료하지 않으며 JSON의 `failed` 상태와 기록된 PID로 이번 실행의 상태를 확인한다. 시작 실패가 곧 두 서버 모두 종료되었다는 뜻은 아니다.

종료가 필요할 때는 JSON의 PID와 시작 시각·실행 경로를 실제 프로세스와 먼저 대조한다. PID는 재사용될 수 있으므로 번호만으로 종료 대상을 판단하지 않는다. Python 가상환경 실행기는 자식 Python 프로세스를 생성할 수 있으므로 이 실행에 속한 프로세스 트리를 함께 확인한다. 런처는 포트를 기준으로 기존 프로세스를 강제 종료하는 기능을 제공하지 않는다.

## 지도와 외부 API 키

새 복제본에는 외부 API 키를 기본 설정하지 않는다. GOD's EYE 원본의 **POWER UP → Provider Settings**를 유지하며 사용자가 필요한 제공업체 키를 직접 설정한다. 원본에서 지원하는 키 없는 지도·공개 데이터 경로부터 사용할 수 있다. 실사형 3D 건물, 일부 지도 제공업체 및 부가 API는 원본의 설정과 제공업체 이용 조건·할당량에 따라 달라진다.

다른 작업 폴더의 `.env`나 자격증명을 복사하지 않는다. 사용자가 이 복제본 또는 실행한 셸에 명시적으로 설정한 키가 있으면 원본 GOD's EYE 설정 방식으로 처리된다. API 키와 `.env`는 커밋하지 않으며, 키가 없어 생략된 기능을 SENTRY 모델 장애로 오해하지 않도록 구분한다.

## 로컬 변경 관리와 확인

프런트엔드와 백엔드는 서로 다른 Git 저장소다. 기능별 변경과 검증 결과를 각각의 작은 로컬 커밋으로 관리한다. 원본 GOD's EYE 및 SENTRY V2 upstream 파일을 덮어쓰거나 원격으로 push하는 작업은 이 통합 실행에 포함되지 않는다. GOD's EYE의 MIT 고지와 원본 데이터·지도·모델 자산의 출처 및 개별 조건을 유지한다.

백엔드 변경 검증은 이 저장소의 `AGENTS.md`에 따라 `pytest`와 `ruff check .`를 실행한다. 프런트엔드는 해당 저장소의 단위 테스트와 빌드, 실제 브라우저에서 지도·SENTRY 항적·시간 조작·판단 기능을 확인한다. 런처 자체의 PowerShell 구문 검사는 서버 실행과 별개이며, 구문 검사 통과만으로 통합 실행 성공을 주장하지 않는다.

### 2026-09-06 검증 결과

- 원본 기준: SENTRY V2 `f0dd7f0`, GOD's EYE `7596522`.
- 백엔드 전체 pytest: **1548 passed**, 기존 fixture 경고 3개. Ruff 통과.
- V2 출격 시나리오의 비상 상태가 다음 운동 앵커까지 약 1.87초 늦게 반영되던
  문제를 수정했다. 3356초 선언 시각에 상태 앵커를 추가했으며, 회귀 테스트로
  선언 직전·정각·직후의 상태와 기존 위치·속도·침로 유지 여부를 확인했다.
- GOD's EYE 전체 Node 테스트와 할당량 검증: **2736 passed, 2 skipped, 0 failed**.
  원본 Windows 권한 검증을 포함하며 아래의 실행 환경 보정으로 통과했다.
- 프런트 빌드 성공. 원본 대형 지도 데이터 청크에 대한 크기 경고는 남아 있다.
- 실제 브라우저: 기존 온라인 지도 요청과 청주 시점, 시나리오 항공기 표시,
  선택·추적 중 Runtime 불변, START/+30초/다음 이벤트, 현재 CV 경로,
  레이어 끄기·켜기, RESET 후 이전 이력 제거, 390px 모바일 조작 통과.
- 독립 초기 세션에서 3356초 비상 장면으로 이동하여 `DECLARED`,
  `CRITICAL` 충돌 연결선과 항공기 추적을 확인했다. 추적은 관제 결정을
  생성하거나 Runtime을 변경하지 않았고, 검증 뒤 READY 상태로 초기화했다.
- 실행기를 실제로 실행하여 8781/8782 응답을 확인했다. 이미 사용 중인 포트에서는
  새 서버를 만들거나 기존 프로세스를 종료하지 않고 실패하는 것도 확인했다.
- 검증 이미지는 프런트의 `.gev-logs/sentry-qa/`에 보관하며 커밋하지 않는다.

프런트엔드 원본의 Windows ACL 테스트는 PowerShell 7에서 직접 실행하면 상속된 모듈 경로 때문에 `Get-Acl` 자동 로드가 실패할 수 있다. 이 환경에서 빈 임시 파일의 ACL 적용은 성공했고, Windows 기본 모듈 경로로 실행한 원본 테스트도 통과했다. 테스트 시에도 런처와 동일한 자식 환경을 사용하고 기존 `PSModulePath`는 실행 후 복원한다. 실제 자격증명 파일로 시험하지 않는다.
### 새 작업 폴더 이전 검증

- 이전 전 작업 파일 10,547개(464,923,600바이트)의 SHA-256을 새 폴더와 비교해 일치를 확인했다. Git 이력·모델·설치된 프런트 패키지와 기존 검증 자료를 포함한다.
- 새 백엔드의 독립 `.venv`에서 pytest **1548 passed**, Ruff 통과, `pip check` 통과.
- 공용 pytest 임시 폴더의 기존 권한 충돌을 피하기 위해 이번 테스트는 `.pytest_cache` 아래 고유한 `--basetemp`를 지정했다. 기존 공용 임시 폴더의 권한이나 내용을 변경하지 않았다.
- 새 프런트 경로의 빌드와 실제 브라우저 통합 검증(지도·추적·시나리오 조작·CV·초기화·모바일)을 통과했다.
- 서버 실행 기록으로 두 작업 디렉터리와 Python 경로가 모두 새 폴더 내부임을 확인했다. 확인 후 데모는 READY 상태로 두었다.

## Cloudflare 임시 공개 접속

통합 폴더에서 서버를 `start-demo.ps1 -Control any`로 시작한 다음, `start-public-demo.ps1 -Control any`를 실행한다. 이미 서버가 실행 중이면 첫 명령을 반복하지 않는다. backend 설정과 공개 설정이 다르면 공개 실행기는 실패하며 기존 서버를 자동 종료하지 않는다. `local`은 외부 관람 전용이고 `any`는 주소를 아는 사람이 같은 시나리오를 시작·진행·승인·수정·거부할 수 있는 공유 조작 모드다.

공개 실행기는 별도 루프백 포트 8783에서 프런트 `dist`를 제공하고 필요한 SENTRY·항공기 조회 API만 기존 서버에 연결한다. 원본 Vite 개발 파일, Provider Settings, OpenAI·음성 및 제외한 레이어의 API는 외부 경로로 제공하지 않는다. 지도 제공자에 직접 연결하는 브라우저용 지도 토큰은 원본 동작을 따른다. 프런트 변경 후에는 `npm.cmd run build`로 공개용 산출물을 다시 만들어야 한다.

출력되는 임시 HTTPS 주소 하나에서 `/?sentry=1`은 SENTRY Globe, `/console/`은 SENTRY Console, `/scenario`는 시나리오 진행 화면이다. 같은 주소의 `/sentry-api`와 `/api/v1`은 같은 백엔드 세션을 사용한다. 터널 요청의 전달 헤더를 유지하며 백엔드는 루프백 바인딩에서도 선택한 제어 모드를 검사한다.

`stop-public-demo.ps1`은 실행 기록의 PID·실행 경로·UTC 시작 시각을 모두 검증한 뒤 이 공개 실행의 gateway와 cloudflared만 종료한다. 원래 로컬 서버는 유지한다. 필요하면 `-StateFile`로 `logs/gev-public/<실행>/public-processes.json`을 지정한다. 기존 Cloudflare 설정이나 이름 있는 터널 환경변수가 있으면 공개 실행기는 이를 수정하지 않고 중단한다.

PC, 로컬 서버와 터널이 실행되는 동안 접속할 수 있다. Quick Tunnel은 매 실행 때 임시 주소를 생성하는 테스트용 서비스다. [Cloudflare 공식 안내](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

검증: 백엔드 1,550건·Ruff, 프런트 기본 테스트 2,742건(2건 생략)·빌드, 공개 gateway 독립 테스트 10건 통과. 실제 공개 브라우저 검증은 프런트의 `scripts/qa-sentry-public.mjs`를 실행하고 `.gev-logs/public-qa/report.json`과 화면 이미지에 기록한다. 기본 검증은 조회만 수행하며 `--exercise`는 READY/0초인 세션에서 START→30초 진행→RESET을 확인한다.
