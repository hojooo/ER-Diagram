# ADR 0020: Atomic column alter와 historical receipt compatibility

- 상태: `ACCEPTED`
- 결정일: 2026-09-04
- 적용 범위: P0 visual column editing, source transform, layout migration, SQLite receipt

## Context

Column 이름, 속성과 순서는 하나의 사용자 편집 화면에서 함께 바뀔 수 있다. 이를 `RENAME_COLUMN`,
`UPDATE_COLUMN`, `REORDER_COLUMN` 세 요청으로 나누면 중간 revision이 사용자 의도와 다른 schema를 노출하고,
두 번째 요청이 실패했을 때 일부만 저장된다. 각 요청이 receipt와 session history step을 만들기 때문에 한 번의
Apply가 여러 undo 단위가 되는 문제도 있다.

이미 저장된 pre-release volume에는 세 legacy kind의 receipt가 있을 수 있다. Public command를 단순 교체하면서
database allowlist에서도 legacy kind를 제거하면 정상 backup을 열지 못하거나 과거 idempotency evidence를 잃는다.

## Decision

### Public atomic command

Public `VisualCommand` catalog는 18종이며 column mutation은 `CREATE_COLUMN`, `ALTER_COLUMN`,
`DELETE_COLUMN`만 제공한다. `ALTER_COLUMN`은 optional `newName`, non-empty `changes`, optional
`beforeColumnKey` 중 하나 이상을 요구한다. Target과 reorder anchor는 모두 변경 전 graph의 stable key다.

Transformer는 이름·속성·순서를 한 계획으로 만든다. 실제 reorder가 없으면 요청한 token만 최소 수정한다.
Reorder가 있으면 trailing inline comment를 포함한 원본 column span을 한 번 이동하고 변경된 declaration을 그
fragment에 반영한다. 실제 rename이 있을 때만 structural Ref endpoint와 index `COLUMN` term을 갱신한다.
Opaque expression, partial provenance, 이름 충돌, range, reparse 또는 semantic closure 중 하나라도 실패하면
source 전체를 원상 유지한다.

### Verified rename evidence

일반 graph diff는 rename과 property·order 변경이 동시에 발생하면 구조 동등 rename을 추론하지 않는다. Public
source-edit heuristic을 완화하지 않고, transformer가 명시적 target과 최종 graph를 resolve한 경우에만 command-scoped
`HIGH / UNIQUE_EXACT_STRUCTURE` rename evidence를 추가한다. Core는 `ALTER_COLUMN` kind 자체가 아니라 이 검증된
evidence가 정확히 하나 있을 때만 모든 layout row의 old position·hidden key를 new key에 copy-and-preserve한다.
Evidence가 없으면 property/order change로 처리하고 layout revision을 만들지 않는다.

Source revision, optional layout migration, receipt와 retention pruning은 한 transaction이다. 실제 source change는
schema revision과 session history step을 각각 하나만 만들고, semantic no-op은 receipt만 저장한다.

### Storage compatibility

Storage schema version 3는 `visual_command_receipts`의 persisted allowlist에 현재 18종과 historical
`UPDATE_COLUMN`, `RENAME_COLUMN`, `REORDER_COLUMN`을 함께 둔다. Version 2 row는 kind, command hash,
revision flag와 timestamp를 byte-identical하게 복사한다. Historical kind는 application의 public command union과
분리된 읽기 전용 type이며 신규 HTTP body에서는 거부한다. 같은 project·command ID의 legacy receipt가 있으면
신규 `ALTER_COLUMN`도 기존 payload와 다르므로 idempotency conflict로 차단한다.

Production startup의 기본 migration 정책은 계속 `MANUAL`이다. Existing version 2 volume은 ADR 0010의 backup,
plan hash와 offline Apply 절차로 version 3에 올린 뒤 연다.

### Canvas editor

Inspector의 세 column action은 하나의 `Edit column` form으로 합친다. Visible Canvas column row double-click은
같은 form을 fixed popover로 열되 node geometry를 바꾸지 않고 input event를 pan·zoom·drag에서 격리한다. Apply
또는 `Ctrl/Cmd+Enter`만 제출하고 blur나 pane click은 저장하지 않는다. `Escape`는 취소한다. 한 번에 한 draft만
유지하며 다른 column을 열기 전 Apply 또는 Cancel을 요구한다. Partial column은 editor를 열지 않고 source
fallback을 제공한다. Outline과 Inspector는 동일 기능의 canonical keyboard path다.

## Alternatives considered

### 기존 세 command를 client batch로 순차 실행

각 HTTP transaction과 revision 사이에 observable intermediate state가 남고 후속 실패를 원자 rollback할 수 없다.
Receipt replay와 undo 단위도 사용자의 한 번 Apply와 일치하지 않는다.

### Generic command batch 추가

Table, reference, index와 check까지 임의 조합하는 transaction 언어는 validation closure와 충돌 정책을 크게 넓힌다.
현재 확인된 column 편집 단위만 명시적 command로 해결한다.

### Legacy receipt를 신규 kind로 rewrite

Command kind와 payload hash는 과거 요청 evidence다. 이를 변환하면 idempotency 비교 의미를 바꾸므로 원문을 보존한다.

## Consequences

- Column form의 한 번 Apply는 최대 한 schema revision, receipt, history step과 한 layout revision만 만든다.
- Public wire contract는 pre-release 단계에서 breaking change이며 legacy 세 kind 요청은 `400`으로 거부된다.
- Storage validator와 backup restore는 public command catalog보다 넓은 historical receipt kind를 알아야 한다.
- Inline editor와 Inspector는 같은 form normalization, command session과 authoritative state adoption을 공유한다.

## Verification

- `pnpm --filter @er-diagram/contracts test test/visual-command.test.ts`
- `pnpm --filter @er-diagram/source-transform test test/table-column.test.ts`
- `pnpm --filter @er-diagram/core test test/application/visual-command.test.ts`
- `pnpm --filter @er-diagram/storage-sqlite test`
- `pnpm --filter @er-diagram/server test:integration visual-commands`
- `pnpm --filter @er-diagram/web test test/visual-editor.test.tsx`
- `pnpm architecture:check`
