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
- Parser upgrade는 source rewrite가 아니라 explicit revalidation event가 된다.
- Source transformer는 command별로 안전한 insertion/update range와 formatting rule을 구현해야 한다.
- Source 직접 편집에서 rename을 확신할 수 없으면 layout identity는 delete+create로 처리할 수 있다.

## Verification

- `TablePartial`, `TableGroup`, `DiagramView`, comment, metadata fixture가 legacy fallback 없이 parse되어야 한다.
- 입력 hash와 parser 전달 hash가 일치해야 한다.
- column 추가 뒤 expected semantic diff만 발생하고 unrelated source가 byte-identical이어야 한다.
- reparse 또는 semantic verification 실패 시 canonical source가 바뀌지 않아야 한다.
