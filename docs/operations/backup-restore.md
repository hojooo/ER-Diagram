# SQLite volume backup·restore 운영 절차

이 runbook은 mounted SQLite volume 전체를 내부 identity 그대로 복구하는 운영자 절차다. Project 하나를 다른
instance로 옮길 때는 portable project bundle을 사용한다.

## 민감 데이터와 권한

- Snapshot에는 canonical DBML, revision history, layout, import report, visual command receipt, instance metadata와
  opt-in retained original SQL이 암호화 없이 포함될 수 있다.
- 도구는 output directory를 `0700`, `manifest.json`과 `database.sqlite`를 `0600`으로 만든다.
- 자동 encryption, upload, retention 또는 삭제는 하지 않는다. Backup destination의 접근 통제와 lifecycle은
  operator 책임이다.
- Existing output은 절대 overwrite하지 않는다. 매 실행마다 새 directory를 지정한다.

아래 명령은 repository root에서 실행한다. `--` 뒤 option은 recovery CLI에 그대로 전달된다.

## 실행 중 online backup

Backup은 SQLite online backup API를 사용하므로 server가 실행 중이어도 허용한다.

```sh
pnpm storage:backup -- \
  --database /data/er-diagram.sqlite \
  --output /backups/backup-2026-08-31
```

성공 stdout은 source-free JSON manifest다. Native SQLite 오류, DBML·SQL source와 filesystem 내부 정보는 stderr에
출력하지 않는다. Output에는 정확히 다음 두 file만 있어야 한다.

```text
backup-2026-08-31/
├── manifest.json
└── database.sqlite
```

## Restore dry-run

Restore는 기본적으로 target을 변경하지 않는다. Server가 실행 중이어도 dry-run은 가능하다.

```sh
pnpm storage:restore -- \
  --backup /backups/backup-2026-08-31 \
  --database /data/er-diagram.sqlite
```

출력의 `plan.planHash`를 기록한다. Dry-run은 backup allowlist·permission·manifest/hash, full SQLite integrity,
migration prefix와 product data invariant를 검사한다. 지원되는 구버전이면 temporary candidate에서 migration하고
close/reopen한 결과 hash까지 plan에 포함한다.

## Restore Apply

1. Application server를 완전히 중지한다.
2. 위 dry-run 이후 backup과 target을 변경하지 않는다.
3. Existing target이면 새로운 `--safety-backup-output`을 지정한다.
4. Dry-run의 exact plan hash로 Apply한다.

```sh
pnpm storage:restore -- \
  --backup /backups/backup-2026-08-31 \
  --database /data/er-diagram.sqlite \
  --apply \
  --plan-hash <dry-run-plan-hash> \
  --safety-backup-output /backups/pre-restore-2026-08-31
```

Target이 없었던 새 volume restore에는 safety backup option이 필요 없다. Existing target에서는 safety backup의
database checksum이 dry-run target checksum과 일치해야 교체한다. Candidate는 target과 같은 filesystem에서 atomic
rename하며 read-back 실패 시 기존 target을 자동 복구한다. 성공 뒤에도 safety backup은 보존한다.

`SQLITE_VOLUME_TARGET_BUSY`이면 server 또는 다른 SQLite writer가 아직 살아 있다. Process를 중지한 뒤 새 dry-run
plan을 발급한다. `SQLITE_VOLUME_RECOVERY_PLAN_CONFLICT`이면 backup, target 또는 migration set이 바뀐 것이므로 기존
hash를 재사용하지 말고 dry-run부터 다시 실행한다.

## Pre-migration dry-run과 Apply

지원되는 구버전 database를 migration하기 전에 다음 dry-run을 실행한다.

```sh
pnpm storage:migrate -- \
  --database /data/er-diagram.sqlite \
  --backup-output /backups/pre-migration-2026-08-31
```

구버전이면 exact pre-migration backup을 먼저 만들고 migrated staging candidate의 plan hash를 반환한다. 이미 current
schema면 `requiresMigration=false`인 no-op plan을 반환하며 backup directory를 만들지 않는다.

Apply 전 server를 중지하고 같은 plan hash를 전달한다.

```sh
pnpm storage:migrate -- \
  --database /data/er-diagram.sqlite \
  --backup-output /backups/pre-migration-2026-08-31 \
  --apply \
  --plan-hash <dry-run-plan-hash>
```

Apply는 원본 checksum과 pre-migration backup을 다시 확인한다. Migration 또는 read-back 실패에서는 원본 database를
교체하지 않는다. Production startup은 기본 `MANUAL`이므로 이 수동 절차가 기본이다. 명시적인 maintenance 시작에서만
`ER_DIAGRAM_STARTUP_MIGRATION=APPLY_WITH_BACKUP`과 absolute non-existing
`ER_DIAGRAM_STARTUP_MIGRATION_BACKUP_OUTPUT`을 함께 설정해 동일 plan/backup/Apply primitive를 사용할 수 있다.

## 실행 중 server와 lifecycle lock

Production runtime은 database와 별도인 `<database>.lock` private sidecar에 operating-system-backed exclusive lease를
유지한다. Restore·migration `--apply`가 `SQLITE_VOLUME_LOCKED`를 반환하면 server를 완전히 중지하고 새 dry-run을
발급한다. Lock file을 삭제하거나 PID를 추측해 우회하지 않는다. Crash나 `SIGKILL` 뒤에는 OS가 lease를 해제하므로
같은 volume에서 새 process를 시작하면 된다.

Online backup과 restore/migration dry-run은 target을 바꾸지 않으므로 running server와 병행할 수 있다. Lock sidecar는
whole-volume backup과 portable bundle에 포함되지 않는다.

## Rollback drill

Restore 후 문제가 발견되면 server를 중지한 상태에서 `--safety-backup-output` directory를 새로운 restore source로
사용한다. 안전 backup에 대해 다시 dry-run plan을 만들고 별도의 새 safety output으로 Apply한다. Recovery output을
직접 수정하거나 `database.sqlite`만 복사하지 않는다.
