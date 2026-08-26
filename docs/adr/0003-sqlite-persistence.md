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

ID는 UUIDv7 text, 시간은 UTC ISO-8601 text로 저장한다. Connection은 `foreign_keys=ON`, WAL mode, `busy_timeout=5000`으로 초기화한다. Canonical source write, revision, last-valid pointer와 관련 layout key migration은 하나의 transaction에서 commit하거나 모두 rollback한다.

최근 non-checkpoint revision 100개를 보존한다. Import, restore, parser-migration checkpoint는 자동 pruning에서 제외한다. Original SQL은 사용자가 명시적으로 선택한 경우만 저장한다.

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
- Retention과 checkpoint 예외를 fixture로 검증한다.
- Backup/restore는 checksum, dry run, read-back을 포함한다.
