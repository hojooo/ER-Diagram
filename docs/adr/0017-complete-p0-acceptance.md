# ADR 0017: Complete P0 production acceptance

- 상태: `ACCEPTED`
- 결정일: 2026-09-01
- 적용 범위: P0

## Context

Milestone 1~4의 package, integration, browser, security, performance와 release gate는 각 경계의 불변식을 깊게
검증한다. 그러나 개별 gate가 모두 통과해도 동일한 packaged production runtime에서 source 편집, visual mutation,
history, SQL interchange, portable recovery와 SQLite restart가 연결된다는 사실은 자동으로 증명되지 않는다.

Controlled HTTP browser test만으로는 production Fastify composition과 SQLite를 증명할 수 없고, server integration만으로는
Monaco, parser worker, React Flow와 사용자의 download/import workflow를 증명할 수 없다. 또한 같은 volume에서의 restart만
검사하면 portable bundle이 새 installation identity로 복구되는 경계를 놓친다.

## Decision

### Versioned acceptance profile

`@er-diagram/test-fixtures`의 `P0_ACCEPTANCE_PROFILE_VERSION = 1`은 public synthetic fidelity fixture의 source hash,
UTF-8 byte 수, `143/86/4/15/7/573` inventory와 ordered assertion ID를 고정한다. Profile은 dependency-free plain data이고
자기 내용을 canonical JSON으로 hash해 review 없이 fixture나 journey가 바뀌는 것을 차단한다.

Profile은 Release Gate A~F의 focused command도 명시한다. Complete gate는 기존 gate를 다시 정의하거나 완화하지 않는다.
각 gate의 evidence가 하나의 production journey에서 연결되는지만 추가로 검증한다.

### Two-volume production journey

`pnpm test:p0-gate`는 packaged image와 headless Chromium을 사용한다.

1. Outbound connectivity가 없는 application container A를 fresh SQLite volume A에서 시작한다.
2. 실제 Project Home에서 fidelity DBML을 생성하고 group, view, layout, invalid recovery, source·visual mutation,
   undo/redo·restore와 same-dialect SQL export/re-import를 수행한다.
3. Web UI에서 portable bundle을 내려받고 application A를 완전히 종료한다.
4. Fresh SQLite volume B의 별도 production container에서 bundle을 새 project ID로 import한다.
5. Source bytes, revision history, last-valid mapping과 저장된 view layout을 비교한다.
6. Container B를 완전히 교체해 같은 volume B로 다시 시작하고 같은 evidence를 read-back한다.

Application container는 Docker internal network에만 연결한다. Test proxy만 ingress와 internal network 양쪽에 연결하므로
browser는 packaged same-origin Web/API를 사용하면서 application의 external DNS와 literal-IP 연결은 차단된다.

### Evidence와 완료 의미

Gate는 원본 DBML, generated SQL, archive와 native 오류를 stdout에 기록하지 않는다. 성공 시 profile version/hash,
`READY_FOR_P0_RELEASE`와 ordered assertion ID만 JSON으로 출력한다. Operational log에는 source sentinel이 없어야 한다.
Test-owned container, network, volume과 temporary archive는 성공·실패 모두에서 정리한다.

`READY_FOR_P0_RELEASE`는 M4 구현 acceptance가 완료됐다는 뜻이다. Stable tag, GHCR publish, source/image mapping과 실제
OrbStack whole-volume restore는 `P0-RELEASE` 운영 gate이며 이 ADR에서 실행하거나 완료로 표시하지 않는다.

## Alternatives considered

### 기존 E2E spec만 확대

Controlled HTTP는 빠르고 failure localization에 유리하지만 production Fastify, SQLite file와 container lifecycle을
증명하지 못한다. 기존 E2E는 유지하고 별도 packaged journey를 둔다.

### 한 volume에서 export/import

동일 storage에 import하면 기존 row나 accidental coupling이 결함을 가릴 수 있다. Fresh second volume과 새 project ID를
필수로 한다.

### 모든 Release Gate 명령을 한 script 안에서 중복 실행

CI 시간만 늘고 계층별 failure localization이 나빠진다. Profile이 명령 wiring을 검증하고 complete journey는 경계 연결에
집중한다.

## Consequences

- Gate는 image build와 두 production container를 사용하므로 focused unit test보다 느리다.
- Browser와 server가 동일 synthetic fixture를 사용하므로 private/customer schema가 evidence에 들어가지 않는다.
- Portable bundle의 byte 자체는 deterministic 계약이 아니므로 bundle hash는 한 run 안의 transport integrity로만 사용한다.
- 실제 operator backup destination, OrbStack volume과 registry publication은 별도 release checklist가 계속 필요하다.

## Verification

- `pnpm --filter @er-diagram/test-fixtures test test/p0-acceptance-profile.test.ts`
- `pnpm test:p0-gate`
- `pnpm ci:verify`
- `pnpm test:e2e`
