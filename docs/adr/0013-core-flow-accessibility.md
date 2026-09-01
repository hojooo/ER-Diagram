# ADR 0013: Core-flow accessibility와 keyboard navigation

- 상태: `ACCEPTED`
- 결정일: 2026-09-01
- 적용 범위: P0

## Context

DBML·SQL ERD Studio의 P0 core flow는 Project Home, Monaco source editor, React Flow diagram,
schema outline과 inspector, revision history, SQL import/export, portable bundle로 이어진다. 각 component가
개별적으로 label을 갖더라도 route 전환 focus, dialog 복귀, composite widget key handling, live status가 서로
충돌하면 mouse 없이 전체 흐름을 완료할 수 없다. 특히 대형 graph의 모든 React Flow node와 edge를 tab stop으로
만들면 keyboard 접근성이 오히려 graph 크기에 비례해 악화된다.

자동 검사만으로 keyboard 순서, focus 복귀, native text undo와 200% zoom의 실제 사용성을 증명할 수도 없다.
반대로 수동 점검만 사용하면 반복 실행과 regression 차단이 약하다. 자동으로 판정 가능한 WCAG A/AA 위반과
사람이 흐름을 따라 확인해야 하는 항목을 분리하되 두 증거가 모두 있어야 gate를 닫아야 한다.

## Decision

### WCAG baseline과 자동 검사

P0의 자동화 baseline은 axe가 탐지할 수 있는 WCAG 2.0, 2.1, 2.2 A/AA 규칙이다. Playwright gate는
`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` tag를 명시하고 impact 값과 관계없이 violation 하나도
허용하지 않는다. Blanket selector exclusion, rule disable과 violation snapshot 승인은 사용하지 않는다.

`@axe-core/playwright@4.13.0`은 test-only dependency다. MPL-2.0 고지 의무를 license inventory와 third-party
notice에 기록하지만 application source와 배포 license는 계속 Apache-2.0이다. Axe 결과는 자동화 가능한 규칙의
회귀 증거이며 전체 WCAG 인증이나 screen-reader별 적합성 인증으로 표현하지 않는다.

### Page와 focus contract

정상, loading과 error route는 각각 하나의 `main` landmark와 논리적인 `h1`을 가진다. 첫 keyboard focus에는
`Skip to main content`가 나타난다. Client-side route 전환은 visible page heading과 document title을 동기화하고
새 `h1`으로 focus를 이동한다. Dialog close, Monaco range navigation처럼 더 구체적인 focus가 이미 main 안에
설정됐다면 route focus가 이를 덮어쓰지 않는다.

Dialog는 accessible title과 description, focus trap, Escape와 trigger focus return을 제공한다. Destructive
confirmation의 초기 focus는 Cancel이다. Visual inspector toolbar는 roving tab stop과 Left/Right, Home, End를
사용하며 current-view search는 input focus, active descendant, Enter와 Escape를 유지한다. Form validation은
source와 draft를 보존하고 first invalid control 또는 error summary에 focus하며 error 관계를 programmatically
노출한다.

### Diagram keyboard boundary

React Flow canvas의 모든 node와 edge를 tab 순서에 넣지 않는다. `Schema outline`을 table, column, reference와
group 선택 및 source navigation의 canonical keyboard 경로로 두고, inspector가 선택된 element의 create,
update, rename과 delete action을 제공한다. DiagramView, group collapse, search, LOD와 layout control은 native
control 또는 검증된 keyboard pattern을 사용한다.

PK, FK, invalid, selected, group과 diagnostic severity는 color 외 text, badge와 accessible name으로도 전달한다.
본질적인 2D canvas를 제외한 controls는 narrow viewport와 200% zoom에서 content나 action 손실 없이 reflow하며,
interactive target은 WCAG 2.2 target-size 또는 spacing 조건을 충족한다.

### Manual evidence

자동 gate와 별도로 [접근성 keyboard checklist](../operations/accessibility-checklist.md)를 versioned 운영 증거로
유지한다. Production Compose와 current stable Chromium에서 mouse 없이 core flow를 수행하고 commit, browser,
OS, tester와 PASS/FAIL 결과를 기록한다. 실패나 외부 component false positive는 known issue로 완화하지 않으며,
명시적인 후속 결정 전에는 gate를 완료하지 않는다.

## Alternatives considered

### 모든 diagram node와 edge를 tab stop으로 제공

작은 fixture에서는 단순하지만 대형 schema에서 수천 번의 Tab이 필요해진다. Canvas pointer interaction은 유지하고
outline과 inspector를 의미 기반 keyboard 경로로 제공한다.

### Axe violation을 snapshot으로 승인

Dependency upgrade나 DOM 변화 뒤 기존 violation을 정상으로 고착시킨다. Gate는 현재 stable state에서 항상 0건을
요구하며 false positive도 별도 architecture 결정 전까지 제외하지 않는다.

### 자동 검사만으로 M4-007 완료

Focus 이동, native undo, zoom reflow와 전체 task completion은 rule engine만으로 충분히 판정할 수 없다. 반복 가능한
component/browser 검사와 versioned manual walkthrough를 함께 요구한다.

## Consequences

- Route와 dialog focus는 우연한 browser 기본 동작이 아니라 testable application contract가 된다.
- React Flow node/edge는 keyboard tab sequence에서 제외되지만 같은 schema action은 outline과 inspector에서
  수행할 수 있다.
- Accessibility gate가 시간이 더 걸리더라도 selector/rule 예외 없이 core state를 실제 worker와 함께 검사한다.
- Screen-reader vendor별 인증, mobile-native UI와 canvas 전체 element traversal은 P0 범위가 아니다.

## Verification

- `pnpm --filter @er-diagram/web test test/accessibility.test.tsx`
- `pnpm --filter @er-diagram/web test test/visual-editor.test.tsx`
- `pnpm test:accessibility`
- `pnpm test:e2e`
- [접근성 keyboard checklist](../operations/accessibility-checklist.md)
