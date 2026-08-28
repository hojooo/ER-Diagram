# ADR 0003: Single-process SQLite persistence

- 상태: `ACCEPTED`
- 결정일: 2026-08-26
- 적용 범위: P0

## Context

P0는 single-user self-hosted application이며 browser나 device가 바뀌어도 canonical DBML, invalid draft, revision, per-view layout을 복구해야 한다. 별도 database server를 운영하게 하면 개인·내부 설치의 비용이 커지지만 browser storage만 사용하면 mounted-volume backup, server-side transaction과 restart recovery를 제공하기 어렵다.

## Decision

Mounted volume의 SQLite를 durable store로 사용하고 Drizzle schema/migration과 better-sqlite3 repository adapter를 둔다. SQLite 세부 사항은 `packages/storage-sqlite`에 격리하며 application use case는 persistence port에만 의존한다.

P0 schema는 다음 table로 구성한다.

- `projects`
- `schema_revisions`
- `diagram_layouts`
- `import_artifacts`
- `app_metadata`

Drizzle 표준 migrator가 관리하는 `__drizzle_migrations`는 허용하되 제품 table inventory에는 포함하지
않는다. Migration은 review 가능한 SQL과 `meta/_journal.json`을 직접 작성하며 P0에는 `drizzle-kit`을
추가하지 않는다. Drizzle schema와 실제 migration의 정합성은 empty database introspection과 behavior
test로 검증한다.

ID는 lowercase UUIDv7 text, 시간은 `YYYY-MM-DDTHH:mm:ss.sssZ` UTC ISO-8601 text로 저장한다.
Connection은 durable file만 허용하고 매번 `foreign_keys=ON`, WAL mode, `busy_timeout=5000`을 설정한
뒤 effective value를 다시 확인한다. Migration, integrity check와 rollback-only write probe가 실패하면
connection을 닫고 startup을 실패시킨다.

`projects.last_valid_revision_id`는 같은 project의 revision만 가리키는 deferrable composite foreign
key다. Canonical source write, revision, last-valid pointer와 관련 layout key migration은 하나의
`BEGIN IMMEDIATE` transaction에서 commit하거나 모두 rollback한다. better-sqlite3 transaction callback은
동기식으로 제한한다.

Application service는 DBML parse와 source hash 계산을 transaction 밖에서 완료한 뒤 transaction 안에서
`expectedSchemaRevisionNo`를 다시 확인한다. 실제 source 변경은 새 revision insert, project draft와
`schemaRevisionNo` update, last-valid pointer update와 pruning을 같은 transaction에서 처리한다. Parse
error는 write 실패가 아니라 `INVALID` revision이며 기존 last-valid pointer를 유지한다. 동일 source,
hash와 parser version의 save는 revision을 만들지 않는 no-op이다.

Project 복제는 current draft와 last-valid 상태만 새 project의 revision 1~2로 재기준화한다. 과거 schema
history, layout과 import artifact는 복사하지 않는다. Project rename은 expected schema revision으로
동시 schema 변경을 차단하되 source revision과 `schemaRevisionNo`를 증가시키지 않는다. 같은 schema
revision에서 발생한 rename끼리는 마지막 commit이 적용된다.

Layout write는 모든 view가 공유하는 `projects.layout_revision_no`를 optimistic version으로 사용한다.
Application은 `BEGIN IMMEDIATE` transaction 안에서 project 존재와 expected global revision을 다시 확인하고
`diagram_layouts` row upsert와 project revision 증가를 함께 commit한다. Row의 `revision_no`는 해당 view가
마지막으로 변경된 global revision이다. 다른 view write도 stale expected revision이면 conflict이며 동일한
normalized payload는 stale 검사를 통과한 뒤 revision을 증가시키지 않는 no-op이다. Position object key와
collapse/hidden key 배열은 code-unit 순서로 canonicalize한다.

Layout transaction은 canonical source, schema history, `schema_revision_no`와 project `updated_at`을 변경하지
않는다. 따라서 node 이동이나 viewport 저장이 Project Home 최근 수정 정렬을 바꾸지 않는다. Malformed JSON,
non-finite coordinate, duplicate key 또는 row revision이 project global revision보다 큰 persisted state는
fail-closed storage invariant로 처리하며 row upsert나 project revision CAS 중 하나라도 실패하면 전체
transaction을 rollback한다.

최근 non-checkpoint revision 100개를 보존한다. Checkpoint 여부는 별도 boolean으로 중복 저장하지 않고
revision origin에서 파생한다. `SQL_IMPORT`, `RESTORE`, `PARSER_MIGRATION`은 checkpoint이며
`SOURCE_EDIT`, `VISUAL_COMMAND`는 pruning 대상이다. 현재 last-valid pointer가 가리키는 revision은
100개 한도 밖이어도 보호한다. 이 경우 non-checkpoint revision은 최대 101개가 남을 수 있다. Original
SQL은 `DISCARD`를 기본값으로 사용해 `original_sql=null`로 저장하고, 사용자가 `RETAIN`을 명시한 경우에만
conversion 성공 여부와 관계없이 byte-identical 원문을 저장한다. P0는 별도 TTL을 두지 않으며 retained
source는 import artifact 또는 project 삭제 시 함께 제거한다. Core policy는 persistence 전용 입력만
선택하고 실제 artifact write와 transaction은 import application 경계가 담당한다.

SQL import preview는 conversion 성공과 실패를 각각 `PREVIEWED`, `FAILED` artifact로 저장한다. 이
transaction은 expected schema revision과 primary dialect를 다시 확인하지만 project source, revision,
last-valid pointer, layout과 project `updated_at`을 변경하지 않는다. Artifact의 `report_json`은 versioned
preview evidence, canonical SHA-256, initial data policy, nullable applied policy와 retention 선택을 담는다.
Repository는 envelope contract뿐 아니라 row dialect, original/candidate hash, status와 applied timestamp의
조합을 읽는 시점에 재검증한다.

SQL import Apply는 `BEGIN IMMEDIATE` 안에서 project와 artifact를 다시 읽고 schema revision과
`PREVIEWED` status를 compare-and-set한다. 새 `VALID + SQL_IMPORT` revision insert, project draft와
last-valid pointer update, artifact의 `APPLIED`·`applied_at`·applied policy update와 pruning 중 하나라도
실패하면 전체 transaction을 rollback한다. Candidate가 current source와 같아도 checkpoint를 만들며 기존
current revision 자체가 rollback 기준이므로 별도 pre-import duplicate revision은 만들지 않는다. Apply는
layout row와 `layout_revision_no`를 변경하지 않는다.

하나의 server process만 SQLite에 write한다. Multi-process horizontal write와 shared network filesystem database는 P0 범위가 아니다.

## Alternatives considered

### IndexedDB만 사용

Offline browser UX에는 유리하지만 server mounted-volume backup, 다른 device 접근, CLI restore와 atomic server revision 관리 요구를 충족하지 못한다. IndexedDB는 temporary client cache로만 사용할 수 있다.

### PostgreSQL server를 필수 persistence로 사용

확장성과 multi-process write에는 유리하지만 P0 single-user 설치에 별도 운영 의존성과 credential 관리가 생긴다.

### JSON file per project

Portable하게 보이지만 revision, optimistic version, multiple sidecar의 transaction과 migration consistency를 직접 구현해야 한다.

## Consequences

- Single volume backup과 restart recovery가 단순해진다.
- Native dependency build, read-only volume, full disk, corrupt backup과 migration failure를 검증해야 한다.
- Readiness는 migration 완료와 SQLite write 가능 여부를 포함해야 한다.
- Multi-user 또는 horizontal scaling이 필요해지면 port를 유지한 채 별도 persistence adapter와 migration ADR이 필요하다.

## Verification

- Empty database migration, foreign-key violation, transaction rollback과 restart recovery를 검사한다.
- WAL, foreign keys와 busy timeout의 effective value를 확인한다.
- 다섯 product table과 Drizzle migration table, column/index inventory와 migration hash를 확인한다.
- read-only storage, unsupported schema version, invalid migration과 built package의 migration path가
  fail-closed인지 확인한다.
- Retention과 checkpoint 예외를 fixture로 검증한다.
- Backup/restore는 checksum, dry run, read-back을 포함한다.
