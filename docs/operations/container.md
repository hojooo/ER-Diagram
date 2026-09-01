# Container 운영 절차

이 runbook은 Node 24 non-root production image를 localhost에서 실행하고 named volume을 보존하는 기본 절차다.
원격 공개, TLS/reverse proxy, strict environment override와 graceful shutdown은 M4-006 이후 운영 경계를 따른다.

## 요구사항과 기본 경계

- Docker Engine 또는 OrbStack과 Docker Compose
- host endpoint: `http://127.0.0.1:8080`
- container listener: `0.0.0.0:8080`
- data file: `/data/er-diagram.sqlite`
- runtime user: UID/GID 1000인 `node`
- memory 2 GiB, PID 128, Linux capability 없음, `no-new-privileges`

기본 Compose는 외부 network 차단이나 authentication을 제공하지 않는다. Loopback bind를 `0.0.0.0`으로 바꾸지 말고,
원격 접근이 필요하면 access control이 있는 reverse proxy 뒤에 둔다.

## Build와 시작

Repository root에서 다음을 실행한다.

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

Browser에서 `http://127.0.0.1:8080`을 연다. Web SPA, API, Monaco, parser worker와 ELK worker는 image 내부 asset만
사용한다. 상태 확인과 source-free operational log는 다음처럼 본다.

```sh
curl --fail http://127.0.0.1:8080/health/live
docker compose logs --no-color er-diagram
```

`/health/live`는 process liveness만 나타낸다. Storage readiness와 Compose healthcheck는 M4-006에서 추가한다.

## 중지와 container 교체

```sh
docker compose down
docker compose up -d
```

`docker compose down`은 container와 network만 제거하고 named volume은 유지한다. Project source와 revision이 다시
조회되는지 확인한다. `docker compose down --volumes`는 application data를 제거하므로 신규 disposable 환경이 아닌
곳에서는 실행하지 않는다.

## Named volume backup

Whole-volume backup에는 ADR 0010의 검증된 online backup CLI를 사용한다. 실행 중 container에서 volume 내부의 새
private output directory를 만든 뒤 host로 복사한다.

```sh
docker compose exec er-diagram \
  node dist/volume-recovery-cli.js backup \
  --database /data/er-diagram.sqlite \
  --output /data/backup-2026-08-31

docker compose cp \
  er-diagram:/data/backup-2026-08-31 \
  ./backup-2026-08-31
```

복사본의 `manifest.json`과 `database.sqlite`를 함께 보존한다. Snapshot에는 canonical DBML과 retained SQL이 포함될
수 있으므로 암호화·접근 통제·retention은 operator 책임이다. Restore와 migration Apply는 server를 중지한 뒤
[SQLite volume backup·restore runbook](backup-restore.md)의 plan-hash 절차를 따른다.

## Optional host bind mount

Named volume 대신 host directory가 필요한 경우에만 별도 override를 사용한다.

```sh
mkdir -p ./data
chown 1000:1000 ./data
ER_DIAGRAM_DATA_DIRECTORY="$PWD/data" \
  docker compose -f compose.yaml -f compose.bind.yaml up --build -d
```

macOS Docker Desktop·OrbStack에서는 numeric ownership이 VM을 거쳐 표시될 수 있다. Container 안에서 UID 1000이
`/data`에 쓸 수 있는지 확인한다. Bind directory의 permission, filesystem backup, free space와 accidental deletion은
operator가 관리한다. 기본 named volume과 bind override를 동시에 다른 Compose 명령으로 혼용하지 않는다.

## Startup failure와 migration-required 복구

Image는 기존 database를 자동 migration하지 않는다. Web root 누락, corrupt database, future schema 또는 migration
history 불일치에서는 source와 native SQLite error를 출력하지 않고 stable startup code로 종료한다.

`SERVER_STORAGE_MIGRATION_REQUIRED`이면 다음 순서를 따른다.

1. Current container를 중지한다.
2. 현재 image 또는 repository의 `storage:migrate`로 dry-run plan과 pre-migration backup을 만든다.
3. 같은 plan hash로 offline Apply한다.
4. Container를 다시 시작하고 project와 revision을 확인한다.

지원하지 않는 future schema나 divergent migration history는 강제로 고치지 않는다. 해당 database를 만든 compatible
release에서 whole-volume backup 또는 portable project bundle을 다시 생성한다.

## Packaging acceptance

`pnpm test:container`는 고유 Compose project와 volume을 만들고 다음을 검증한 뒤 자신의 자원만 제거한다.

- exact Node 24 runtime, non-root ownership과 production-only dependency closure
- native SQLite, migration과 resource worker 실행
- localhost port, memory/PID/capability 설정
- same-origin SPA/API, CSP, cache와 JSON 404 경계
- 실제 Chromium의 Monaco/parser/layout worker
- container replacement 후 named-volume source·revision 복구
