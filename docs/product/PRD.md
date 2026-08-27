# DBML·SQL ERD Studio PRD

- 문서 버전: `v0.5`
- 작성일: 2026-08-26
- 문서 상태: `Product Canonical — P0 Implementation Baseline`
- 제품 표시명: `DBML·SQL ERD Studio`
- 문서 정본: 이 파일이 이 저장소의 제품 요구사항 정본이다.
- Provenance: `v0.4`는 Digreed repository의 제품 탐색 문서에서 시작했다. 원래 문서는 provenance snapshot으로만 남으며 이 제품의 후속 결정은 이 파일에서 관리한다. Digreed의 `PRD.md`, `ERD.md`, `ERD.dbml` 제품·데이터 결정은 변경하지 않는다.
- 우선 배포 형태: 개인·내부용 single-user self-hosted Web
- P0 정본 형식: 표준 DBML
- P0 SQL dialect: PostgreSQL, MySQL
- P0 SQL 범위: DDL import/export. DB 연결과 SQL 실행은 제외한다.
- 후순위 범위: 실행하지 않는 `SELECT` query 분석과 lineage 시각화

## 1. 요약

`DBML·SQL ERD Studio`는 큰 DBML 스키마를 정확히 파싱하고, `TableGroup`과 `DiagramView`를 포함한 구조를 탐색하며, DBML 소스·다이어그램 배치·시각적 스키마 편집을 하나의 정합한 작업 흐름으로 제공하는 self-hosted 도구다.

P0에서는 PostgreSQL 또는 MySQL DDL을 DBML로 가져오고, DBML 정본에서 해당 dialect의 DDL을 생성한다. SQL은 실행하지 않으며 어떤 입력도 데이터베이스에 전달하지 않는다. SQL 변환은 완전한 왕복 보존을 약속하지 않고, 지원·정규화·부분 지원·미지원 항목을 변환 보고서로 공개한다.

사용자는 다음 세 가지 방식을 모두 사용할 수 있다.

1. DBML 소스를 직접 편집한다.
2. 다이어그램의 위치·접힘·숨김·view를 편집한다.
3. 다이어그램에서 table·column·relationship·기본 index/constraint를 생성·수정·삭제한다.

세 경로는 서로 다른 정본을 만들지 않는다. 스키마 의미의 유일한 정본은 DBML source이며, 다이어그램 위치와 개인화 상태는 DBML과 분리된 layout sidecar로 관리한다. 시각적 스키마 변경은 AST/source position 기반의 최소 `TextEdit`로 DBML에 반영하고 재파싱·semantic diff 검증까지 성공해야 커밋된다.

## 2. 배경과 문제

대규모 ERD는 단일 전체 화면으로는 탐색하기 어렵다. DBML은 table, enum, reference뿐 아니라 `TablePartial`, `TableGroup`, `DiagramView` 같은 구조화 문법을 제공하지만, 일부 도구는 이를 제거하거나 부분적으로만 해석한다. SQL 기반 도구도 DDL dialect 차이와 변환 손실을 명확히 보여주지 않는 경우가 있다.

현재 대표 검증 대상인 Digreed `ERD.dbml`은 다음 규모다.

| 항목 | 수량 |
| --- | ---: |
| `Table` | 143 |
| `Enum` | 86 |
| `TablePartial` | 4 |
| `TableGroup` | 15 |
| `DiagramView` | 7 |
| `Ref` | 573 |
| 파일 크기 | 약 199 KB |

이 규모에서는 다음 문제가 동시에 발생한다.

- 전체 graph의 node·edge가 많아 관계를 한눈에 파악하기 어렵다.
- group과 view를 지원하지 않으면 업무 Context별 탐색이 불가능하다.
- source 편집과 visual 편집이 서로 덮어쓰면 comment와 고급 DBML 문법이 손실될 수 있다.
- PostgreSQL과 MySQL DDL은 같은 개념도 type, auto increment, comment, index 문법이 다르다.
- SQL importer가 이해하지 못한 구문을 조용히 버리면 생성된 ERD를 신뢰할 수 없다.
- normalized model 전체를 DBML로 재생성하면 원문 formatting, comment 또는 source-only construct가 손실될 수 있다.

## 3. 확정된 제품 결정

| ID | 결정 | 상태 | 내용 |
| --- | --- | --- | --- |
| `DEC-001` | SQL 범위 | `CONFIRMED` | P0는 PostgreSQL·MySQL DDL import/export를 지원한다. SQL은 실행하지 않는다. |
| `DEC-002` | Query lineage | `CONFIRMED` | `SELECT` 정적 분석과 lineage는 P1로 후순위화한다. P1에서도 query를 실행하지 않는다. |
| `DEC-003` | 정본 | `CONFIRMED` | DBML source가 schema semantics의 유일한 정본이다. |
| `DEC-004` | 배포 | `CONFIRMED` | P0는 개인·내부용 single-user self-hosted Web이다. |
| `DEC-005` | SQL dialect | `CONFIRMED` | P0는 PostgreSQL과 MySQL project를 지원한다. |
| `DEC-006` | 편집 경로 | `CONFIRMED` | source 편집, layout 편집, visual schema 편집을 모두 제공한다. |
| `DEC-007` | DB 연결 | `CONFIRMED` | P0 및 P1에서 DB credential 저장, live introspection, SQL 실행을 제공하지 않는다. 재검토 시 별도 보안 Decision이 필요하다. |
| `DEC-008` | 표준 호환성 | `CONFIRMED` | P0는 custom DBML dialect를 만들지 않고 공식 DBML 문법으로만 정본을 표현한다. |
| `DEC-009` | project dialect | `CONFIRMED` | 한 project는 하나의 `primaryDialect`를 갖는다. P0는 같은 dialect import/export만 보장하고 cross-dialect 변환은 P1 후보로 둔다. |
| `DEC-010` | 저장 방식 | `CONFIRMED` | self-hosted server의 mounted volume과 embedded SQLite에 durable project data를 저장하고 portable bundle export를 제공한다. |
| `DEC-011` | source fidelity | `CONFIRMED` | visual edit는 관련 block 밖의 formatting·comment를 보존하고 변경·삽입 block만 canonical formatting을 적용한다. |
| `DEC-012` | revision retention | `CONFIRMED` | 최근 non-checkpoint revision 100개를 보존하고 import·restore·parser-migration checkpoint는 자동 pruning에서 제외한다. 보존된 history는 export할 수 있다. |
| `DEC-013` | remote access | `CONFIRMED` | P0는 localhost/private network를 기본으로 하며 remote 노출은 reverse proxy authentication을 운영자 책임으로 둔다. |
| `DEC-014` | dialect baseline | `CONFIRMED` | P0 검증 기준은 PostgreSQL 14 이상과 MySQL 8.0 이상이다. parser가 version 차이를 판별하지 못하면 warning을 표시한다. |
| `DEC-015` | 배포 모델 | `CONFIRMED` | source repository와 release image를 open source로 공개한다. 공개 release는 source tag·commit과 대응해야 한다. |
| `LICENSE-DEC-001` | 정확한 SPDX license | `CONFIRMED` | project source와 자체 산출물은 `Apache-2.0`으로 배포한다. third-party dependency는 각자의 license와 notice 의무를 유지한다. |

24장은 위 결정을 적용한 범위와 open-source release packaging 조건을 기록한다.

## 4. 제품 목표

### 4.1 P0 목표

1. 공식 DBML compiler가 지원하는 문법을 정규식 전처리 없이 파싱한다.
2. `TablePartial`, `TableGroup`, `DiagramView`를 손실 없이 읽고 탐색한다.
3. PostgreSQL·MySQL DDL을 DBML로 가져오고 변환 손실을 명시한다.
4. 유효한 DBML을 PostgreSQL·MySQL DDL로 내보낸다.
5. source·visual schema·layout 편집이 하나의 일관된 사용자 경험으로 동작한다.
6. invalid source에서도 편집 내용을 잃지 않고 last-valid diagram을 유지한다.
7. 대규모 schema에서 group, view, search, detail level로 탐색 비용을 낮춘다.
8. Docker/OrbStack에서 단일 인스턴스로 실행하고 mounted volume으로 복구할 수 있다.

### 4.2 P1 목표

1. PostgreSQL·MySQL `SELECT`를 실행하지 않고 정적으로 분석한다.
2. 현재 project schema에 대해 table-level lineage를 시각화한다.
3. CTE, subquery, join, union 등 지원 범위를 versioned capability matrix로 공개한다.
4. cross-dialect DDL 변환을 preview와 진단을 전제로 검토한다.

### 4.3 비목표

- 실제 database 연결과 introspection
- SQL query 또는 DDL 실행
- migration diff 생성·적용
- production migration safety 검증
- 실시간 공동 편집
- multi-tenant SaaS, 조직·권한·과금
- stored procedure, trigger, dynamic SQL의 완전한 의미 분석
- 모든 dialect-specific option의 무손실 왕복 변환
- seed data·table record의 시각적 편집 또는 SQL DML export
- DBML에 임의 SQL fragment를 숨겨 넣는 custom extension
- dbdiagram UI·브랜드·비공개 동작의 복제

## 5. 대상 사용자와 핵심 작업

### 5.1 Primary Persona — 개인 개발자·설계자

- 로컬 또는 private server에서 schema 문서를 관리한다.
- DBML을 Git과 함께 사용한다.
- 큰 schema를 Context별로 나누어 보고 싶다.
- PostgreSQL 또는 MySQL DDL을 ERD로 빠르게 확인하고 싶다.
- source와 visual editor 중 작업에 맞는 방식을 선택하고 싶다.

### 5.2 Secondary Persona — 소규모 내부 팀의 리뷰어

- P0에서는 별도 account가 없고 공유된 self-host instance 또는 exported bundle을 사용한다.
- schema 변경을 직접 실행하지 않고 구조와 관계만 리뷰한다.
- 변환 과정에서 누락된 SQL 기능과 현재 source 오류를 확인한다.

### 5.3 핵심 Jobs To Be Done

- “DBML을 붙여 넣었을 때 도구가 임의로 문법을 제거하지 않고 정확한 오류 위치를 알려주길 원한다.”
- “143개 이상의 table을 Context와 업무 흐름별 view로 나누어 보고 싶다.”
- “운영 DDL을 실행하지 않고 ERD 초안으로 변환하고 싶다.”
- “화면에서 table이나 column을 바꾸면 표준 DBML source도 안전하게 갱신되길 원한다.”
- “SQL로 내보낼 때 어떤 정보가 표현되지 않았는지 알고 싶다.”

## 6. 핵심 불변식

1. **DBML source가 schema semantics의 유일한 정본이다.**
   - parsed model, graph, search index, SQL output은 파생물이다.
   - layout state는 schema semantics가 아니므로 별도 sidecar다.
2. **SQL은 절대 실행하지 않는다.**
   - import, preview, lineage는 parsing과 static analysis만 수행한다.
3. **변환 손실을 숨기지 않는다.**
   - unsupported 또는 ignored clause가 있으면 진단 없이 성공 처리하지 않는다.
4. **invalid source를 자동 수정하지 않는다.**
   - heuristic regex 삭제·치환으로 parse를 통과시키지 않는다.
5. **visual mutation은 DBML에 검증 가능한 최소 변경으로 반영한다.**
   - 전체 normalized model을 DBML로 재생성해 원문을 덮어쓰지 않는다.
6. **dragging은 schema를 바꾸지 않는다.**
   - 위치·viewport·collapse·hide는 DBML source를 수정하지 않는다.
7. **하나의 project는 하나의 primary dialect를 갖는다.**
   - PostgreSQL project와 MySQL project의 type·export validation을 혼합하지 않는다.
8. **동일 입력과 동일 parser version은 동일 normalized graph를 만든다.**
9. **parser upgrade는 명시적인 compatibility event다.**
   - 기존 project를 조용히 rewrite하지 않는다.
10. **exported SQL은 migration이 아니다.**
    - empty database용 logical DDL이며 기존 schema 변경 순서나 data preservation을 보장하지 않는다.

## 7. 용어

| 용어 | 정의 |
| --- | --- |
| `Project` | 하나의 DBML 정본과 dialect, layout, revision을 관리하는 단위 |
| `Canonical DBML` | schema semantics의 유일한 source of truth인 DBML text |
| `Draft Source` | 저장될 수 있으나 일시적으로 parse error가 있을 수 있는 현재 편집 text |
| `Last-valid Revision` | parse·semantic validation을 마지막으로 통과한 DBML revision |
| `Normalized Schema Graph` | DBML compiler 결과를 UI와 검증에 맞게 정규화한 파생 model |
| `Layout Sidecar` | node 위치·viewport·collapse·hide 등을 저장하는 DBML 외부 데이터 |
| `Visual Command` | diagram에서 table·column·ref·index·constraint를 변경하는 typed command |
| `Conversion Report` | SQL import/export 과정의 exact·normalized·partial·unsupported·error 진단 집합 |
| `Primary Dialect` | project의 SQL type과 DDL import/export validation 기준인 `POSTGRESQL` 또는 `MYSQL` |
| `DiagramView` | DBML이 정의한 visible entity projection |
| `View Layout` | 특정 `DiagramView`에 적용되는 위치·collapse·viewport 상태 |

## 8. 범위와 우선순위

### 8.1 P0 — Schema Authoring and DDL Interchange

- DBML source editor와 diagnostics
- PostgreSQL·MySQL DDL import preview
- PostgreSQL·MySQL DDL export
- `Table`, `Enum`, `Ref`, `TablePartial`, `TableGroup`, `DiagramView`, `Note`, `Index`, `Check`, `Project` 지원
- pinned parser가 이해하는 나머지 공식 DBML 문법의 parse·preserve. 시각화·visual edit 지원 범위는 별도로 표시
- 전체 graph와 view별 graph
- group collapse, visibility, search, focus, detail level
- manual layout, auto layout, reset, per-view persistence
- visual table·column·relationship·basic index/constraint editing
- source/visual edit undo·redo와 durable revisions
- import/export report와 project bundle
- single-user self-host packaging, healthcheck, backup/restore

### 8.2 P1 — Static Query Lineage and Advanced Interchange

- 실행 없는 PostgreSQL·MySQL `SELECT` parsing
- table-level lineage
- CTE·subquery·join·union capability matrix
- query diagnostics와 ambiguous reference 표시
- optional column-level lineage feasibility 검토
- cross-dialect export preview
- multifile DBML project UX 고도화
- Git-friendly deterministic project bundle 개선

### 8.3 P2 후보

- column-level lineage 완성
- schema diff와 migration planning 보조
- team authentication, review comments, sharing
- read-only database introspection
- additional SQL dialect

P2 항목은 P0 요구사항으로 해석하지 않는다. 특히 database connection 또는 migration execution은 별도 위협 모델과 제품 결정을 통과해야 한다.

## 9. 정보 구조와 주요 화면

### 9.1 Project Home

- project 생성·열기·복제·rename·삭제
- `primaryDialect`, parser version, last-valid 상태 표시
- 최근 수정 시각과 validation summary
- DBML file, SQL DDL, portable bundle import entry

### 9.2 Schema Workspace

```text
┌──────────────────────────────────────────────────────────────┐
│ Project / Dialect / Parse Status / Undo / Redo / Export     │
├──────────────────────┬───────────────────────────────────────┤
│ Source Editor        │ Diagram Canvas                        │
│ - DBML               │ - View selector                       │
│ - SQL import preview │ - Group controls                      │
│ - Diagnostics        │ - Search / Detail level               │
│                      │ - Visual edit inspector               │
├──────────────────────┴───────────────────────────────────────┤
│ Conversion report / Problems / Outline / Change summary     │
└──────────────────────────────────────────────────────────────┘
```

### 9.3 Import Preview

- dialect 선택 또는 명시적 확인
- SQL source preview
- generated DBML preview
- semantic inventory diff
- conversion diagnostics
- `Create New Project`, `Replace Current Draft`, `Cancel`

P0에서는 기존 schema와 SQL을 자동 merge하지 않는다. replace 전 자동 revision을 만들고 사용자가 명시적으로 승인한다.

### 9.4 Export

- format: DBML, PostgreSQL DDL, MySQL DDL, portable project bundle
- current draft validity
- target dialect와 primary dialect 일치 여부
- omitted DBML-only structure summary
- warning/error acknowledgement

## 10. 사용자 흐름

### 10.1 DBML로 새 project 생성

1. 사용자가 project 이름과 `primaryDialect`를 선택한다.
2. 빈 표준 DBML 또는 DBML file을 입력한다.
3. worker가 `dbmlv2` compiler로 lexical·syntax·semantic validation을 수행한다.
4. 성공하면 normalized graph와 initial layout을 생성한다.
5. 실패하면 source를 draft로 보존하고 정확한 diagnostics를 표시한다.
6. 사용자는 오류를 수정하거나 원본으로 되돌릴 수 있다.

### 10.2 PostgreSQL·MySQL DDL 가져오기

1. 사용자가 dialect와 SQL source를 제공한다.
2. importer는 SQL을 실행하지 않고 parse한다.
3. supported structure로 DBML candidate를 생성한다.
4. 원본 SQL과 candidate DBML을 semantic inventory로 비교한다.
5. 모든 clause를 `EXACT`, `NORMALIZED`, `PARTIAL`, `UNSUPPORTED`, `ERROR`로 분류한다.
6. 사용자가 report와 generated DBML을 확인한다.
7. 확인한 경우에만 new project를 만들거나 current draft를 교체한다.
8. 교체 전 기존 draft와 layout을 revision으로 보존한다.

### 10.3 Source 직접 편집

1. 사용자가 Monaco 기반 editor에서 DBML을 수정한다.
2. draft는 짧은 debounce 후 worker로 전달된다.
3. parser가 diagnostics와 normalized graph candidate를 반환한다.
4. valid이면 last-valid graph와 source map을 교체한다.
5. invalid이면 draft는 저장하지만 diagram은 마지막 valid graph를 유지한다.
6. invalid 상태에서는 SQL export와 visual schema mutation을 비활성화한다.

### 10.4 Diagram 위치 편집

1. 사용자가 node를 이동하거나 group을 접고 view를 전환한다.
2. schema source는 변경하지 않는다.
3. 변경은 current global/view layout에 debounce 저장한다.
4. 다른 view의 layout에는 영향을 주지 않는다.
5. `Reset Layout`은 선택한 view의 layout만 초기화한다.

### 10.5 Diagram에서 schema 편집

1. 사용자가 table·column·reference·index·constraint command를 입력한다.
2. app은 current draft가 valid이고 expected revision이 일치하는지 확인한다.
3. source map을 사용해 최소 `TextEdit` 집합을 생성한다.
4. edit를 memory에 적용한 뒤 전체 DBML을 재파싱한다.
5. normalized graph의 semantic diff가 command 의도와 일치하는지 검증한다.
6. 성공하면 source·graph·revision·undo stack을 원자적으로 갱신한다.
7. 실패하면 source를 변경하지 않고 원인과 source 편집 fallback을 제시한다.

### 10.6 SQL DDL 내보내기

1. current draft가 valid인지 확인한다.
2. project의 primary dialect를 기본 target으로 선택한다.
3. DBML-only structure와 변환 제약을 분석한다.
4. DDL과 conversion report를 함께 생성한다.
5. fatal error가 있으면 export를 차단한다.
6. warning만 있으면 사용자가 확인한 뒤 download할 수 있다.

## 11. 기능 요구사항

### 11.1 Project와 저장

| ID | 우선순위 | 요구사항 | 수용 기준 |
| --- | --- | --- | --- |
| `PRJ-001` | P0 | 사용자는 project를 생성·rename·복제·삭제할 수 있다. | 복제는 current draft와 last-valid 상태를 새 revision 1~2로 재기준화하고 과거 history·layout·import artifact는 복사하지 않는다. 삭제 전 명시적 확인과 portable backup 안내를 표시한다. |
| `PRJ-002` | P0 | project 생성 시 `primaryDialect`를 선택한다. | `POSTGRESQL`, `MYSQL` 외 값은 저장되지 않는다. |
| `PRJ-003` | P0 | canonical source, invalid draft, last-valid revision을 분리한다. | invalid draft 저장 후 재시작해도 내용과 last-valid diagram이 모두 복구된다. |
| `PRJ-004` | P0 | 모든 schema write는 monotonically increasing `revisionNo` 또는 expected version을 사용한다. | 두 browser tab의 stale write가 최신 내용을 조용히 덮어쓰지 않는다. |
| `PRJ-005` | P0 | autosave와 명시적 save 상태를 표시한다. | 사용자는 `Saving`, `Saved`, `Error`, `Draft invalid`를 구분할 수 있다. |
| `PRJ-006` | P0 | portable bundle을 export/import한다. | bundle은 DBML, layout, metadata, parser version, optional reports를 포함하고 새 설치에서 복구된다. |

Project rename은 요청한 `expectedSchemaRevisionNo`가 current schema와 같은지 확인하지만 source
revision을 만들거나 `schemaRevisionNo`를 증가시키지 않는다. 같은 schema revision을 기준으로 한 rename
끼리는 마지막으로 commit된 이름을 사용한다.

#### 11.1.1 Project HTTP contract

Project HTTP API는 `/api/v1` 아래에서 다음 resource contract를 사용한다.

| Endpoint | 성공 응답 |
| --- | --- |
| `GET /projects` | `200`과 project summary 목록 |
| `POST /projects` | `CREATE` 또는 `DUPLICATE` 요청, `201`과 project mutation 결과 |
| `GET /projects/:projectId` | `200`과 current project state |
| `PATCH /projects/:projectId` | rename 결과 `200` |
| `DELETE /projects/:projectId` | 삭제 결과 `204` |
| `PUT /projects/:projectId/draft` | draft 저장 결과 `200` |
| `GET /projects/:projectId/revisions` | source를 제외한 revision summary 목록 `200` |
| `POST /projects/:projectId/revisions/:revisionNo/restore` | 새 restore checkpoint 결과 `200` |

`POST /projects`는 `operation`이 `CREATE`인 요청과 `DUPLICATE`인 요청을 strict discriminated
union으로 구분한다. 모든 write request는 RFC UUID 형식의 `commandId`를 받고 응답의
`x-command-id` header로 반환한다. M1에서는 command ID를 저장하거나 replay를 차단하지 않으며 durable
idempotency는 visual command transaction과 함께 구현한다.

서버는 caller가 보낸 request ID를 신뢰하지 않고 request마다 correlation ID를 생성한다. 모든 응답은
`x-correlation-id` header를 가지며 오류 응답의 `correlationId`와 동일하다. stale schema write는
`409`와 current revision을 반환한다. Invalid DBML project 생성, draft 저장, revision restore는 사용자의
source를 보존한 성공 응답이며 diagnostics를 함께 반환한다. 유효한 source가 필수인 후속 visual·export
operation의 semantic 실패와 구분한다.

Revision 목록은 history navigation과 restore 선택에 필요한 identity, revision number, hash, validity,
origin, parser provenance, diagnostic summary와 timestamp만 반환한다. 과거 source 전체를 한 목록 응답에
반복하지 않는다.

### 11.2 DBML parsing과 source editor

| ID | 우선순위 | 요구사항 | 수용 기준 |
| --- | --- | --- | --- |
| `DBML-001` | P0 | `@dbml/core`와 `@dbml/parse`의 정확히 고정된 같은 version을 사용한다. | runtime에서 서로 다른 major/minor parser package가 함께 로드되지 않는다. |
| `DBML-002` | P0 | 최신 compiler 경로인 `dbmlv2`와 multifile-aware API를 사용한다. | `DiagramView`·`TablePartial` fixture가 legacy parser fallback 없이 통과한다. |
| `DBML-003` | P0 | 정규식으로 `TableGroup`, `DiagramView`, `checks` 등을 제거하지 않는다. | 입력과 parser 전달 source의 hash가 동일하다. |
| `DBML-004` | P0 | syntax·semantic diagnostics에 severity, code, message, file, start/end position을 제공한다. | diagnostic 클릭 시 해당 source range로 이동한다. |
| `DBML-005` | P0 | `Table`, `Enum`, `Ref`, `TablePartial`, `TableGroup`, `DiagramView`, `Note`, `Index`, `Check`, `Project`를 표시한다. | 대표 fixture의 inventory가 parser model과 UI에서 일치한다. |
| `DBML-006` | P0 | source editor는 syntax highlighting, bracket matching, search, replace를 제공한다. | standard keyboard workflow로 schema를 편집할 수 있다. |
| `DBML-007` | P0 | invalid source를 보존하고 last-valid graph를 유지한다. | parse error 발생으로 사용자의 draft text가 사라지지 않는다. |
| `DBML-008` | P0 | parser version을 project revision과 conversion report에 기록한다. | upgrade 전후 결과의 provenance를 확인할 수 있다. |
| `DBML-009` | P0 | parser upgrade 시 revalidation summary를 먼저 제공한다. | 사용자의 승인 없이 canonical DBML을 rewrite하지 않는다. |
| `DBML-010` | P0 | pinned parser가 이해하는 공식 문법은 visual support 여부와 무관하게 parse·preserve한다. | `Records`, alias, custom metadata처럼 P0 diagram에 없는 construct도 unrelated edit 후 사라지지 않는다. |
| `DBML-011` | P0 | P0 UI는 single canonical DBML file을 기본으로 한다. | compiler adapter는 multifile-aware API를 사용하지만 multifile authoring은 P1임을 UI에 명시한다. |

#### 11.2.1 DBML 지원 수준

“DBML 지원”을 하나의 boolean으로 표현하지 않고 다음 수준을 구분한다.

| 수준 | 의미 | P0 예시 |
| --- | --- | --- |
| `PARSE_AND_PRESERVE` | compiler가 이해하고 source edit 후 보존하지만 전용 UI는 없을 수 있음 | records, alias, custom metadata |
| `DIAGRAM_VISIBLE` | graph·outline에서 의미를 확인할 수 있음 | table, column, ref, enum, group, partial injection, view |
| `VISUALLY_EDITABLE` | typed visual command로 source를 변경할 수 있음 | table, column, ref, basic index/constraint, group membership, view visibility |
| `SOURCE_ONLY` | source editor에서만 생성·수정 가능 | advanced metadata, 일부 partial·record 편집, dialect-specific raw type |

UI는 각 construct의 지원 수준을 capability badge와 도움말로 공개한다. `PARSE_AND_PRESERVE`를 `VISUALLY_EDITABLE`로 오인시키지 않는다.

### 11.3 SQL import

| ID | 우선순위 | 요구사항 | 수용 기준 |
| --- | --- | --- | --- |
| `SQLI-001` | P0 | PostgreSQL과 MySQL DDL import를 제공한다. | 사용자가 dialect를 명시하고 parser가 해당 dialect로만 해석한다. |
| `SQLI-002` | P0 | SQL text와 file은 어떠한 database에도 실행·전달되지 않는다. | 제품에 DB connection string 입력 UI와 execution code path가 없다. |
| `SQLI-003` | P0 | import는 preview 후 confirm하는 2단계 작업이다. | preview 취소 시 project source와 layout이 변경되지 않는다. |
| `SQLI-004` | P0 | conversion report를 생성한다. | statement/clause별 `EXACT`, `NORMALIZED`, `PARTIAL`, `UNSUPPORTED`, `ERROR`가 표시된다. |
| `SQLI-005` | P0 | importer가 무시한 option을 silent success로 처리하지 않는다. | engine, tablespace, generated column, partial index 등 부분 지원 clause가 warning에 나타난다. |
| `SQLI-006` | P0 | 지원되지 않는 `ALTER TABLE` column mutation, `CREATE VIEW`, `DROP` 등을 명시한다. | 원본 statement range와 미지원 이유가 report에 포함된다. |
| `SQLI-007` | P0 | 원본 SQL을 import artifact로 선택 보존한다. | 사용자가 원본 보존 여부와 retention을 선택할 수 있다. |
| `SQLI-008` | P0 | current project replace 전 revision을 만든다. | import 결과가 부정확하면 이전 source로 복원할 수 있다. |
| `SQLI-009` | P0 | P0는 기존 DBML과 import SQL의 자동 merge를 제공하지 않는다. | UI는 new project 또는 replace만 제공한다. |
| `SQLI-010` | P0 | `INSERT`, `UPDATE`, `DELETE`, `COPY`와 data payload를 schema로 가져오지 않는다. | DML은 별도 `UNSUPPORTED_DATA_STATEMENT`로 보고하고, 사용자가 확인한 경우에만 DDL 부분을 적용한다. |
| `SQLI-011` | P0 | DML이 포함된 입력의 original SQL 보존은 기본적으로 끈다. | 사용자가 명시적으로 선택하지 않으면 preview 종료 후 row data가 durable store에 남지 않는다. |

### 11.4 SQL export

| ID | 우선순위 | 요구사항 | 수용 기준 |
| --- | --- | --- | --- |
| `SQLO-001` | P0 | valid DBML을 PostgreSQL 또는 MySQL create DDL로 생성한다. | primary dialect 선택 시 해당 exporter가 사용된다. |
| `SQLO-002` | P0 | invalid draft에서는 export를 차단한다. | last-valid revision을 export하려면 사용자가 이를 명시적으로 선택한다. |
| `SQLO-003` | P0 | DBML-only construct가 DDL에 포함되지 않음을 report한다. | `TableGroup`, `DiagramView`, layout omission이 표시된다. |
| `SQLO-004` | P0 | exporter warning과 unsupported type을 표시한다. | fatal conversion은 download를 차단하고 source 위치를 제공한다. |
| `SQLO-005` | P0 | generated DDL을 migration으로 표시하지 않는다. | export UI와 file header에 empty-schema DDL임을 명시한다. |
| `SQLO-006` | P0 | target과 primary dialect가 다르면 차단한다. | `DEC-009`에 따라 cross-dialect preview는 P0에 노출하지 않는다. |
| `SQLO-007` | P0 | export 결과를 다시 같은 dialect parser로 검증한다. | 생성 SQL이 재파싱되지 않으면 성공 download로 처리하지 않는다. |
| `SQLO-008` | P0 | DDL export는 DBML `Records`를 DML로 생성하지 않는다. | records가 있으면 omission warning을 표시하고 exporter의 record output을 비활성화한다. |

### 11.5 Diagram 탐색

| ID | 우선순위 | 요구사항 | 수용 기준 |
| --- | --- | --- | --- |
| `DGM-001` | P0 | table과 column, PK/FK, relationship를 렌더링한다. | source inventory와 canvas inventory가 일치한다. |
| `DGM-002` | P0 | `TableGroup`을 compound group으로 표현한다. | group color·name·membership이 source와 일치한다. |
| `DGM-003` | P0 | group collapse 시 외부 relationship를 group summary edge로 집계한다. | 숨겨진 child edge 때문에 관계가 사라진 것으로 오인되지 않는다. |
| `DGM-004` | P0 | `DiagramView` selector를 제공한다. | 7개 view fixture를 재파싱 없이 전환하고 visible entity가 source 정의와 일치한다. |
| `DGM-005` | P0 | global view와 view별 layout을 분리한다. | 한 view의 node 이동이 다른 view 위치를 덮어쓰지 않는다. |
| `DGM-006` | P0 | table·column·group·schema 검색과 focus를 제공한다. | 검색 결과 선택 시 해당 node가 viewport 중앙에 표시된다. |
| `DGM-007` | P0 | `NAME_ONLY`, `KEYS_ONLY`, `FULL` detail level을 제공한다. | 큰 graph에서 detail을 낮춰도 node identity와 edge가 유지된다. |
| `DGM-008` | P0 | auto layout preview·apply·cancel·reset을 제공한다. | cancel은 기존 layout을 변경하지 않는다. |
| `DGM-009` | P0 | viewport culling과 필요한 level-of-detail을 사용한다. | 화면 밖 column DOM을 전부 렌더링하지 않는다. |
| `DGM-010` | P0 | source와 diagram 간 양방향 navigation을 제공한다. | node/column 선택에서 source range로 이동하고 source symbol에서 node를 focus한다. |

### 11.6 Visual schema editing

| ID | 우선순위 | 요구사항 | 수용 기준 |
| --- | --- | --- | --- |
| `EDIT-001` | P0 | diagram에서 table을 생성·rename·수정·삭제한다. | command 후 DBML 재파싱과 expected semantic diff가 성공한다. |
| `EDIT-002` | P0 | column을 생성·rename·reorder·수정·삭제한다. | name, type, nullability, PK, unique, increment, default, note를 표준 DBML로 표현한다. |
| `EDIT-003` | P0 | relationship를 생성·수정·삭제한다. | endpoint, cardinality, composite columns, `onDelete`, `onUpdate`를 검증한다. |
| `EDIT-004` | P0 | basic index와 key/check constraint를 편집한다. | DBML 표준으로 표현 가능한 범위만 form에서 활성화한다. |
| `EDIT-005` | P0 | table의 group membership과 `DiagramView` visibility를 편집한다. | official transform API가 있는 경우 우선 사용하고 source를 재검증한다. |
| `EDIT-006` | P0 | visual command는 current draft가 valid일 때만 실행한다. | invalid 상태에서는 이유와 source editor 이동 action을 제공한다. |
| `EDIT-007` | P0 | visual command는 minimal source edit를 사용한다. | 관련 없는 comment, formatting, `TablePartial`, `DiagramView`가 변경되지 않는다. |
| `EDIT-008` | P0 | command 적용 전후 semantic diff를 검증한다. | 의도하지 않은 table·column·ref 변화가 있으면 전체 command를 rollback한다. |
| `EDIT-009` | P0 | 표준 DBML로 표현할 수 없는 dialect feature는 source-only로 처리한다. | UI가 비표준 숨김 metadata를 생성하지 않는다. |
| `EDIT-010` | P0 | source buffer와 visual command 충돌을 방지한다. | visual command 전에 source debounce를 flush하고 expected revision mismatch면 재시도 안내를 표시한다. |
| `EDIT-011` | P0 | column type 입력은 project dialect에 맞는 suggestion과 validation을 제공하되 표준 DBML raw type을 강제로 삭제하지 않는다. | custom/domain type은 source-only 또는 warning 상태로 보존된다. |
| `EDIT-012` | P0 | `TablePartial`에서 주입된 field의 provenance와 변경 영향을 표시한다. | 개별 table의 local field처럼 삭제하지 않으며 partial 편집이 필요한 경우 영향 table 목록과 source 이동을 제공한다. |

### 11.7 History와 복구

| ID | 우선순위 | 요구사항 | 수용 기준 |
| --- | --- | --- | --- |
| `HIS-001` | P0 | source·visual command에 통합 undo/redo를 제공한다. | redo stack의 invalidation 규칙이 editor와 diagram에서 동일하다. |
| `HIS-002` | P0 | import replace, parser migration, bulk auto-layout 전 durable revision을 만든다. | 작업 실패나 취소 후 이전 상태로 복구된다. |
| `HIS-003` | P0 | layout revision과 schema revision을 별도로 추적한다. | 위치 이동만으로 schema revision이 증가하지 않는다. |
| `HIS-004` | P0 | rename 시 layout key를 migration한다. | visual rename 후 node 위치와 view 상태가 유지된다. |
| `HIS-005` | P0 | source에서 직접 rename한 경우 semantic matching을 시도하고 불확실하면 새 node로 취급한다. | heuristic 결과를 숨기지 않고 layout recovery 안내를 표시한다. |

### 11.8 P1 Query lineage

| ID | 우선순위 | 요구사항 | 수용 기준 |
| --- | --- | --- | --- |
| `LIN-001` | P1 | PostgreSQL·MySQL `SELECT`를 실행하지 않고 parse한다. | query가 network 또는 database driver로 전달되지 않는다. |
| `LIN-002` | P1 | query가 참조한 table을 current schema graph에 overlay한다. | unresolved·ambiguous reference를 별도 상태로 표시한다. |
| `LIN-003` | P1 | CTE, join, subquery, union 지원 범위를 versioned matrix로 공개한다. | unsupported construct가 silent partial lineage로 표시되지 않는다. |
| `LIN-004` | P1 | P1 첫 릴리스는 table-level lineage를 목표로 한다. | column-level 결과를 완전하다고 오인시키지 않는다. |
| `LIN-005` | P1 | `SELECT *`, alias shadowing, dynamic SQL의 불확실성을 표시한다. | confidence 또는 diagnostic 없이 확정 lineage를 생성하지 않는다. |

## 12. DBML·SQL 변환 계약

### 12.1 Import classification

| 상태 | 의미 | 사용자 처리 |
| --- | --- | --- |
| `EXACT` | DBML model로 의미가 보존된다. | 별도 확인 없이 포함 가능 |
| `NORMALIZED` | 의미는 보존되지만 syntax/name/format이 정규화된다. | 변경 요약 표시 |
| `PARTIAL` | 일부 option 또는 세부 의미가 표현되지 않는다. | warning 확인 필요 |
| `UNSUPPORTED` | parser 또는 DBML model이 표현하지 못한다. | 원본 range와 대안 표시 |
| `ERROR` | 입력이 해당 dialect에서 parse되지 않는다. | 적용 차단 |

### 12.2 P0 최소 보장 범위

| Feature | PostgreSQL import | MySQL import | 비고 |
| --- | --- | --- | --- |
| Basic `CREATE TABLE` | 지원 | 지원 | schema/name/type 포함 |
| PK, FK, UNIQUE, CHECK, NOT NULL, DEFAULT | 지원 | 지원 | dialect parser 범위 안에서 보장 |
| Composite PK/FK/index | 지원 | 지원 | semantic fixture 필요 |
| PostgreSQL enum / MySQL enum | 지원 | 지원 | DBML enum mapping을 검증 |
| PostgreSQL array | 지원 | 해당 없음 | dialect-specific type 유지 |
| `SERIAL`/identity | 지원 또는 정규화 | 해당 없음 | exact type과 increment 의미를 보고 |
| `AUTO_INCREMENT` | 해당 없음 | 지원 | DBML increment로 정규화 |
| table·column comment | 지원 | 지원 | quote·Unicode fixture 필요 |
| function-based index | 지원 | 지원 | exporter 왕복 여부 별도 진단 |
| PostgreSQL GIN/GIST/BRIN | 지원 | 해당 없음 | DBML index type 표현 확인 |
| partial index predicate | 부분 지원 | 미지원 | predicate 손실 warning 필수 |
| generated/computed column | 부분 지원 | 부분 지원 | 표현 손실 warning 필수 |
| table option·tablespace·engine | 부분 지원 | 부분 지원 | silent drop 금지 |
| `ALTER TABLE ADD` constraint | 일부 지원 | 일부 지원 | constraint 종류별 matrix 공개 |
| `ALTER TABLE` column add/drop/rename/modify | 미지원 | 미지원 | P0 import report에 명시 |
| `CREATE VIEW` | 미지원 | 미지원 | P0 DBML `DiagramView`와 SQL VIEW를 혼동하지 않음 |
| `DROP TABLE/INDEX` | 미지원 | 미지원 | snapshot DDL만 입력 대상으로 정의 |
| `INSERT`, `UPDATE`, `DELETE`, `COPY` | schema import 제외 | schema import 제외 | DDL-only 적용 전 명시적 warning |
| trigger, procedure, function body | 미지원 | 미지원 | query나 script를 실행하지 않음 |

실제 지원 범위는 pinned parser version의 fixture test 결과가 이 표보다 우선한다. dependency를 올릴 때 matrix와 golden fixture를 같은 변경에서 갱신한다.

### 12.3 Round-trip 원칙

텍스트 동일성은 보장하지 않는다. 다음 semantic comparison을 사용한다.

```text
SQL input
  → dialect parser
  → normalized graph A
  → generated DBML
  → DBML v2 parser
  → normalized graph B
  → same-dialect SQL export
  → dialect parser
  → normalized graph C
```

- `A`와 `B`의 supported subset이 같아야 import를 성공으로 처리한다.
- `B`와 `C`의 exportable subset이 같아야 export를 성공으로 처리한다.
- order, whitespace, generated constraint name처럼 비의미적 차이는 normalized comparison에서 제외한다.
- type, nullability, PK/FK endpoint, cardinality, default, unique, check, index 의미의 차이는 report 대상이다.
- 원본에서 지원되지 않은 fragment는 original SQL artifact와 report에만 남고 canonical DBML에 숨겨 넣지 않는다.

## 13. 편집 동기화 계약

### 13.1 Source 상태

```text
VALID_DRAFT
  ├─ source edit succeeds → VALID_DRAFT + new graph
  ├─ source edit fails    → INVALID_DRAFT + last-valid graph retained
  └─ visual command      → validate → semantic diff → atomic commit

INVALID_DRAFT
  ├─ source edit succeeds → VALID_DRAFT + new graph
  ├─ source edit fails    → INVALID_DRAFT + diagnostics update
  └─ visual command       → blocked
```

### 13.2 Visual command transaction

모든 visual command는 다음 순서를 따른다.

1. source editor buffer flush
2. expected `schemaRevisionNo` 확인
3. current source valid 여부 확인
4. target symbol과 source range resolve
5. typed command validation
6. non-overlapping `TextEdit[]` 생성
7. memory copy에 edit 적용
8. DBML v2 전체 reparse
9. expected semantic diff 검증
10. source·last-valid graph·revision·undo record 원자 저장

8~10 중 하나라도 실패하면 source는 변경하지 않는다.

### 13.3 Source fidelity

- visual edit는 관련 block 또는 token range만 수정한다.
- 관련 없는 comment와 formatting을 보존한다.
- 새로 삽입하는 fragment만 canonical formatter 규칙을 따른다.
- official `renameTable`, `syncDiagramView` 등 source transform이 있으면 우선 사용한다.
- normalized model 전체를 `ModelExporter.export(..., 'dbml')`로 재생성해 canonical source를 덮어쓰지 않는다.
- source 전체 formatting 기능은 별도 명시적 command로만 제공하며 실행 전 diff preview를 보여준다.

### 13.4 Layout identity

표준 DBML 호환성을 위해 hidden persistent ID를 DBML에 주입하지 않는다.

- 기본 key는 qualified table name과 element path다.
- visual rename command는 old key에서 new key로 layout을 명시적으로 migration한다.
- source 직접 편집의 rename은 semantic diff로 추론하되 확신할 수 없으면 delete+create로 처리한다.
- stale layout entry는 바로 삭제하지 않고 recovery 가능 기간 동안 보존한다.
- `schemaHash`는 layout 적용 가능성을 확인하는 provenance이지 위치를 매번 초기화하는 key가 아니다.

## 14. 논리 데이터 모델

### 14.1 `Project`

| 필드 | 의미 |
| --- | --- |
| `id` | local unique ID |
| `name` | project 표시명 |
| `primaryDialect` | `POSTGRESQL` 또는 `MYSQL` |
| `draftSource` | 현재 DBML editor source. invalid일 수 있음 |
| `draftHash` | current draft hash |
| `lastValidRevisionId` | diagram·export 기본 source pointer |
| `parserVersion` | 마지막 validation에 사용된 version |
| `schemaRevisionNo` | schema write optimistic version |
| `layoutRevisionNo` | layout write optimistic version |
| `createdAt`, `updatedAt` | local timestamp |

### 14.2 `SchemaRevision`

| 필드 | 의미 |
| --- | --- |
| `id`, `projectId`, `revisionNo` | revision identity |
| `source` | 해당 시점의 DBML source |
| `sourceHash` | content hash |
| `validity` | `VALID` 또는 `INVALID` |
| `origin` | `SOURCE_EDIT`, `VISUAL_COMMAND`, `SQL_IMPORT`, `RESTORE`, `PARSER_MIGRATION` |
| `parserVersion` | validation provenance |
| `diagnosticSummary` | error/warning/info count와 parser version |
| `createdAt` | 생성 시각 |

P0는 최근 non-checkpoint schema revision 100개를 보존한다. import replace, restore, parser migration
checkpoint는 자동 pruning 대상에서 제외한다. 현재 `lastValidRevisionId`가 가리키는 revision은 항상
보호하므로 invalid draft가 100개를 초과해 연속 저장된 동안에는 non-checkpoint revision이 최대 101개
남을 수 있다.

### 14.3 `DiagramLayout`

| 필드 | 의미 |
| --- | --- |
| `projectId` | project reference |
| `viewKey` | `GLOBAL` 또는 `DiagramView` qualified name |
| `positions` | element key별 x/y |
| `collapsedGroupKeys` | 접힌 group 목록 |
| `hiddenElementKeys` | 사용자가 추가로 숨긴 element 목록 |
| `viewport` | x/y/zoom |
| `detailLevel` | `NAME_ONLY`, `KEYS_ONLY`, `FULL` |
| `baseSchemaHash` | 저장 당시 schema provenance |
| `revisionNo` | layout optimistic version |

### 14.4 `ImportArtifact`

| 필드 | 의미 |
| --- | --- |
| `id`, `projectId` | import identity |
| `dialect` | input SQL dialect |
| `originalSql` | 사용자 선택 시 보존하는 원본 |
| `originalHash` | 중복·provenance 확인 |
| `generatedDbml` | preview candidate |
| `parserVersion` | 변환 version |
| `report` | statement/clause diagnostics |
| `status` | `PREVIEWED`, `APPLIED`, `CANCELLED`, `FAILED` |
| `createdAt`, `appliedAt` | 시각 |

### 14.5 파생 데이터

다음은 언제든 DBML source에서 재구축하며 별도 정본으로 취급하지 않는다.

- normalized schema graph
- search index
- edge aggregation
- SQL output
- parser symbol table
- view visibility projection
- performance cache

## 15. 내부 경계와 책임

```text
project_store
  ├─ Project / SchemaRevision / DiagramLayout / ImportArtifact
  └─ atomic save / backup / restore

schema_compiler
  ├─ DBML v2 parse / diagnostics / source map
  ├─ PostgreSQL·MySQL DDL parse
  ├─ normalized schema graph
  └─ conversion report / semantic diff

source_transform
  ├─ typed VisualCommand validation
  ├─ AST/source-position TextEdit generation
  ├─ official transform adapter
  └─ reparse + expected diff gate

diagram
  ├─ DiagramView projection
  ├─ TableGroup compound graph
  ├─ ELK layout / viewport culling / LOD
  └─ layout command and persistence

export
  ├─ DBML and portable bundle
  ├─ PostgreSQL DDL
  ├─ MySQL DDL
  └─ export validation and report
```

UI가 parser-specific object를 직접 수정하지 않는다. 모든 schema write는 typed `VisualCommand` 또는 source text edit 경계를 통과한다.

## 16. 비기능 요구사항

### 16.1 성능

P0 대표 fixture는 약 200 KB, 143 tables, 573 refs, 15 groups, 7 views다.

| ID | 목표 |
| --- | --- |
| `PERF-001` | 대표 fixture의 DBML parse+diagnostics p95 1초 이내 |
| `PERF-002` | cold load 후 first interactive diagram p95 3초 이내 |
| `PERF-003` | view 전환 p95 300ms 이내이며 DBML을 재파싱하지 않음 |
| `PERF-004` | drag·pan·zoom 중 일반 동작 30 FPS 이상, 목표 60 FPS |
| `PERF-005` | source 입력 중 main thread long task 100ms 초과를 반복 생성하지 않음 |
| `PERF-006` | parser와 auto layout을 Web Worker에서 실행 |
| `PERF-007` | 최소 200 tables, 1,000 refs fixture에서 기능 degradation 없이 동작 |

측정 환경은 release 전에 4-core CPU, 8 GB RAM, Chromium 최신 안정판 기준으로 고정한다. 목표를 충족하지 못하면 table virtualization, viewport culling, label LOD, edge simplification을 순서대로 적용한다.

### 16.2 신뢰성

- schema source 저장은 atomic해야 한다.
- process crash 중에도 마지막 committed revision은 복구돼야 한다.
- invalid draft와 last-valid revision을 함께 잃지 않는다.
- import replace, restore, parser migration은 idempotency key 또는 expected revision을 사용한다.
- background parse 결과는 요청한 draft hash와 일치할 때만 UI에 반영한다.
- auto layout 실패는 source와 기존 layout을 변경하지 않는다.

### 16.3 접근성·사용성

- source editor와 주요 command는 keyboard로 사용할 수 있어야 한다.
- canvas 외에 outline/table list를 제공해 시각적 graph만으로 탐색을 강제하지 않는다.
- color만으로 PK/FK, error, group을 구분하지 않는다.
- diagnostics와 form control은 label·focus order를 제공한다.
- destructive visual command는 대상과 영향 ref를 확인한 뒤 실행한다.

### 16.4 호환성

- 표준 DBML file은 별도 제품 metadata 없이 내보낼 수 있어야 한다.
- layout은 optional sidecar이므로 제거해도 schema 의미가 바뀌지 않는다.
- project bundle은 `bundleSchemaVersion`을 갖는다.
- parser와 bundle schema upgrade는 forward migration과 rollback 안내를 제공한다.

## 17. 보안과 개인정보

### 17.1 위협 모델

입력 DBML·SQL·project bundle은 신뢰하지 않는다. table name, note, comment, default expression에 HTML·script-like text가 포함될 수 있다.

### 17.2 P0 보안 요구사항

1. SQL execution engine, DB driver connection UI, credential storage를 포함하지 않는다.
2. DBML·SQL parsing은 time·memory budget과 input size 제한이 있는 worker에서 수행한다.
3. table·column·note·diagnostic text는 DOM에 삽입할 때 escape한다.
4. source를 `eval`, `Function`, template execution, shell command에 전달하지 않는다.
5. Content Security Policy로 inline script와 임의 remote resource를 차단한다.
6. self-host image는 기본적으로 외부 telemetry를 전송하지 않는다.
7. application log에 full DBML·SQL source를 남기지 않는다.
8. bundle import는 archive path traversal, decompression bomb, oversized entry를 차단한다.
9. file upload size와 project complexity에 configurable hard limit을 둔다.
10. parser crash 또는 timeout은 worker만 종료하고 draft를 보존한다.
11. single-user P0는 public Internet 노출을 기본으로 가정하지 않는다.
12. 기본 bind와 배포 예시는 loopback 또는 reverse proxy 보호를 우선한다.
13. remote access를 지원할 경우 operator가 access control을 구성해야 하며, 제품 내 authentication 추가는 별도 scope다.
14. DML이 포함된 SQL import는 row data를 기본 보존하지 않고 DDL-only 적용 여부를 별도로 확인한다.

### 17.3 보존

- DBML·SQL에는 실제 schema name과 업무 정보가 포함될 수 있으므로 project data는 외부 전송하지 않는다.
- original SQL artifact 보존은 선택 가능해야 한다.
- project 삭제는 mounted volume의 application record를 제거하되 backup copy 존재 가능성을 안내한다.
- log와 conversion report에는 source 전체 대신 hash·range·diagnostic code를 우선 기록한다.

## 18. Self-host 운영 요구사항

| ID | 요구사항 |
| --- | --- |
| `OPS-001` | Docker/OCI compatible 단일 image를 제공한다. |
| `OPS-002` | OrbStack과 Docker Engine에서 같은 compose configuration으로 실행된다. |
| `OPS-003` | project data는 명시적 mounted volume에 저장한다. container 교체로 data가 사라지지 않는다. |
| `OPS-004` | `/health/live`와 `/health/ready` 또는 동등한 healthcheck를 제공한다. |
| `OPS-005` | schema migration은 startup 전 backup과 version check를 거친다. 실패 시 이전 data를 변경하지 않는다. |
| `OPS-006` | image version, parser version, bundle schema version을 UI와 logs에서 확인할 수 있다. |
| `OPS-007` | one-command backup/export와 restore 검증 절차를 문서화한다. |
| `OPS-008` | outbound network가 없어도 core feature가 동작한다. font·asset도 image에 포함한다. |
| `OPS-009` | graceful shutdown 시 pending atomic write를 완료하거나 rollback한다. |
| `OPS-010` | release image에 dependency version inventory와 SBOM을 제공하고 parser·renderer license를 검토한다. |
| `OPS-011` | public release tag·source commit·OCI image digest를 서로 추적할 수 있게 한다. |
| `OPS-012` | repository root에 project `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES`와 dependency source·license 안내를 제공한다. |

## 19. 관측성과 오류 모델

### 19.1 사용자 오류 분류

| 오류 코드 영역 | 의미 | 예시 |
| --- | --- | --- |
| `DBML_PARSE_*` | DBML lexical/syntax error | 닫히지 않은 block |
| `DBML_SEMANTIC_*` | symbol/reference/invariant error | 존재하지 않는 table ref |
| `SQL_PARSE_*` | dialect SQL parse error | MySQL syntax를 PostgreSQL로 선택 |
| `SQL_PARTIAL_*` | 일부 clause 미보존 | partial index predicate |
| `SQL_UNSUPPORTED_*` | 지원되지 않는 statement | `CREATE VIEW`, column rename |
| `VISUAL_CONFLICT_*` | source revision 또는 symbol conflict | stale browser tab |
| `VISUAL_VERIFY_*` | expected semantic diff 불일치 | column rename 외 ref 손실 |
| `LAYOUT_*` | layout 실패 | ELK timeout |
| `STORE_*` | durable save·migration 실패 | volume read-only |

### 19.2 운영 로그

- request/correlation ID
- project ID는 local opaque ID로 기록
- operation type과 latency
- input byte size, table/ref count
- parser/exporter version
- diagnostic code/count
- full schema content, note, SQL literal은 기본적으로 기록하지 않음

## 20. 성공 지표

P0는 public growth metric보다 정확성과 개인 workflow 완성을 우선한다.

| 지표 | 목표 |
| --- | --- |
| DBML fixture parse fidelity | supported construct inventory 100% 일치 |
| silent SQL loss | 0건 |
| visual command unintended semantic diff | 0건 |
| import preview 취소 후 mutation | 0건 |
| restart 후 committed project 복구 | 100% |
| 대표 fixture view 전환 성공률 | 100% |
| unsupported SQL diagnostic source range 제공률 | 100% |

## 21. 테스트 전략

### 21.1 Parser contract test

- 공식 DBML syntax construct별 최소 fixture
- `TablePartial`, `TableGroup`, `DiagramView` 조합 fixture
- multifile import fixture
- Unicode·quoted identifier·schema-qualified name
- invalid token, duplicate table, unresolved ref
- parser version snapshot

### 21.2 SQL dialect fixture

- PostgreSQL: schema, enum, array, serial/identity, composite key, FK action, GIN/GIST/BRIN, comments
- MySQL: enum, auto increment, engine option, composite key, FK action, inline index, comments
- partial/unsupported: generated column, partial index, `ALTER TABLE` column mutation, `CREATE VIEW`, `DROP`
- SQL → DBML → same-dialect SQL semantic comparison

### 21.3 Visual command contract test

- table·column·ref·index·constraint create/update/delete
- explicit rename의 layout key migration
- unrelated comment·formatting 보존
- `TablePartial`을 주입한 table 편집
- composite reference column rename
- `DiagramView` visibility update
- stale revision conflict
- reparse 실패 rollback
- expected semantic diff 불일치 rollback

### 21.4 End-to-end acceptance fixture

현재 약 199 KB DBML fixture를 사용해 다음을 검증한다.

1. 143 tables, 86 enums, 4 partials, 15 groups, 7 views, 573 refs를 인식한다.
2. 15 groups를 모두 collapse/expand할 수 있다.
3. 7 views가 정의된 visible entity를 표시한다.
4. source error를 만들면 draft는 보존되고 last-valid diagram이 유지된다.
5. 오류 수정 후 diagram이 current source로 갱신된다.
6. node 이동은 DBML source hash를 바꾸지 않는다.
7. visual column 추가는 해당 table block만 변경한다.
8. PostgreSQL export가 재파싱되고 conversion report가 생성된다.
9. project bundle을 새 volume에 restore하면 source·view layout·history가 복구된다.

### 21.5 배포 검증

- fresh OrbStack/Docker startup
- empty volume initialization
- existing volume upgrade
- read-only 또는 full disk 실패
- backup → container replacement → restore
- outbound network 차단 상태
- graceful shutdown 중 autosave

## 22. Release Gate

P0 release는 다음 조건을 모두 충족해야 한다.

### Gate A — Parsing Fidelity

- DBML v2 golden fixtures 통과
- 대표 대형 fixture inventory 일치
- parser version pinned
- regex source sanitization 없음

### Gate B — Editing Integrity

- visual command atomic reparse·semantic diff 검증 통과
- unrelated source preservation test 통과
- invalid draft recovery 통과
- revision conflict와 undo/redo 통과

### Gate C — SQL Transparency

- PostgreSQL·MySQL capability matrix가 실제 fixture와 일치
- partial/unsupported clause가 report에 나타남
- SQL execution path 없음
- same-dialect export reparse 통과

### Gate D — Large ERD Usability

- group, view, search, detail level, source navigation 완료
- 대표 fixture performance 목표 충족
- canvas 외 outline 탐색 제공

### Gate E — Self-host Recovery

- mounted volume persistence
- backup/restore drill 통과
- version·healthcheck 노출
- core workflow offline 동작

### Gate F — Open-source Distribution

- `LICENSE-DEC-001 = CONFIRMED`
- public source tag와 OCI image digest 대응
- `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES`, SBOM 제공
- Apache-2.0·MIT·EPL-2.0 dependency의 고지와 source 제공 조건 검토

## 23. 단계별 개발 순서

### Milestone 0 — Technical Spike

- DBML v2 parser adapter와 parser-neutral normalized graph contract
- 원본과 parser 입력의 source hash 일치 및 legacy parser fallback 부재 검증
- PostgreSQL·MySQL 기본 DDL의 실행 없는 same-dialect import/export smoke fixture
- `@dbml/connector`의 P0 runtime·direct dependency 제외와 live database connection path 부재 검증
- 최소 source range `TextEdit[]`, reverse-offset 적용, 전체 reparse와 expected semantic diff 검증
- unrelated comment·partial·view의 byte-level 보존 검증
- React Flow + ELK compound layout worker, group/view/collapse/LOD performance spike

종료 조건: synthetic fidelity fixture의 parser fidelity, column add 최소 source patch, scale layout이 모두 통과한다.

### Milestone 1 — Read-only Schema Workspace

- project import
- DBML source editor·diagnostics
- normalized graph
- group·view·search·LOD
- layout sidecar

종료 조건: 대표 fixture를 source 손실 없이 탐색한다.

### Milestone 2 — SQL Interchange

- PostgreSQL·MySQL import preview
- conversion report
- same-dialect export와 reparse validation
- replacement revision과 rollback

종료 조건: silent loss 0과 dialect golden fixtures 통과.

### Milestone 3 — Visual Schema Editing

- table·column·ref·basic index/constraint command
- minimal source transform
- semantic diff gate
- undo/redo와 conflict handling

종료 조건: visual command contract suite 통과.

### Milestone 4 — Self-host Release

- durable store, backup/restore
- OCI image, compose, healthcheck
- offline asset packaging
- upgrade migration

종료 조건: release Gate A~F 통과.

### Milestone 5 — P1 Query Lineage

- 별도 query parser evaluation
- table-level lineage model
- capability matrix·diagnostics
- schema overlay UX

P0가 완료되기 전에 P1 parser dependency나 UI를 production path에 추가하지 않는다.

## 24. 확정된 보충 결정과 구현 전 Gate

### `DEC-010` — P0 durable storage — `CONFIRMED`

- 결정: self-host server의 mounted volume과 embedded SQLite에 project를 저장한다.
- 근거: browser·device가 바뀌어도 project를 유지하고 backup/restore와 revision atomicity를 제공해야 한다.
- 영향: backend, SQLite migration, volume 운영과 복구 검증이 P0에 포함된다. IndexedDB는 temporary UI cache로만 사용할 수 있다.

### `DEC-009` — Cross-dialect export — `CONFIRMED`

- 결정: P0에서 PostgreSQL project를 MySQL로 또는 그 반대로 변환하지 않는다.
- 근거: type, enum, array, identity, index option 차이 때문에 단순 export가 안전한 변환으로 오인될 수 있다.
- 영향: 각 project의 same-dialect import/export만 보장하고 cross-dialect preview는 P1에서 capability matrix와 함께 검토한다.

### `DEC-011` — Source formatting 보존 — `CONFIRMED`

- 결정: visual edit는 관련 block 밖의 formatting·comment를 그대로 보존하고 변경·삽입 block만 canonical formatting을 적용한다.
- 근거: byte-level 전체 보존은 source transformer 복잡도를 크게 높이지만 normalized model 전체 regeneration은 comment·고급 construct를 손실할 수 있다.
- 영향: source 전체 formatting은 별도 명시적 command와 diff preview를 가져야 한다.

### `DEC-012` — Revision retention — `CONFIRMED`

- 결정: 최근 non-checkpoint revision 100개를 보존하고 import·restore·parser-migration checkpoint는 자동 pruning에서 제외한다. 사용자는 보존된 history를 export할 수 있다.
- 영향: 100개 보존값은 P0의 고정 정책이다. checkpoint는 자동 pruning에서 제외하며 storage 사용량을 UI에서 확인할 수 있어야 한다.

### `DEC-013` — Remote access protection — `CONFIRMED`

- 결정: P0는 localhost/private network를 기본으로 하고 remote 노출은 reverse proxy authentication을 운영자 책임으로 둔다.
- 영향: P0 image 자체에 account/login을 추가하지 않는다. public Internet 노출을 기본 배포 예시로 제공하지 않는다.

### `DEC-014` — PostgreSQL·MySQL 기준 version — `CONFIRMED`

- 결정: P0 capability matrix는 PostgreSQL 14 이상과 MySQL 8.0 이상을 검증 baseline으로 사용한다.
- 영향: generated column, identity, index option, reserved keyword fixture를 두 baseline에 맞추고 parser가 version별 문법을 완전히 구분하지 못하는 항목은 warning으로 처리한다.

### `DEC-015` — Open-source 배포 — `CONFIRMED`

- 결정: source repository와 release image를 open source로 공개한다.
- 영향: public release는 source tag·commit·OCI image digest를 추적할 수 있어야 하며 build·self-host 설정도 source repository에 포함한다.
- 경계: dependency는 각자의 license를 유지하고 project license로 재라이선스하지 않는다.

### `LICENSE-DEC-001` — 정확한 SPDX license — `CONFIRMED`

- 결정: project source와 자체 산출물을 `Apache-2.0`으로 배포한다.
- 근거: permissive redistribution과 명시적 patent grant를 제공하며 현재 DBML core/parse의 Apache-2.0과도 일관된다.
- dependency 경계: DBML core/parse `Apache-2.0`, DBML connector·React Flow·Monaco `MIT`, ELK.js `EPL-2.0`을 각 license 조건대로 배포한다. dependency를 project `Apache-2.0`으로 재라이선스하지 않는다.
- release packaging: repository root에 Apache License 2.0 전문을 `LICENSE`로 두고, project attribution과 실제 copyright holder를 `NOTICE`에 기록하며 `THIRD_PARTY_NOTICES`와 SBOM을 제공한다.
- ELK.js 조건: 배포하는 EPL-2.0 component의 license·notice와 해당 source를 얻는 방법을 명시하고, 수정했다면 수정본 source 제공 조건을 검증한다.
- 상태 영향: license 선택에 따른 implementation blocker는 해소됐다. copyright holder 표기는 repository 생성 시 실제 소유 주체를 사용하며 placeholder 상태로 release하지 않는다.

## 25. 주요 위험과 완화

| 위험 | 영향 | 완화 |
| --- | --- | --- |
| SQL parser가 유효한 dialect feature를 부분적으로 무시 | 잘못된 ERD 신뢰 | versioned capability matrix, source range report, silent loss 0 gate |
| visual edit가 comment·advanced DBML을 손실 | 정본 훼손 | minimal `TextEdit`, reparse, expected semantic diff, rollback |
| invalid source와 diagram의 시점이 다름 | 사용자 혼동 | last-valid badge, source hash/revision 표시, visual edit/export 차단 |
| table rename으로 layout identity 소실 | 배치 초기화 | explicit rename migration, stale layout recovery |
| large graph의 edge 폭증 | UI unusable | view projection, group aggregation, LOD, worker layout, culling |
| parser upgrade 결과 drift | 기존 project 변경 | version pin, golden fixtures, explicit revalidation, no silent rewrite |
| self-host volume 누락 | data loss | startup warning, mounted volume docs, backup/restore gate |
| DBML과 SQL이 완전 왕복된다는 오해 | 잘못된 DDL 사용 | conversion report, same-dialect 범위, migration 아님을 명시 |
| P1 lineage가 실제 실행 결과처럼 보임 | 잘못된 영향 분석 | static-analysis label, capability/confidence 표시, unresolved diagnostics |

## 26. 구현 후보와 기술 제약

다음은 PRD를 만족하기 위한 현재의 구현 후보이며 최종 기술 설계는 별도 ADR에서 확정한다.

- TypeScript + React Web
- Monaco Editor
- `@dbml/core@9.1.1`, `@dbml/parse@9.1.1`부터 시작해 exact version pin
- React Flow custom node/compound graph
- ELK.js layout worker
- embedded SQLite 또는 동등한 mounted-volume store
- single OCI image와 Docker Compose

검증된 기술 제약은 다음과 같다.

1. 현재 exact package set에서 최신 construct를 위해 `dbmlv2` compiler path가 필요하다.
2. official model은 `TablePartial`, `TableGroup`, `DiagramView`를 parse할 수 있다.
3. normalized model을 DBML로 전체 export하면 original comment와 일부 source construct를 그대로 보존하지 못할 수 있다.
4. official source transform은 table rename과 `DiagramView` sync 등 일부 command만 제공하므로 visual editor에는 별도 AST/source patch layer가 필요하다.
5. SQL importer는 PostgreSQL·MySQL 기본 DDL을 지원하지만 여러 `ALTER TABLE` column mutation과 `CREATE VIEW`를 지원하지 않는다.
6. `@dbml/connector`는 live database schema fetch API를 노출하므로 P0 runtime·direct dependency에 포함하지 않는다.

## 27. 참고 자료

- [DBML JavaScript Core](https://dbml.dbdiagram.io/js-module/core/)
- [DBML CLI](https://dbml.dbdiagram.io/cli/)
- [DBML Syntax](https://dbml.dbdiagram.io/docs/)
- [React Flow Layouting](https://reactflow.dev/learn/layouting/layouting)
- [React Flow Performance](https://reactflow.dev/learn/advanced-use/performance)
- [Eclipse Layout Kernel](https://eclipse.dev/elk/reference.html)
- local validation baseline: `@dbml/cli`, `@dbml/core`, `@dbml/parse`, `@dbml/connector` `9.1.1`
