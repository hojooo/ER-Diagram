# ADR 0006: Revision 단위 session history와 durable restore

- 상태: `ACCEPTED`
- 결정일: 2026-08-30
- 적용 범위: P0

## Context

Source autosave와 visual command는 모두 canonical DBML을 변경하지만 서로 다른 UI와 저장 경계를 사용한다.
Monaco의 native undo stack만 사용하면 visual command를 되돌릴 수 없고, visual command의 inverse operation만
만들면 invalid source와 source-only construct를 동일하게 복구할 수 없다. 반대로 모든 undo를 durable
checkpoint로 만들면 사용자가 짧은 편집을 되돌릴 때마다 pruning되지 않는 revision이 계속 쌓인다.

SQLite에는 이미 source snapshot을 가진 schema revision과 revision restore endpoint가 있다. 그러나 durable
revision 목록은 재시작 이후의 감사·복구 경계이고, 사용자가 현재 browser session에서 기대하는 선형
undo/redo cursor와 수명이 다르다. Layout은 canonical DBML과 분리된 sidecar이므로 schema history에 함께
포함하면 위치 이동만으로 schema redo가 무효화되거나 과거 schema restore가 현재 layout을 예기치 않게
덮어쓸 수 있다.

## Decision

Web은 project별 `SchemaHistorySession`을 memory에 유지한다. Session stack은 실제 schema revision을 만든
source autosave batch, 적용된 visual command와 사용자가 명시한 revision restore를 하나의 선형 history로
기록하며 project별 최대 100단계다. 각 step은 before/after의 revision number, source, source hash, validity와
origin을 보관한다. Browser reload, workspace 재생성, stale refetch 또는 외부 state adoption에서는 stack을
복원하지 않고 초기화한다.

다음 기록 규칙을 적용한다.

- Debounce 동안 합쳐져 실제 `SOURCE_EDIT` revision 하나를 만든 source save를 한 단계로 기록한다.
- 실제 source를 변경해 `VISUAL_COMMAND` revision을 만든 command를 한 단계로 기록한다.
- Semantic no-op, 이미 현재 history에 반영된 visual command receipt replay와 layout-only mutation은 기록하지
  않는다. 최초 response만 유실된 뒤 same-ID replay가 `expected + 1`의 실제 적용을 증명하면 원래 visual
  command step을 정확히 한 번 기록한다.
- 새 source edit, visual command 또는 manual restore가 commit되면 redo stack을 비운다.
- 가장 최근 100단계를 넘으면 가장 오래된 session step부터 제거한다. 이 제한은 SQLite의 durable revision
  retention과 별개다.
- History controller가 authoritative source를 채택하는 동안 source·visual commit observer의 중복 기록을
  억제한다.
- Receipt replay의 최초 applied revision보다 current revision이 앞서 있어 기존 선형 순서를 증명할 수 없으면
  replay를 새 step으로 만들지 않고 session stack을 초기화한다.

Undo와 redo는 inverse visual command나 과거 receipt를 재사용하지 않는다. Current source 위에 목표 step의
before 또는 after source를 기존 draft-save endpoint로 저장한다. 이 결과는 새 `SOURCE_EDIT` revision이며
일반 source edit와 같이 pruning 대상이다. Operation은 다음 순서를 지킨다.

1. Workspace와 visual inspector의 schema interaction을 잠근다.
2. Dirty source를 먼저 flush해 필요한 경우 현재 edit를 하나의 committed step으로 만든다.
3. Hydrated layout write를 모두 flush한다. Layout error 또는 conflict가 있으면 schema write를 시작하지 않는다.
4. 새 command ID와 current expected schema revision으로 목표 source를 저장한다.
5. Response의 project, source, hash, parser provenance와 revision 전이를 검증하고 Monaco, parser session과
   server-state cache에 authoritative state를 적용한다.
6. Commit이 확인된 뒤에만 past/future stack cursor를 이동한다.

Invalid source snapshot도 undo·redo 대상이다. Invalid source를 저장하면 기존 last-valid pointer를 유지하고
diagram은 last-valid graph를 계속 표시한다. Current source가 다시 valid해질 때까지 visual command와
current-source navigation을 차단하는 기존 정책은 바꾸지 않는다.

Durable History dialog는 기존 source-free revision summary만 최신순으로 표시한다. Revision number, validity,
origin, timestamp, parser version, diagnostic count와 source hash를 제공하지만 과거 source preview·diff API는
추가하지 않는다. Current revision만 restore를 비활성화한다. 현재 draft와 source가 같은 과거 revision도
durable `RESTORE` checkpoint를 만들 수 있지만 schema snapshot 변화가 없으므로 session undo step은 만들지
않고 redo만 비운다. Invalid revision도 restore할 수 있으며 이때 last-valid diagram 유지와 layout 미복구를
확인 UI에 명시한다.

사용자가 revision을 명시적으로 restore할 때만 기존 restore endpoint를 호출해 pruning되지 않는 `RESTORE`
checkpoint를 만든다. Source가 바뀌는 manual restore는 현재 session의 새 forward step이므로 redo stack을
비우고, 같은 session에서는 새 checkpoint 전 상태를 일반 undo로 다시 저장할 수 있다. 동일-source restore도
redo를 비우지만 undo step을 만들지 않는다. Restore 성공 후 source session과 project detail/list/revision
cache는 server response를 기준으로 갱신한다.

Commit 여부를 알 수 없는 transport failure는 command ID, expected revision과 목표 payload를 보존하고
사용자의 `Retry safely`에서만 같은 request를 재전송한다. Retry가 `409`이면 latest project를 읽어
`expected + 1` revision, 목표 source hash와 예상 origin이 모두 일치할 때만 앞선 요청의 성공으로 확정한다.
그 밖의 schema conflict 또는 외부 write는 latest state를 채택하고 session stack을 초기화한다. 이후 복구는
durable History에서 다시 선택한다.

Mounted workspace의 project detail query는 focus 또는 network reconnect만으로 passive refetch하지 않는다.
External write는 schema/layout CAS conflict에서 latest state를 명시적으로 읽고 source session, layout revision,
query cache와 history stack을 함께 전환한다. 이는 header만 새 revision을 표시하고 editor는 이전 revision을
유지하는 split-brain UI를 막는다.

Layout revision은 session schema stack에 포함하지 않고 layout-only write는 schema redo를 비우지 않는다.
Undo·redo 또는 restore 전에 pending layout을 flush할 뿐이며 과거 schema를 채택해도 과거 layout snapshot을
복구하지 않는다. Current stable key에 남아 있는 layout과 기존 rename recovery만 적용한다.

## Alternatives considered

### Undo cursor를 SQLite에 영구 저장

Reload 이후에도 같은 cursor를 제공할 수 있지만 browser별 cursor, revision pruning과 외부 write 이후의 분기
정책이 durable data model에 들어간다. P0 single-user workflow에는 source snapshot revision과 명시적 restore가
재시작 복구를 충분히 제공하므로 session cursor는 memory에 둔다.

### Visual command별 inverse command 생성

Visual command만으로 source 직접 편집, invalid source와 source-only DBML construct를 복구할 수 없다. Rename과
delete의 inverse도 과거 source context와 layout collision에 의존한다. Canonical source snapshot을 다시
authoritative draft-save 경계로 검증하는 방식이 두 편집 경로에 동일한 의미를 제공한다.

### 모든 undo·redo를 `RESTORE` checkpoint로 저장

모든 작업을 영구 보존하지만 짧은 session edit마다 pruning되지 않는 checkpoint가 누적된다. 일반 undo·redo는
`SOURCE_EDIT` revision으로 남기고 사용자가 History에서 명시적으로 선택한 restore만 checkpoint로 구분한다.

### Schema와 layout을 하나의 undo stack으로 관리

node 위치·collapse는 schema semantics가 아니며 별도 optimistic revision을 사용한다. Camera viewport는
session-only라 revision이나 restore 대상이 아니다. Layout을 schema history와 함께 되돌리면
layout-only gesture가 schema redo를 무효화하고 과거 schema restore가 현재 사용자의 배치를 덮어쓴다.

## Consequences

- Source editor와 diagram은 같은 revision 단위 undo/redo 순서를 사용한다.
- Undo와 redo도 새 durable revision을 만들므로 서버 history는 선형이고 crash 후 마지막 commit을 복구할 수
  있다. 다만 session cursor 자체는 reload 후 비어 있다.
- 최대 100개의 before/after source snapshot을 project별 browser memory에 보관한다. Durable revision 목록은
  source를 포함하지 않아 history UI와 API payload에서 과거 schema 내용을 반복 노출하지 않는다.
- Manual restore는 장기 복구 지점을 남기지만 layout까지 time travel하지 않는다.
- External write 이후 자동 history 재구성을 시도하지 않으므로 잘못된 source를 저장할 위험은 줄지만 사용자는
  durable History에서 복구 지점을 다시 선택해야 한다.
- Persistent undo stack, layout undo/redo, historical source preview/diff와 SQL import 화면 내부 undo는 P0의 이
  결정에 포함하지 않는다.

## Verification

- Source save, visual command와 source-changing manual restore가 하나의 순서로 기록되고 100단계에서 오래된
  step이 제거되며 동일-source restore는 checkpoint만 만드는지 검사한다.
- Dirty source flush, layout flush와 history source save의 호출 순서 및 실패 시 non-call을 검사한다.
- Undo·redo가 새 `SOURCE_EDIT` revision을 만들고 self-record, no-op, 이미 반영된 receipt replay와 layout-only
  mutation을 제외하며 response 유실 뒤 최초 적용 replay는 한 번만 복구하는지 검사한다.
- Invalid snapshot의 undo·redo·restore가 source를 보존하고 last-valid graph pointer를 유지하는지 검사한다.
- Unknown outcome safe retry와 외부 `409`에서 성공 판정 또는 session reset이 정확한지 검사한다.
- Keyboard shortcut, native form-field undo, accessible status와 restore confirmation focus를 browser에서
  검사한다.
- Reload 후 undo·redo는 비어 있지만 source-free durable History와 `RESTORE` checkpoint가 유지되는지 검사한다.
- 실제 Monaco·parser worker·React Flow·ELK browser gate에서 source edit와 visual edit의 undo/redo,
  redo invalidation, layout-only redo 보존, invalid draft와 last-valid diagram을 함께 검사한다.
- Commit 후 response 유실은 같은 command ID의 explicit replay로만 복구하고 external `409`는 form draft를
  보존한 재검토와 새 command ID를 요구하며 session stack을 초기화하는지 확인한다.
