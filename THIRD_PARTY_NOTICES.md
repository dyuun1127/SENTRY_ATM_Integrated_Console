# 출처 및 제3자 고지

이 저장소는 SENTRY ATM과 GOD’s EYE View를 통합한 데모입니다. 소스 코드·데이터·시각 자산에 적용되는 조건은 서로 다르며, 공개 저장소라는 사실이 모든 구성요소의 이용 조건을 변경하지 않습니다.

## 기반 프로젝트

| 구성 | 원본 | 유지하는 고지 |
| --- | --- | --- |
| `sentry-gev-frontend/` | [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view), Copyright (c) 2026 Bilawal Sidhu | [LICENSE](sentry-gev-frontend/LICENSE): GOD’s EYE 소스 코드의 MIT 라이선스 전문 및 데이터·모델 예외 |
| `sentry-gev-v2/` | [dyuun1127/Sentry_ATM_V2](https://github.com/dyuun1127/Sentry_ATM_V2), Team Sejong | [pyproject.toml](sentry-gev-v2/pyproject.toml): `Proprietary`. 프런트엔드의 MIT 고지를 백엔드에 확대 적용하지 않음 |

통합 작업에는 SENTRY API 연결, 시나리오 레이어·패널, 선택·MAP 추적과 CONTACTS 연결, CV 경로 표시, 공개 게이트웨이와 Windows 실행 도구가 포함됩니다. 원본 저작권·라이선스 고지를 유지하며, 원저작자의 후원이나 승인을 의미하지 않습니다. 복사 기준 커밋과 제외 파일은 [source-provenance.json](source-provenance.json)에 기록합니다.

## 데이터와 외부 서비스

전체 목록·출처·귀속 표시는 프런트엔드의 [DATA_SOURCES.md](sentry-gev-frontend/DATA_SOURCES.md)와 각 데이터 폴더의 고지를 따릅니다. 아래는 포함 자산의 주요 구분입니다. 현재 콘솔에서 해당 레이어를 숨겨도 저장소에 포함된 자산의 조건은 유지됩니다.

| 자료 | 원본 고지에 명시된 조건·출처 |
| --- | --- |
| TeleGeography 해저 케이블·육양국 | © TeleGeography — submarinecablemap.com, **CC BY-NC-SA 3.0**. 출처 표시·비상업·동일조건변경허락. [개별 고지](sentry-gev-frontend/src/data/local_data/telegeography_submarine_cables/README.md) |
| Datacenters / Dams | © OpenStreetMap contributors, Open Infrastructure Map. **ODbL 1.0**. 데이터에 대한 출처 표시·동일조건 요구사항은 소스 코드와 구분 |
| Natural Earth 지형 영역 | Natural Earth, public domain. [개별 출처](sentry-gev-frontend/src/data/local_data/natural_earth/README.md) |
| DataSF Analysis Neighborhoods | City & County of San Francisco — DataSF, **PDDL 1.0**. [개별 출처](sentry-gev-frontend/src/data/local_data/neighborhoods/SOURCE.md) |

원본의 TomTom 실측 테스트 타일은 이 배포본에서 제외했습니다. 디코딩·캐시 회귀 검증에는 네트워크 없이 생성한 **합성 MVT fixture**를 사용합니다. [fixture 고지](sentry-gev-frontend/src/data/fixtures/README.md)를 참고하세요.

Google Maps, Cesium 관련 지도 제공자, Esri, OpenSky, adsb.lol 등 실행 중 연결되는 외부 서비스는 해당 제공업체의 이용 조건·인증·귀속 요구사항을 따릅니다. 이 저장소가 외부 서비스의 콘텐츠나 이용 권한을 별도로 부여하지는 않습니다. 화면의 지도 크레딧과 **Data attribution** 표시, 파일별 출처 고지를 유지하세요. 자세한 서비스별 구분은 [DATA_SOURCES.md](sentry-gev-frontend/DATA_SOURCES.md)에 있습니다.

## 3D 모델

`sentry-gev-frontend/public/models/`의 모델은 MIT 소스 코드와 별개인 제3자 자산입니다. 현재 고지된 `airplane`, `jet`, `ship`, `bell206`, `c172`, `citation2`, `mq9`, `b789`, `atr72` GLB 파일은 각각 **CC BY 4.0**으로 기록되어 있습니다.

모델별 원작명, 제작자, 원본 링크, 라이선스 링크와 GOD’s EYE의 최적화·변환 내역은 [Bundled 3D Model Attribution](sentry-gev-frontend/public/models/README.md)에 보존되어 있습니다. 모델을 재배포할 때 해당 출처와 변경 내역도 함께 유지해야 합니다.

## 원본 소개 이미지·영상

GOD’s EYE의 홍보용 GIF 17개와 PNG 2개는 이 배포본에 복사하지 않았습니다. 프런트엔드 README의 해당 미디어 링크는 원본 저장소를 참조하며 SENTRY 통합 기능의 실행 증거를 뜻하지 않습니다. 원본 미디어의 저작권·이용 조건은 [원본 고지](sentry-gev-frontend/docs/media/README.md)를 참고하세요.

## 패키지 의존성

Cesium 등 npm 패키지와 선택 설치하는 Python 패키지는 각각의 라이선스를 유지합니다. 프런트엔드 [package.json](sentry-gev-frontend/package.json)·[package-lock.json](sentry-gev-frontend/package-lock.json), 백엔드 [pyproject.toml](sentry-gev-v2/pyproject.toml) 및 설치되는 패키지의 개별 고지를 참고하세요. 이 문서는 원본 라이선스 전문과 개별 자산 고지를 대체하지 않습니다.
