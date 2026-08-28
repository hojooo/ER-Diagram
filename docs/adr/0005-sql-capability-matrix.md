# ADR 0005: SQL capability target과 observed evidence

- 상태: `ACCEPTED`
- 결정일: 2026-08-28
- 적용 범위: P0 PostgreSQL·MySQL SQL interchange

## Context

PostgreSQL·MySQL parser가 SQL 문장을 오류 없이 받아들이는 것만으로는 DBML 변환에서 의미가
보존됐다고 판단할 수 없다. Pinned DBML importer는 일부 option을 정규화하거나 버리고, 지원하지 않는
statement도 빈 schema 또는 setup table만 남긴 채 성공할 수 있다. 제품 목표와 현재 parser가 증명한
수준을 하나의 상태로 표현하면 아직 달성하지 못한 요구를 현재 보장처럼 노출하거나 silent loss를
놓치게 된다.

## Decision

`packages/core`가 versioned SQL capability matrix를 parser-neutral 공개 계약으로 소유한다.

- 각 capability는 PostgreSQL과 MySQL에 대해 `targetStatus`, `observedStatus`,
  `observedOutcome`을 가진다.
- `targetStatus`는 PRD가 요구하는 P0 목표다. 이를 변경하려면 PRD 변경을 동반한다.
- `observedStatus`와 `observedOutcome`은 pinned `@dbml/core`·`@dbml/parse` 9.1.1 fixture가
  `SQL → importer → DBML → DBML v2 SchemaGraph` 경로에서 증명한 결과다.
- 현재 사용자에게 보장하는 수준과 M2-002 conversion report의 초기 분류는
  `observedStatus`를 기준으로 한다.
- Dialect에 존재하지 않는 capability는 matrix에서만 `NOT_APPLICABLE`로 표현한다. 반대 dialect
  문법을 실제 입력하면 runtime parse `ERROR`가 될 수 있으며, `ConversionStatus`에는
  `NOT_APPLICABLE`을 추가하지 않는다.
- Parser가 입력을 수용해도 construct가 generated DBML에서 제거되면 `DROPPED` evidence로
  기록한다. Parser success를 제품 지원으로 승격하지 않는다.
- Matrix entry는 stable ID 순서의 plain data이며 parser object, SQL source와 사용자 번역 문구를
  포함하지 않는다.
- Parser version, observed status 또는 의미 있는 observed outcome이 바뀌면 matrix version과
  fixture version을 같은 PR에서 갱신한다. Golden DBML hash와 semantic graph hash도 함께
  재검토한다.

Version 1에는 다음 P0 capability gap이 있다.

| Capability | Target | Observed | 손실 |
| --- | --- | --- | --- |
| PostgreSQL identity | `NORMALIZED` | `PARTIAL` | `ALWAYS`와 sequence option이 소실되고 export 의미가 `BY DEFAULT`로 축소될 수 있다. |
| PostgreSQL schema-qualified enum array | `EXACT` | `PARTIAL` | generated DBML·SQL type projection에서 schema/type 이름이 중복된다. |

이 gap은 숨기거나 목표를 낮추지 않는다. 후속 importer orchestration은 사용자에게 관찰된 수준을
보고하고, 목표를 만족시키는 adapter가 검증되면 fixture evidence와 matrix version을 갱신한다.

## Alternatives considered

### Parser 문서만 capability 기준으로 사용

문법 acceptance 범위는 알 수 있지만 importer가 의미를 정규화하거나 제거하는 동작을 증명하지 못한다.

### 목표와 현재 관찰을 하나의 status로 표현

계약은 단순하지만 목표 미달을 숨기거나 현재보다 낮은 목표로 PRD를 오염시킨다.

### `NOT_APPLICABLE`을 `ConversionStatus`에 추가

정적 dialect 비교에는 유용하지만 실제 입력 처리 결과가 아니다. Runtime report의 다섯 상태와
matrix metadata를 분리하는 편이 사용자 의미가 명확하다.

### Silent drop fixture를 `ERROR`로 기록

Raw importer는 오류를 반환하지 않았으므로 관찰 사실과 다르다. `observedStatus`와
`observedOutcome: DROPPED` 조합으로 parser 결과와 제품 보장을 함께 보존한다.

## Consequences

- 목표와 현재 보장을 독립적으로 검토할 수 있고 capability gap이 CI에서 가시적으로 유지된다.
- Dependency upgrade는 parser version 변경만이 아니라 SQL compatibility event로 취급한다.
- M2-002는 statement·clause source range와 diagnostic을 추가하되 초기 status를 observed matrix에서
  가져온다.
- DML이 DBML `Records`를 만드는 raw importer 동작도 evidence로 남지만 schema import 지원으로
  간주하지 않는다.
- Matrix는 DB version을 자동 감지하지 않는다. PostgreSQL 14와 MySQL 8.0은 검증 baseline이며
  version-specific 판단이 없는 경우 이를 명시한다.

### M2-002 ConversionReport 경계

- Dependency-free SQL source analyzer는 comment, quote, PostgreSQL dollar quote, MySQL routine block과
  괄호 depth를 추적해 statement·clause range와 capability evidence를 만든다. SQL 문법 acceptance는
  계속 pinned dialect parser가 담당하며 analyzer success가 parser success를 대신하지 않는다.
- Parser에는 원본 source를 수정 없이 한 번 전달하고 그 model을 `includeRecords: false`로 DBML export한다.
  Raw importer의 두 번째 SQL parse 경로는 사용하지 않는다.
- Analyzer가 catalog에 없는 construct를 발견하면 parser acceptance 여부와 무관하게 `UNSUPPORTED`로
  fail-closed 분류한다. 반대 dialect가 parser에서 거부되면 runtime `ERROR`다.
- SQL model A는 source token이 없으므로 가짜 range를 가진 `SchemaGraph`로 만들지 않는다. 대신 기존
  schema semantics의 internal canonical document로 직접 투영하고, candidate DBML graph B와 stable-key
  diff를 수행한다.
- Generated expression, partial-index predicate, table option과 identity option처럼 parser model 이전에
  소실된 정보는 capability report가 설명한다. PostgreSQL schema-qualified enum array처럼 exporter의
  known projection loss는 versioned adapter normalization으로 모델링한다. 그 밖의 A/B 차이는 candidate를
  차단하는 internal semantic mismatch다.
- Conversion report에는 SQL source, literal과 native parser message를 넣지 않는다. Source hash, static
  code·message, UTF-16 range와 semantic mismatch의 stable element change만 보존한다.
- DML/COPY가 있어도 row data를 제외한 candidate는 preview 증거로 반환할 수 있지만 자동 적용할 수 없다.
  명시적 DDL-only 승인과 original SQL retention은 후속 workflow 경계가 소유한다.

### M2-003 data exclusion과 retention 경계

- `ConversionReport` version 1과 `applyEligible`은 conversion 사실로 유지하며 사용자 확인에 따라 값을
  변경하지 않는다. DML/COPY 승인 결과는 별도 versioned data policy의 `applyReadiness`로 표현한다.
- Data policy는 source를 다시 작성하거나 client가 전달한 report를 신뢰하지 않고 같은 원본으로
  conversion을 다시 수행한다. `CONFIRM_DDL_ONLY`는 record-free candidate를 변경하지 않고 적용 승인만
  해제한다.
- Parser에는 원본 SQL을 그대로 전달해 `sourceHash === parserInputHash`를 유지한다. PostgreSQL
  `COPY FROM STDIN` inline dump처럼 pinned parser가 거부하는 입력은 payload를 제거해 복구하지 않고
  parse error로 차단한다.
- Original SQL은 `DISCARD`가 기본값이며 `RETAIN`일 때만 persistence 전용 입력에 전체 원문을 포함한다.
  Report, diagnostics와 candidate는 retention 여부와 관계없이 row literal을 포함하지 않는다.
- JavaScript parser의 일시적 memory를 zeroize한다고 주장하지 않는다. Configurable source size와 parser
  timeout은 별도 resource-limit 경계가 담당한다.

### M2-004 preview evidence와 authoritative Apply 경계

- Preview는 project ID, base schema revision, dialect, source/candidate hash, 전체 versioned report, initial
  `REJECT` policy와 retention mode를 canonical JSON으로 만든 뒤 SHA-256 evidence hash를 계산한다.
- Conversion 실패도 candidate가 없는 `FAILED` artifact로 저장하고 HTTP adapter에서는 report를 포함한
  성공 response로 다룬다. Preview만으로 canonical DBML, schema revision 또는 layout을 변경하지 않는다.
- Apply는 client가 보낸 source를 artifact dialect로 다시 parse하고 report, record-free candidate와 preview
  hash를 재생성한다. Stored report나 candidate를 신뢰해 parse를 건너뛰지 않는다.
- `CONFIRM_DDL_ONLY`는 Apply 시점의 사용자 승인이고 source·conversion evidence가 아니므로 preview hash
  preimage에 포함하지 않는다. 승인 후에도 `ConversionReport.applyEligible=false`는 그대로 유지하고
  별도 data policy만 `READY`로 바뀐다.
- Stored envelope, row dialect, original/candidate hash 또는 status 조합이 다르면 fail-closed invariant로
  처리한다. Response와 error에는 original SQL, row literal, internal graph와 SQLite 원인을 포함하지 않는다.
- Successful Apply는 candidate가 current draft와 같아도 `SQL_IMPORT` checkpoint를 하나 만들며 revision,
  project pointer, artifact transition과 pruning을 원자적으로 저장한다.

### M2-005 stateless create preview와 UI 확인 경계

- 새 project preview는 project identity와 revision이 없는 stateless conversion이다.
  `SQL_IMPORT_CREATE_PREVIEW_VERSION=1` evidence는 dialect, source/candidate hash, versioned report, initial
  `REJECT` policy와 retention mode를 포함한다. Project name과 Apply 시점의 `CONFIRM_DDL_ONLY`는 conversion
  evidence가 아니므로 hash preimage에서 제외한다.
- Apply는 SQL을 다시 parse해 stateless evidence를 재생성하고 name, schema element와 data policy를 검증한
  뒤에만 project 생성 transaction을 시작한다. Failed/cancelled preview는 artifact를 남기지 않고 successful
  Apply만 direct `APPLIED` create-project artifact를 만든다.
- UI는 `PARTIAL`·`UNSUPPORTED` 손실 확인과 DML/COPY 제외 확인을 서로 다른 acknowledgement로 받는다.
  이 확인은 runtime policy를 해제할 뿐 `ConversionReport.applyEligible`이나 preview evidence를 바꾸지 않는다.
- SQL source와 candidate는 component local state에만 유지한다. Query cache, URL, log, error response에 raw
  SQL이나 row literal을 넣지 않으며 browser semantic diff 실패는 server-side semantic verification을
  무효화하지 않는다.

## Verification

- `pnpm --filter @er-diagram/test-fixtures test test/sql-capability-fixtures.test.ts`
- `pnpm --filter @er-diagram/core test test/sql-capabilities.test.ts`
- 모든 applicable matrix cell은 하나 이상의 atomic fixture와 양방향으로 대응해야 한다.
- Generated DBML hash, normalized graph hash, semantic inventory와 preserved/dropped construct를 함께
  검증해야 한다.
- Wrong-dialect fixture는 static status가 아니라 parser error 위치를 검증해야 한다.
- `pnpm --filter @er-diagram/test-fixtures test test/sql-import-report-fixtures.test.ts`
- `pnpm --filter @er-diagram/core test test/sql-import.test.ts`
- `pnpm --filter @er-diagram/core test test/data-exclusion.test.ts`
- `pnpm --filter @er-diagram/core test test/application/sql-import.test.ts`
- `pnpm --filter @er-diagram/storage-sqlite test test/sql-import-repository.test.ts`
- `pnpm --filter @er-diagram/server test:integration sql-import`
