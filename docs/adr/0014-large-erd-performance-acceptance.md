# ADR 0014: Large ERD performance acceptance

- 상태: `ACCEPTED`
- 결정일: 2026-09-01
- 적용 범위: P0

## Context

대형 ERD의 source parse가 worker에서 빨라도 view 전환마다 ELK를 다시 실행하거나 background layout이 완료된
뒤 node가 이동하면 사용자가 체감하는 interactive 시점은 늦고 불안정하다. 개발용 component test나 단일
layout spike만으로는 production bundle의 parser worker, React Flow rendering, viewport 적용, pointer
interaction과 main-thread long task를 함께 증명할 수 없다.

성능 수치는 browser, fixture, sample 수와 percentile 방식에 따라 크게 달라진다. 측정 환경이나 반복 횟수를
명시하지 않은 threshold는 CI regression gate로 재현할 수 없으며, 느린 결과를 retry 또는 threshold 변경으로
완화하면 제품 요구사항이 조용히 약해진다.

## Decision

### Deterministic interactive layout

일반 workspace 진입과 view·LOD·collapse 변경은 ELK를 호출하지 않는 Derived layout으로 완료한다. Target
view의 durable saved position을 우선하고 current stable projection의 absolute position을 stable key별로
재사용한다. Parent group이 달라진 table은 target group 상대 좌표로 변환하며 visible child 위치와 크기로
compound bounds를 다시 계산한다. 위치가 없는 node는 stable-key 순 collision-free grid에 배치한다.

Derived position은 layout sidecar에 자동 저장하지 않으며 schema revision, layout revision과 project
`updatedAt`을 변경하지 않는다. `Diagram layout ready`는 position과 compound bounds, persisted viewport 또는
fit viewport 적용, drag·pan·zoom 활성화가 모두 끝난 뒤에만 표시한다. 그 이후 background ELK 결과로 node를
이동하지 않는다.

ELK worker는 사용자가 명시한 Auto-layout Preview와 Reset에서만 실행한다. Preview의 generation guard,
Apply·Cancel, timeout과 resource cap은 기존 durable layout 경계를 유지한다.

### Versioned measurement profile

`M4_PERFORMANCE_PROFILE_VERSION=1`은 다음 source evidence를 고정한다.

| Fixture | UTF-8 bytes | SHA-256 | Inventory |
| --- | ---: | --- | --- |
| fidelity | 147,689 | `f43bccdd83369eb9fa606e4251ede3b747e117eb6c5648c9ca22d071affe5716` | 143 tables, 86 enums, 4 partials, 15 groups, 7 views, 573 refs |
| scale | 118,982 | `2a14b1c7444020815b949166d9b15059371294dcd95d066848700b523a93a434` | 200 tables, 1,000 refs |

Performance profile 자체의 SHA-256은
`907df17483db1d654ea8a128ca10e0a82ab227c5153440e4a68c7cd7433e8641`이다. 실제 고객 schema와 row data는
fixture에 포함하지 않는다.

측정 환경은 production Vite bundle, current stable Chrome headless, viewport 1440×900, DPR 1, Playwright
worker 1, retry 0, 최소 4 logical CPU와 8 GiB RAM이다. p95는 nearest-rank로 계산한다.

| 항목 | Sample과 hard threshold |
| --- | --- |
| Parse | persistent parser worker warm-up 3회 뒤 20회, p95 ≤ 1,000 ms |
| Cold interactive | isolated context 20회, stable layout까지 p95 ≤ 3,000 ms |
| View switch | 7개 source view의 first-uncached 전환 각 3회와 ordered cycle, 모든 관찰·aggregate p95 ≤ 300 ms |
| Frame pacing | 200 tables·1,000 refs, drag·pan·zoom 각 2초×5회, p95 interval ≤ 33.34 ms |
| Source input | 30회 입력×5 run, 100 ms 초과 long task 0건 |

View 전환 중 parser·ELK request와 source/layout PUT은 모두 0건이어야 한다. Parse는 parser worker에서,
명시적 Auto-layout은 ELK worker에서 실행되어야 한다. Frame interval median 16.67 ms는 60 FPS 목표로 별도
보고하지만 hard gate는 p95 33.34 ms의 30 FPS다. 결과 JSON에는 source나 worker payload를 포함하지 않는다.

### CI enforcement

`pnpm test:perf`는 profile fixture 검증, 기존 layout spike, production Web build와 전용 Playwright performance
suite를 실행한다. PR과 release workflow 모두 같은 full command를 worker 1·retry 0으로 실행한다. 실패를
retry, sample 감소, selector 제외 또는 threshold 완화로 통과시키지 않는다. Threshold 변경은 새로운 측정
evidence와 architecture 결정을 동반해야 한다.

2026-09-01 reference run은 Chrome 152, 12 logical CPU, 16 GiB memory에서 다음 결과를 기록했다. CI의 각
실행 결과가 authoritative하며 이 수치는 환경 drift를 숨기는 고정 성능 주장으로 사용하지 않는다.

| 항목 | Samples | min | median | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parse (ms) | 20 | 420.50 | 430.50 | 449.70 | 465.50 |
| Cold interactive (ms) | 20 | 2,327.43 | 2,338.87 | 2,380.92 | 2,547.79 |
| View switch (ms) | 29 | 129.10 | 200.20 | 217.10 | 225.50 |
| Drag frame interval (ms) | 599 | 16.50 | 16.70 | 16.80 | 33.40 |
| Pan frame interval (ms) | 604 | 16.50 | 16.70 | 16.70 | 16.80 |
| Zoom frame interval (ms) | 601 | 16.50 | 16.70 | 16.70 | 16.80 |

Source input은 150 events에서 100 ms 초과 long task 0건이었고 view switch는 parser·ELK request와
source/layout PUT 모두 0건이었다. Explicit Auto-layout은 ELK request 1건으로 검증했다.

## Alternatives considered

### 모든 projection 변화에서 ELK 재실행

새 graph를 보기 좋게 정렬할 수 있지만 first-uncached view latency와 background node movement가 worker 성능에
종속된다. 일반 interaction은 deterministic Derived layout으로 즉시 완료하고 사용자가 명시한 재배치만 ELK에
위임한다.

### 개발용 layout spike만 유지

Graph projection 계산은 확인할 수 있지만 production React Flow, browser worker, viewport와 pointer frame
pacing을 증명하지 못한다. Spike는 빠른 회귀 검사로 유지하고 production browser gate를 추가한다.

### CI variability를 retry로 흡수

Flaky retry는 가장 느린 run을 숨겨 p95 gate의 의미를 약화한다. 고정 환경과 sample 수를 사용하고 환경
최소조건을 충족하지 못하면 성능 실패와 구분되는 configuration failure로 처리한다.

## Consequences

- View·LOD·collapse 전환은 worker queue와 layout write에 의존하지 않는다.
- 신규 node의 자동 배치는 단순한 deterministic grid이며 더 나은 배치가 필요하면 사용자가 Auto-layout을
  명시적으로 실행한다.
- Full performance suite는 browser sample 수 때문에 기존 spike보다 오래 걸리지만 PR과 release regression을
  실제 production bundle에서 차단한다.
- Cross-browser, mobile device와 server throughput certification은 P0 M4-008 범위가 아니다.

## Verification

- `pnpm --filter @er-diagram/test-fixtures test test/performance-profile.test.ts`
- `pnpm --filter @er-diagram/web test test/interactive-layout.test.ts`
- `pnpm test:perf`
- `pnpm test:perf --scenario layout-spike`
- `pnpm test:e2e`
