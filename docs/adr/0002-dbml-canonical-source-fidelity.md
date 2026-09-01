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

View별 position, viewport, detail level, collapsed group key와 hidden element key는 같은 view key의 durable
layout sidecar가 소유한다. 일반 hydration, view·LOD·collapse 전환은 ELK를 호출하지 않는 deterministic
Derived layout을 사용한다. Target view의 저장 위치를 우선하고 current stable projection의 absolute 위치를
stable key별로 재사용한다. Parent group이 바뀐 table은 target group 상대 좌표로 변환하고 visible child로
compound bounds를 다시 계산한다. 위치가 없는 node는 stable-key 순 collision-free grid에 배치한다. Derived
position은 자동 저장하지 않으며 사라진 key의 위치는 recovery를 위해 저장 row에서 즉시 제거하지 않는다.
View key가 source에서 삭제되면 browser session 상태는 폐기하되 stale SQLite row 정리는 별도 lifecycle
작업으로 남긴다.

`baseSchemaHash`는 layout provenance이며 mismatch 자체로 저장이나 복구를 거부하지 않는다. Exact HIGH
table/column rename candidate만 새 key에 position과 hidden state를 복사하고 old key는 유지한다. Ambiguous
candidate와 key 충돌은 자동 적용하지 않는다. M3 visual rename에서 모든 view row를 atomic migration하는
정책과 구분한다.

ELK worker는 명시적인 Auto-layout Preview와 Reset에서만 실행한다. Auto-layout preview는 current durable
layout을 먼저 baseline으로 flush한 뒤 별도 generation에서 실행한다.
Preview 중 graph, view, collapse, LOD와 drag 변경을 잠그고 graph가 바뀌면 결과를 폐기한다. Apply만 preview
position과 viewport를 저장하며 Cancel은 추가 write 없이 exact baseline을 다시 표시한다. Reset은 current
view의 position, viewport, collapse, hidden state와 LOD 전체를 fresh ELK 결과로 교체하고 worker 또는 save가
실패하면 기존 durable row를 보존한다.

Visual schema mutation의 public contract는 `commandId`, positive `expectedSchemaRevisionNo`와 explicit
`kind`를 가진 strict discriminated union이다. Command target은 parser object나 source offset이 아니라
normalized graph의 kind-qualified stable key로 지정한다. Table·column rename은 일반 update patch에
숨기지 않고 별도 command로 표현해 key 변경과 후속 layout migration을 명시적으로 처리할 수 있게 한다.
그 밖의 update는 non-empty `changes` patch만 허용하고, create는 현재 visual catalog가 소유하는 값을
명시적으로 전달한다.

이 wire contract는 canonical source를 소유하거나 domain correctness를 확정하지 않는다. Zod는 variant
shape, key kind prefix와 command-local 구조를 검증하고, target 존재·owner 관계·이름 충돌·partial
provenance·dialect capability는 current graph resolve와 application 단계에 남긴다. 검증된 command도
source-position `TextEdit`, DBML v2 full reparse와 expected semantic diff가 모두 통과해야만 canonical
source를 변경할 수 있다.

Visual mutation은 source position을 기준으로 가장 작은 `TextEdit[]`를 만든다. Edit는 offset 내림차순으로 적용하고 수정된 전체 source를 DBML v2로 다시 parse한다. Reparse 결과의 semantic diff가 command가 기대한 변경과 정확히 일치할 때만 source를 commit한다. 실패하면 원본을 유지하고 diagnostic을 반환한다.

Table·column command의 source patch는 token-aware fragment scanner를 사용한다. Scanner가 quoted
identifier, string, triple-quoted note, backtick expression, comment와 bracket nesting을 확정하지 못하면
수정하지 않는다. 기존 setting은 value span만 바꾸어 key spelling, comma spacing과 quote style을 보존하고,
없는 setting이나 새 declaration만 canonical form으로 추가한다. 이 경계에서는 parser warning count도
늘어나지 않아야 한다.

Table rename은 pinned `@dbml/core.renameTable()`을 사용하되 결과 전체를 정본으로 채택하지 않는다.
원본과 official output 사이에서 line structure를 보존하는 최소 UTF-16 edit를 만들고, 변경이 target table,
parser-resolved Ref endpoint, `TableGroup` membership과 `DiagramView` table filter range 안에만 있는지
검증한다. Column rename은 declaration, ordered Ref endpoint와 column index term만 구조적으로 갱신한다.
Check, expression index와 expression default 같은 opaque expression에 target identifier가 있으면 자동
rewrite하지 않고 source-only 진단으로 차단한다.

Pinned DBML v2 grammar가 empty table을 거부하므로 `CREATE_TABLE` command는 unique한 초기 column 한 개
이상을 함께 생성한다. `TablePartial` 주입 column은 definition range와 injection range가 다른 provenance를
가지므로 local edit target과 reorder anchor로 사용하지 않는다. Delete는 외부 Ref·index·group·명시적 view
filter 또는 opaque expression dependency를 자동 cascade하지 않으며, semantic no-op은 빈 edit와 빈 diff로
성공한다.

Reference·index·check patch도 같은 verified transform pipeline을 사용한다. Inline `ref`는 anonymous
single-column이며 standalone setting이 필요 없는 동안만 inline으로 유지하고, 그 범위를 넘는 update는
정확한 repeated `ref` occurrence를 제거한 뒤 standalone `Ref`로 materialize한다. Repeated column `check`
setting도 target occurrence만 수정하고 sibling setting은 byte-identical하게 유지한다.

Anonymous index/check의 semantic signature가 중복되면 occurrence ordinal이 edit 후 재배치될 수 있으므로
visual mutation을 차단한다. Pinned grammar가 표현하지 못하는 non-public top-level Ref, named column check,
expression primary index와 안전하게 quote할 수 없는 expression도 capability diagnostic으로 source editor에
위임한다. Mixed index term은 pinned parser가 expression을 column보다 앞으로 정규화하므로 visual command가
요구한 ordered term을 보존할 수 있는 expression-first 조합만 허용한다. 모든 실제 change는 target element의
ADD/DELETE/UPDATE closure와 정확히 일치하고 rename candidate나 새 warning을 만들지 않아야 한다.

`TableGroup` membership은 normalized graph와 source declaration이 일대일로 대응할 때만 strict add/remove
delta를 적용한다. 이미 존재하는 membership의 add, 존재하지 않는 membership의 remove와 다른 group에 이미
속한 table의 add는 충돌로 처리한다. 신규 membership만 schema-qualified canonical identifier로 만들고 기존
member, leading comment, note, color와 metadata는 그대로 둔다.

`syncDiagramView`는 source 정본을 소유하지 않는 검증용 candidate다. 완전한 desired view를 공식 API에
전달하되 결과가 item-level local patch와 byte-identical하여 comment, formatting과 요청하지 않은 filter를
보존할 때만 채택한다. 그렇지 않으면 target filter의 entity token만 수정하는 local patch로 fallback한다.
두 경로 모두 full reparse와 target view field allowlist를 통과해야 하며 `[]`, non-empty, `null` tri-state가
달라지면 rollback한다.

주입 element 보호는 provenance를 단순 boolean으로 축약하지 않는다. Partial element definition range와
해당 partial을 주입한 모든 table의 injection range가 source map과 일치할 때만 결정론적으로 정렬된 impact를
반환한다. 누락되거나 서로 다른 injection range를 하나로 추정하지 않으며, 이러한 불일치는 source range
오류로 fail-closed 처리한다. Partial definition 자체는 canonical source editor에서만 변경한다.

Explicit table/column visual rename의 exact HIGH candidate는 모든 stored view layout에 같은 schema
transaction으로 적용한다. Old position과 hidden key는 recovery를 위해 남기고 new key에 값을 복사한다.
New key에 다른 position이 이미 있으면 임의 overwrite하지 않고 source revision과 receipt까지 전부
rollback한다. Rename 전 `baseSchemaHash`와 일치하는 row만 rename 후 hash로 전진시키며 이미 stale한
provenance는 유지한다. 여러 row가 바뀌어도 하나의 project-global layout revision만 사용한다.

Web visual inspector는 source나 layout의 또 다른 정본이 아니다. Command 전 source save·validation과 모든
pending layout write를 flush하고, form을 연 시점의 semantic hash와 최종 current-draft hash가 같을 때만
새 command ID를 만든다. 성공 결과는 browser에서 `TextEdit`를 재실행하지 않고 server가 반환한
authoritative source·revision으로 Monaco와 parser session을 교체한다. Server가 explicit rename layout
migration을 보고하면 hydrated view를 새 revision으로 reload하고 기존 client-side rename recovery는 생략한다.

Commit 여부를 알 수 없는 transport failure는 exact payload와 command ID를 보존한 explicit replay만 허용한다.
반대로 schema `409`는 최신 state에서 target 의미가 달라졌을 수 있으므로 자동 replay하지 않고 form을
stale하게 잠근 뒤 재검토 시 새 command ID를 발급한다. Source fallback은 public diagnostic range,
current target range, editor focus 순서로만 수행하며 위치가 없는 오류를 임의의 source 위치로 가장하지
않는다. Partial provenance가 있으면 definition과 모든 injection range를 독립적으로 탐색하되 local element
mutation으로 우회하지 않는다.

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
- Versioned M3 gate corpus에서 20종 visual command를 각각 한 번 실행하고 매 단계의 최소 edit 재현,
  source/schema hash, semantic diff closure와 unrelated comment·metadata·partial·view byte 보존을 확인한다.
- Compact CRLF corpus뿐 아니라 143-table fidelity fixture의 대표 edit에서도 target table 밖 bytes와
  `143/86/4/15/7/573` inventory가 유지되며, test-only unexpected edit는 semantic mismatch로 rollback되어야 한다.
