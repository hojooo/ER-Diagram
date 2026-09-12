# Impeccable 기반 UI 개선과 검증 기록

## 구현 범위

기존 다크·청록색 작업 공간을 유지하며 프로젝트 홈, 캔버스 주변 도구, 시각적 편집 폼,
SQL import/export, 번들 import/export와 다이얼로그의 가독성과 조작 일관성을 개선했다.
디자인 기준은 [DESIGN.md](../../apps/web/DESIGN.md), 재사용 스타일은
[ui.css](../../apps/web/src/ui.css)에 있다. Impeccable 패널용 디자인 sidecar도 함께 기록했다.

- 공통 버튼·입력의 높이, 색상, hover, focus, disabled와 오류 표현을 통일했다.
- 일반 폼 입력은 14px, 컬럼명·타입은 12px, 키 배지는 11px을 사용한다.
- 프로젝트 목록 아래로 런타임 정보를 옮기고, 긴 프로젝트명이 상태 배지 때문에 과도하게 좁아지지 않도록 했다.
- SQL 단계 표시는 실제 입력·검토·적용 또는 다운로드 가능 상태를 따른다. 손실 확인 전에는 다운로드 단계로 표시하지 않는다.
- 긴 테이블·컬럼명은 고정 노드 안에서 말줄임하되 전체 이름과 타입은 접근성 이름·title·Inspector로 확인한다.
- 테이블 폭 260px, 헤더 48px, 행 28px, 그룹 헤더 56px과 기존 projection 계약을 유지했다.
- 복구 안내와 저장 상태를 한 세로 묶음에 배치해 여러 줄 상태가 복구 버튼을 가리지 않도록 했다.
- 양쪽 패널을 연 상태에서도 이력 버튼 묶음이 줄바꿈하여 도구 패널 아래로 넘치지 않도록 했다.

DBML 원문, API, parser/core, 리비전 계약, 다운로드 바이트와 패널 상태 보존 정책은 변경하지 않았다.
새 라이브러리·폰트·테마를 추가하지 않았다. 기존 운영 컨테이너의 배포와 데이터는 변경하지 않았다.

## 회귀 검사 정비

기존 브라우저 검사에는 이전 Source/Outline 버튼, Inspector surface ID, 이전 메타데이터 문구를
찾는 선택자가 남아 있었다. 현재 PRD의 dock toggle·탭과 접근 가능한 region에 맞춰 수정했다.
숨겨진 Outline의 첫 번째 텍스트를 성공 화면으로 오인하지 않도록 실제 표시 영역을 지정했다.
Monaco 커서 검사는 UTF-16 half-open source range 내부에 커서를 두고 검증한다.

추가 검사는 한국어·영어 문서 흐름의 1440/1024/390/320px reflow, 긴 컬럼명과 타입의 겹침 방지,
노드 크기 보존, 선택 후 전체 이름 확인과 SQL 단계 상태를 다룬다.
제품 문서/format 검사와 Docker context에서는 설치된 외부 스킬 및 생성된 테스트 산출물을 분리했다.

## 자동 검증

- `pnpm ci:verify`: unit 660개, security 43개, integration 45개와
  타입·아키텍처·빌드·라이선스·SBOM 검사를 통과했다.
- `pnpm test:e2e`: 기본 설정으로 36개 모두 통과했다 (3.3분).
- `pnpm test:accessibility`: 관련 unit 검사와 브라우저 10개 시나리오 통과. Source/layout conflict,
  last-valid 복구, native field undo, focus return, narrow reflow와 axe 검사를 포함한다.
- `pnpm test:perf --scenario layout-spike`: 통과. 전체 production 성능 인증을 대체하지 않는다.
- `git diff --check`: 통과.

브라우저 검사와 CI를 동시에 실행했을 때 unit 3개에서 준비 대기·5초 timeout이 발생했다.
브라우저 검사를 마친 뒤 CI를 단독 재실행하여 전체 통과를 확인했으며 테스트 timeout을 늘리지 않았다.
개발 서버의 HMR 로그에는 ResizeObserver 경고가 있었다. 최종 production 대표 키보드 흐름에서
`pageerror`를 수집해 다시 실행한 결과는 0건이며, 해당 개발 경고를 production 오류로 일반화하지 않았다.

## Production 검증 범위

기존 서비스와 별개인 Compose 프로젝트 `er-polish-qa`, 테스트 전용 volume과 포트 18080에서 확인했다.
환경은 macOS 15.3.1, 번들 Chromium 151.0.7922.34, 기준 checkout
`bf281e7469ecbda5d8dcf7c5a834411132026db0` 위의 이번 미커밋 변경이다. 모든 스키마는 공개 합성 데이터다.

Pointer 조작 없이 Tab, 방향키, Enter, Space, Escape와 키보드 붙여넣기로 프로젝트 생성·이름 변경·복제·삭제,
Monaco 저장, 검색, Inspector roving toolbar, 컬럼 추가, invalid 복구, History 열기/닫기,
SQL 신규 import, 손실 확인 후 SQL 다운로드, 번들 다운로드를 확인했다.
Monaco의 내부 입력 노드는 0 크기여도 Tab 포커스를 받을 수 있으므로 외부 editor 표면과 실제 포커스를 구분했다.

실제 Chromium page zoom 200%에서 한국어·영어, 640/320 CSS px의 홈·SQL import·번들 import
12개 조합을 검사했다. 모두 `scrollWidth === innerWidth`였으며 단순 deviceScaleFactor 변경을
page zoom 증거로 사용하지 않았다.

이는 [production 키보드 체크리스트](../operations/accessibility-checklist.md) 18개 항목 전체를
모든 변형까지 재수행한 기록은 아니다. 특히 모든 Outline 종류, production 동시 충돌,
invalid revision restore, SQL replace·DML 제외, 번들 import·retained SQL의 모든 키보드 변형은
이번 production walkthrough에서 전부 반복하지 않았다. 해당 기능의 자동 E2E와 production 수동 증거를 구분한다.
스크린리더별 발표 품질이나 전체 WCAG 적합성 인증을 주장하지 않는다.

## Impeccable 판정

4.2.0 스킬과 0.1.0 엔진을 사용해 변경 UI 파일을 한 번 수동 검사했다.
검사 시점 결과는 advisory 43건과 warning 4건이다. Warning은 기존 Inter 선언 1건과 기존 cyan 배경의
slate 텍스트 3건이며, 유지하기로 한 제품 정체성과 axe 결과를 근거로 자동 교체하지 않았다.
Advisory는 DESIGN.md의 제한된 공통 토큰 밖에 있는 기존 색·크기·모서리 표현으로, 결함 0건 인증으로 해석하지 않았다.
브라우저 시각 확인과 실제 행동 검증을 별도로 수행했다.

## 검토용 산출물

최종 QA image ID는 `sha256:84f74f21fc02a81e64c263b26489ec57688e14d1a1c0e4fe4d30212bab967dcf`다.
화면·CI/E2E 로그·production 결과 JSON은 아래 로컬 검토 폴더에 보관했다.

- [작업 화면 개선 전](/Users/hojoo/.codex/visualizations/2026/09/04/01a06e9c-bfe0-7a23-9604-f0477f110bf7/ui-polish/workspace-before.png)
- [작업 화면 개선 후](/Users/hojoo/.codex/visualizations/2026/09/04/01a06e9c-bfe0-7a23-9604-f0477f110bf7/ui-polish/workspace-after.png)
- [320px 프로젝트 홈](/Users/hojoo/.codex/visualizations/2026/09/04/01a06e9c-bfe0-7a23-9604-f0477f110bf7/ui-polish/mobile-home.png)
- [모바일 SQL import](/Users/hojoo/.codex/visualizations/2026/09/04/01a06e9c-bfe0-7a23-9604-f0477f110bf7/ui-polish/mobile-sql-import.png)
