# ADR 0021: View별 table size layout placement

- 상태: `ACCEPTED`
- 결정일: 2026-09-05
- 적용 범위: Diagram layout contract, React Flow table resize, layout persistence와 recovery

## Context

큰 이름, 많은 column 또는 사용자가 중요하게 보는 table은 기본 260px 폭과 content 높이만으로 읽기 어렵다.
반대로 table 크기를 DBML이나 schema graph에 넣으면 표현 선호가 schema semantics를 소유하게 된다. Global과
source-defined DiagramView는 서로 다른 화면 구성을 가지므로 하나의 project-wide 크기도 충분하지 않다.

기존 `DiagramLayout.positions`는 stable element key별 `{ x, y }`를 `positions_json`에 저장하고 있다. 새 product
table이나 SQLite migration 없이 이 하위 호환 JSON value를 확장할 수 있다.

## Decision

### Placement contract

`positions` value는 `{ x, y, width?, height? }`다. `width`와 `height`는 반드시 함께 존재하는 positive safe
integer이며 `table:` stable key에만 허용한다. 기존 `{ x, y }` row는 계속 유효하다. Dimension은 현재 view
row에 속하므로 동일 table도 `GLOBAL`과 각 DiagramView에서 서로 다른 크기를 가진다.

Layout normalization, equality, conflict detection과 rename recovery는 dimension을 placement identity의 일부로
다룬다. Explicit table rename은 기존 copy-and-preserve 정책으로 old/new key 양쪽에 position과 size를 함께
보존한다. SQLite는 기존 `positions_json`을 사용하고 storage schema version 3을 유지한다. Portable project
bundle과 whole-volume backup은 placement JSON을 변형하지 않고 보존한다.

### Canvas resize

선택된 table에만 right, bottom, bottom-right pointer handle을 표시한다. 기본 width는 260px, minimum width는
220px이며 minimum height는 현재 LOD에 실제로 표시되는 header와 column row 전체 높이다. Resize 중에는 React
Flow local projection만 갱신하고 pointer release에서 현재 view layout을 한 번 편집한다. Inspector의 width·height
정수 입력과 `Apply size`·`Reset size`는 dragging을 사용할 수 없는 사용자의 canonical keyboard 대체 경로다.

저장 height가 LOD 또는 schema 변경 뒤 content minimum보다 작아지면 render geometry만 minimum으로 올린다. 이
보정은 암묵적 layout write를 만들지 않는다. TableGroup 자체 dimension은 저장하지 않고 visible child table의
position과 effective size로 bounds를 다시 계산한다.

### Layout workflow interaction

Auto-layout Preview는 현재 view에 저장된 custom table size를 ELK input geometry로 사용한다. Preview Apply는
새 x/y와 기존 custom size를 병합한다. Full layout Reset은 current view의 custom size도 제거하고 기본 geometry로
다시 배치한다. Resize와 Inspector size Apply는 camera viewport, DBML source, schema revision, visual command
receipt, schema history와 project `updatedAt`을 변경하지 않는다.

## Alternatives considered

### DBML metadata에 table size 저장

Layout preference가 canonical schema source와 revision을 오염시키며 다른 exporter가 이해하지 못하는 product
metadata를 추가한다. Source-of-truth 경계를 위반하므로 채택하지 않는다.

### 모든 view가 하나의 table size 공유

집중 view와 Global view는 가용 공간과 강조 대상이 다르다. Position과 같은 view sidecar에 두어 독립성을
유지한다.

### Resize 중 계속 API 저장

Pointer move 빈도만큼 optimistic layout revision과 SQLite write가 발생해 충돌과 입력 지연이 커진다. Local
projection을 즉시 보여주고 release에서 한 번만 저장한다.

## Consequences

- 기존 version 3 database와 `{ x, y }` API payload는 migration 없이 호환된다.
- Table size는 durable하지만 camera viewport와 panel width는 계속 session-only다.
- LOD에 따른 effective height가 저장 height보다 클 수 있으며, 사용자가 Apply하거나 resize하기 전에는 저장값을
  자동 교정하지 않는다.
- Group bounds와 Auto-layout은 table dimension을 고려해야 하므로 projection geometry 적용이 position 계산보다
  먼저 실행된다.

## Verification

- `pnpm --filter @er-diagram/contracts test test/layout-api-contract.test.ts`
- `pnpm --filter @er-diagram/core test test/application/layout.test.ts`
- `pnpm --filter @er-diagram/storage-sqlite test test/layout-repository.test.ts`
- `pnpm --filter @er-diagram/web test test/interactive-layout.test.ts test/diagram-base.test.tsx`
- `pnpm --filter @er-diagram/web test test/layout-persistence.test.tsx test/visual-editor.test.tsx`
- `pnpm architecture:check`
