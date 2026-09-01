# ADR 0010: SQLite whole-volume snapshot과 plan-hash recovery

## 상태

Accepted

## 맥락

Portable project bundle은 project identity를 새로 발급해 다른 instance로 옮기는 사용자 기능이다. 운영자는 그와
별도로 mounted SQLite volume의 project, retained revision, layout, SQL import artifact, visual command receipt,
`app_metadata`와 migration journal을 내부 ID까지 그대로 복구할 수 있어야 한다. 실행 중 database file만 복사하면
WAL에 남은 commit이 빠질 수 있고, 검증하지 않은 restore나 startup migration은 손상된 candidate로 정상 volume을
교체할 수 있다.

전체 database에는 opt-in retained original SQL과 실제 schema source가 포함될 수 있다. 따라서 recovery artifact를
portable bundle처럼 redaction하거나 archive budget으로 자르면 안 되지만, private permission과 명시적인 운영 절차가
필요하다.

## 결정

### Online snapshot과 exact directory format

Backup은 SQLite online backup API를 사용해 server가 실행 중이어도 일관된 snapshot을 만든다. Output은 mode
`0700` directory이며 mode `0600`인 `manifest.json`과 `database.sqlite` 두 file만 허용한다. Symlink, hardlink,
directory와 다른 entry는 restore trust boundary에서 거부한다. Output이 이미 존재하면 덮어쓰지 않으며 staging
directory에서 snapshot, manifest와 fsync를 완료한 후 atomic rename한다.

Manifest v1은 database byte 수·SHA-256, storage schema version, ordered migration history hash, SQLite version,
page evidence와 source-free table inventory를 기록한다. Manifest 자체는 `backupHash`를 제외한 canonical JSON의
SHA-256을 사용한다. Snapshot을 완료한 뒤 full `integrity_check`, `foreign_key_check`, version별 strict table/index/
column inventory, migration prefix와 project/revision/layout/artifact/receipt invariant를 close/reopen해 검증한다.
Portable bundle의 archive·expanded·entry limit은 raw whole-volume snapshot에 적용하지 않는다.

Backup은 자동 encryption, retention 또는 upload를 수행하지 않는다. Legacy source가 interactive 5 MiB 제한을
넘어도 database row를 자르지 않고 그대로 보존한다.

### Dry-run plan과 offline Apply

Restore와 migration은 기본적으로 dry-run이다. Backup evidence, normalized target path hash, 현재 target의 transient
online snapshot checksum, bundled migration set과 staged candidate checksum을 묶은 version 1 plan과 `planHash`를
반환한다. Apply는 동일 입력을 다시 검사하고 같은 hash를 요구한다. Backup, target 또는 bundled migration evidence가
바뀌면 `SQLITE_VOLUME_RECOVERY_PLAN_CONFLICT`로 중단한다.

Restore·migration Apply는 server가 중지된 offline 상태에서만 허용한다. 구현은 zero-timeout WAL checkpoint와
exclusive transaction으로 active writer를 차단하지만, process lifecycle lock의 authoritative 연결은 M4-006 production
bootstrap이 담당한다. Existing target restore에는 사용자가 지정한 별도 `--safety-backup-output`이 필수이며 그
backup checksum이 dry-run target evidence와 같아야 한다.

Candidate는 target과 같은 filesystem의 private sibling에서 준비하고 fsync한 뒤 기존 target을 rollback path로 옮기고
atomic rename한다. 새 target을 close/reopen해 전체 invariant와 candidate checksum을 다시 검증한다. 실패하면 기존
target과 WAL sidecar를 자동 복구한다. 성공해도 safety backup은 자동 삭제하지 않는다.

### Staged migration

Applied migration history는 bundled migration set의 정확한 prefix여야 한다. 지원되는 구버전은 backup copy에 migration을
적용하고 current schema로 read-back한 candidate만 교체 대상으로 사용한다. Future schema와 같은 version의 divergent
migration history는 자동 추론하거나 재작성하지 않고 차단한다. Current schema migration은 no-op plan이며 pre-migration
backup을 만들지 않는다.

이번 경계는 synchronous `openSqliteStorage()`의 기존 startup migration 동작을 바꾸지 않는다. M4-006은 production
startup 전에 이 preparation API를 호출해 pre-migration backup과 plan/apply lifecycle을 연결해야 한다.

## 결과

- Online backup은 WAL commit과 내부 identity를 빠뜨리지 않고 exact whole-volume recovery artifact를 만든다.
- Restore와 migration은 검증된 dry-run evidence 없이는 target을 교체하지 않는다.
- Existing target은 durable safety backup과 automatic rollback을 모두 가진다.
- Recovery directory는 retained SQL을 포함할 수 있는 민감 artifact이며 operator가 encryption·retention·off-host copy를
  별도로 책임진다.
- 이 기능은 portable project bundle, Web import/export 또는 remote backup service를 대체하지 않는다.

## 검증

- `pnpm --filter @er-diagram/contracts test test/sqlite-volume-backup-contract.test.ts`
- `pnpm --filter @er-diagram/storage-sqlite test test/volume-backup.test.ts`
- `pnpm --filter @er-diagram/server test:integration backup-restore`
