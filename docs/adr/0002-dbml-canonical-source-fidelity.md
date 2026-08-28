# ADR 0002: DBML canonical source와 source fidelity

- 상태: `ACCEPTED`
- 결정일: 2026-08-26
- 적용 범위: P0

## Context

DBML은 table과 reference뿐 아니라 comment, note, `TablePartial`, `TableGroup`, `DiagramView` 같은 source-level construct를 포함한다. Normalized graph 전체를 다시 export해 visual edit를 반영하면 parser가 이해한 schema 의미는 비슷해도 원래 formatting, comment, 선언 순서 또는 source-only construct가 손실될 수 있다. Source editor, diagram, SQL interchange가 각자 정본을 가지면 충돌 해결도 불가능해진다.

## Decision

표준 DBML text만 schema semantics의 canonical source로 사용한다. Normalized `SchemaGraph`, SQL output, search index와 diagram edge는 파생물이며 layout·viewport·collapse state는 별도 sidecar다.

Parser adapter는 다음 계약을 지킨다.

- `@dbml/core`와 `@dbml/parse`의 exact version과 DBML v2 path를 사용하며 legacy parser로 fallback하지 않는다.
- Live schema fetch API를 노출하는 `@dbml/connector`는 P0 runtime·direct dependency에서 제외한다.
- parser에 전달한 text의 hash가 입력 source hash와 같아야 한다. 문법 제거를 위한 regex 전처리를 허용하지 않는다.
- parser object를 외부로 노출하지 않고 parser-neutral graph와 명시적 result로 변환한다. 성공과 실패 result 모두 입력 source hash와 diagnostics를 제공한다.
- public source range는 UTF-16 half-open offset이며 line과 column은 1부터 시작한다.
- stable element key는 parser object identity가 아니라 kind, namespace, qualified name, element path를 정규화한 canonical JSON representation을 사용한다.

Canonical semantic projection은 별도 version을 가지며 version 1의 hash preimage를 `{ version, elements, orders }`로 고정한다. Element는 stable key를 기준으로 flat record가 되고 nested element는 실제 parent key를 가진다. `schemaHash`, parser version, diagnostics, source map, source range와 filepath는 의미에서 제외한다. 반면 note, expression, metadata, default를 포함한 normalized graph의 실제 의미 값은 포함한다. Object key와 결과 순서는 locale에 의존하지 않는 code-unit 순서로 정렬하고 SHA-256 lowercase hex를 생성한다.

순서는 문법별 의미에 따라 처리한다.

- top-level 선언, sibling index/check, group membership, view visibility와 table partial membership 순서는 무시한다.
- table·partial column, enum value, index term, reference endpoint와 composite endpoint column 순서는 보존한다.
- column 또는 enum value sequence가 바뀌면 child 변경과 별도로 parent의 `columnOrder` 또는 `valueOrder` 변경을 보고한다.

Source 직접 편집의 rename은 diff 결과와 분리된 advisory candidate다. 같은 schema의 table 또는 같은 table의 column에서 이름과 identity-relative key를 제외한 전체 구조가 양쪽에서 각각 하나만 정확히 일치할 때만 `HIGH` confidence 후보를 만든다. 후보가 있어도 원래 ADD와 DELETE를 제거하거나 자동 `RENAME`으로 바꾸지 않는다. Ambiguous match, owner 이동, rename과 동시에 발생한 구조 변경은 rename으로 추론하지 않는다.

Monaco model은 project별 in-memory URI를 사용하는 browser session의 ephemeral buffer다. Model 자체를
정본이나 durable undo history로 간주하지 않으며 source, listener, marker와 editor instance는 workspace
unmount 시 함께 폐기한다. Browser parser는 별도 module worker에서 실행하고 request generation,
source hash, parser-input hash와 parser version이 현재 buffer와 모두 일치하는 결과만 반영한다. Worker
crash, timeout 또는 protocol 오류는 worker를 격리해 재생성하되 source autosave를 막지 않으며 server의
재검증과 revision transaction을 authoritative 결과로 유지한다.

Source autosave는 750 ms debounce 후 시작하고 write를 직렬화한다. 저장 중 추가 edit는 최신 source
하나로 합치며 성공 응답의 revision을 다음 write의 expected revision으로 사용한다. 응답의 project,
source, hash, parser version과 revision 전이가 요청과 일치하지 않으면 cache를 갱신하지 않는다. Stale
revision conflict에서는 local buffer를 보존하고 autosave를 멈춘 뒤 사용자가 최신 revision 기준 local
draft 재시도 또는 확인을 거친 server draft load를 선택한다. 저장되지 않은 buffer의 navigation은 먼저
pending save를 flush하고, 명시적 이탈 전에는 `Stay`를 기본으로 하는 확인 경계를 거친다.

Source와 diagram의 선택 상태는 normalized graph의 stable element key만 공유하고 project workspace
session에만 보관한다. Monaco cursor의 filepath와 UTF-16 offset은 현재 graph의 source map에서 가장 좁은
table, column 또는 reference range로 해석하며 diagram과 outline의 source action은 같은 key의 range
시작점으로 이동한다. Diagram layout은 graph에서 파생하고 layout generation이 지난 worker 응답은
폐기한다. 이 selection과 자동 layout 결과는 canonical source나 durable project state를 소유하지 않는다.

Invalid draft에서 표시하는 last-valid graph의 source range는 현재 Monaco buffer와 같은 source를
가리키지 않는다. 따라서 last-valid diagram과 outline의 stable-key 탐색은 허용하되 source 이동 action은
현재 draft가 다시 valid해질 때까지 차단한다. Current graph로 복구되면 새 source map으로 navigation을
재개하며 이전 graph에 없는 selection key는 폐기한다.

`TableGroup` collapse는 canonical DBML이나 semantic hash가 아니라 layout sidecar에 속한다. M1-010의
Workspace에서는 project session의 ephemeral state로 관리하고, group stable key가 graph에 남아 있는
동안만 유지한다. Compound parent, hidden member table과 relationship summary edge는 매 graph와 collapse
상태에서 다시 계산하는 파생 데이터이며 source revision이나 autosave를 발생시키지 않는다.

접힌 group의 외부 relationship은 방향이 정해진 representative endpoint와 active/inactive 상태별로
집계한다. 같은 접힌 group 안의 relationship은 canvas에서 숨겨도 accessible outline의 exact relationship
목록에는 보존한다. 여러 relationship을 대표하는 aggregate edge는 특정 reference identity를 임의로
선택하지 않으며 source 이동을 제공하지 않는다. Exact source 탐색은 outline을 사용하고, 선택된 hidden
reference는 aggregate edge와 representative group을 강조하는 데만 사용한다.

`DiagramView` visibility projection, current-view search index, visible inventory와 focus target은 normalized
graph와 현재 view filter에서 매번 재생성하는 파생 데이터다. View 전환이나 검색은 parser를 다시
호출하거나 canonical source와 schema revision을 변경하지 않는다. 현재 view에서 숨겨진 source symbol은
자동으로 다른 view에 노출하지 않고 사용자가 명시적으로 Global view로 전환한 경우에만 선택·focus한다.

M1-011의 view별 detail level과 collapsed group key는 workspace session 상태로 관리한다. Stable view/group
key가 유지되는 동안만 상태를 보존하고 삭제된 key는 폐기한다. 이 상태의 durable ownership은 M1-012에서
같은 view key의 layout sidecar로 옮기며 schema semantics의 정본으로 승격하지 않는다.

Visual mutation은 source position을 기준으로 가장 작은 `TextEdit[]`를 만든다. Edit는 offset 내림차순으로 적용하고 수정된 전체 source를 DBML v2로 다시 parse한다. Reparse 결과의 semantic diff가 command가 기대한 변경과 정확히 일치할 때만 source를 commit한다. 실패하면 원본을 유지하고 diagnostic을 반환한다.

M0에서는 `CreateColumn` 한 종류로 이 경계를 증명한다. 대상 block 밖의 comment, partial, view와 formatting은 byte-identical이어야 하며 full-model DBML regeneration은 canonical source 갱신 경로로 사용하지 않는다.

## Alternatives considered

### Normalized graph를 유일한 정본으로 사용

Visual mutation은 단순해지지만 DBML 원문 고유 정보가 모델에서 표현되지 않으면 저장 과정에서 조용히 사라진다.

### Source에 hidden persistent ID를 주입

Rename 추적은 쉬워지지만 표준 DBML 호환성을 깨뜨리고 사용자 source에 제품 전용 metadata를 강제한다.

### 정규식 기반 source patch

간단한 fixture에서는 동작할 수 있지만 quoted identifier, nested block, comment와 고급 문법에서 안전한 source range를 보장하지 못한다.

## Consequences

- Source fidelity와 semantic correctness를 각각 byte comparison과 normalized diff로 검증할 수 있다.
- Canonical semantics version 변경은 schema hash compatibility event이며 persistence 도입 이후에는 명시적 revalidation 또는 migration이 필요하다.
- Parser upgrade는 source rewrite가 아니라 explicit revalidation event가 된다.
- Source transformer는 command별로 안전한 insertion/update range와 formatting rule을 구현해야 한다.
- Source 직접 편집에서 rename을 확신할 수 없으면 layout identity는 delete+create로 처리할 수 있다.
- Browser editor와 worker 상태를 잃어도 canonical source와 durable revision은 server에서 복구할 수 있다.
- Revision conflict는 자동 overwrite보다 사용자 선택을 요구하므로 local edit 손실을 명시적으로 통제한다.

## Verification

- `TablePartial`, `TableGroup`, `DiagramView`, comment, metadata fixture가 legacy fallback 없이 parse되어야 한다.
- 입력 hash와 parser 전달 hash가 일치해야 한다.
- column 추가 뒤 expected semantic diff만 발생하고 unrelated source가 byte-identical이어야 한다.
- formatting, comment, filepath와 무의미한 선언 순서가 달라도 hash와 diff가 같아야 한다.
- exact·unique table/column rename만 advisory candidate가 되고 ADD/DELETE는 그대로 유지되어야 한다.
- reparse 또는 semantic verification 실패 시 canonical source가 바뀌지 않아야 한다.
- out-of-order worker/save 응답은 최신 Monaco buffer와 revision 기준을 덮지 않아야 한다.
- invalid draft, worker failure와 revision conflict에서도 local source가 보존되어야 한다.
