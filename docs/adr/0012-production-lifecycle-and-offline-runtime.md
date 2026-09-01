# ADR 0012: Production lifecycle과 offline runtime

- 상태: `ACCEPTED`
- 결정일: 2026-08-31
- 적용 범위: P0

## Context

Container image와 same-origin Web/API가 존재해도 process가 SQLite를 열기 전의 migration 정책, 단일 volume
ownership, readiness, reverse proxy 신뢰, signal 종료 순서가 명시되지 않으면 안전한 운영 경계가 아니다. 두
process가 같은 SQLite volume을 동시에 열거나, forwarded HTTPS header를 모든 origin에서 신뢰하거나, 종료 중인
process가 ready로 남으면 data integrity와 transport policy를 잘못 주장하게 된다.

Liveness와 readiness도 분리해야 한다. Worker queue나 migration 여부를 liveness에 결합하면 orchestrator가 정상
process를 반복 종료한다. 반대로 listener만으로 readiness를 판단하면 storage가 손상됐거나 volume ownership을 잃은
runtime으로 traffic을 보낼 수 있다. P0는 외부 service를 요구하지 않으므로 outbound network가 없는 환경에서도
packaged Web, parser와 layout worker, API와 SQLite autosave가 동작해야 한다.

## Decision

### Strict environment와 startup migration

Production entrypoint는 filesystem과 SQLite를 열기 전에 모든 `ER_DIAGRAM_*` 환경변수를 allowlist로 검증한다.
빈 값, 부호·소수·지수 표기, unsafe integer, 모르는 key와 resource cross-field 위반은
`SERVER_CONFIGURATION_INVALID`로 차단한다. Listener `0.0.0.0:8080`, Web `/app/web`, database
`/data/er-diagram.sqlite`는 packaged path로 유지한다.

Startup migration 기본값은 `MANUAL`이다. Current schema는 volume lock 획득 후 다시 검증하고, supported older
schema는 `ER_DIAGRAM_STARTUP_MIGRATION=APPLY_WITH_BACKUP`과 absolute non-existing backup output이 함께 있을
때만 ADR 0010의 plan, verified backup, Apply를 수행한다. Future schema, divergent migration history, backup
collision과 migration 실패는 target을 변경하지 않고 startup을 중단한다.

### Authoritative volume ownership

`<database>.lock` private regular sidecar SQLite file에 별도 connection의 `busy_timeout=0`과 lifetime
`BEGIN EXCLUSIVE`를 유지한다. 두 번째 runtime과 restore·migration Apply는 즉시 `SQLITE_VOLUME_LOCKED`로
실패한다. Online backup과 recovery dry-run은 data file을 변경하지 않으므로 runtime과 병행할 수 있다. Process
crash에서는 operating system이 SQLite lock을 해제하며 PID file 삭제나 stale-lock 강제 해제를 사용하지 않는다.
Sidecar는 project data, portable bundle과 whole-volume snapshot에 포함하지 않는다.

### Health와 lifecycle

Runtime state는 `STARTING → READY → SHUTTING_DOWN → STOPPED|FAILED`다. `/health/live`는 HTTP process가
응답하면 storage와 worker 상태와 무관하게 `200 {"status":"ok"}`를 반환한다. `/health/ready`는 `READY`, 현재
runtime의 volume lock 보유와 SQLite schema metadata read probe를 모두 만족할 때만
`200 {"status":"ready"}`다. 나머지는 `503 SERVER_NOT_READY`, `Cache-Control: no-store`, `Retry-After: 1`을
반환한다.

첫 `SIGTERM`·`SIGINT`는 readiness를 즉시 내리고 중복 shutdown을 한 Promise로 합친다. Fastify close가 신규
요청을 차단하고 이미 수신한 요청을 drain한 뒤 resource worker, SQLite, operational log flush와 volume lock
해제를 순서대로 수행한다. 기본 30초 timeout 또는 두 번째 signal은 exit code 1로 fail closed한다. Browser가
server에 아직 전송하지 않은 local debounce buffer까지 저장한다고 주장하지 않는다.

### Proxy, HSTS와 offline acceptance

Proxy trust 기본값과 HSTS 기본값은 모두 off다. `ER_DIAGRAM_TRUST_PROXY_CIDRS`는 IP/CIDR만 허용하며 hostname,
boolean과 hop count는 거부한다. HSTS는 trusted proxy를 통과해 Fastify가 HTTPS로 판정한 response에만
`max-age`를 추가하고 `includeSubDomains`·`preload`는 사용하지 않는다. Trusted proxy가 없는 HSTS 설정은
startup 오류다.

기본 Compose의 localhost publish는 유지한다. 별도 acceptance harness는 application container를 `internal: true`
network에만 연결하고, 두 network에 연결된 test proxy만 localhost ingress를 제공한다. 이 경계에서 packaged
SPA/API, Monaco, DBML parser worker, React Flow/ELK, source autosave와 reload를 실제 browser로 검증하며 remote
origin request를 허용하지 않는다.

Operational log는 INFO일 때 source-free JSONL을 기본 사용하고 OFF를 허용한다. Lifecycle event에는 state와 static
reason code만 기록한다. Env value, path, source와 native error는 기록하지 않으며 sink `flush()` 실패도 request,
transaction과 lock release를 바꾸지 않는다.

## Alternatives considered

### 자동 startup migration

편리하지만 operator가 backup destination과 maintenance window를 선택하기 전에 mounted volume을 변경한다. P0는
manual을 기본으로 하고 explicit backup mode만 자동 Apply를 허용한다.

### PID file만으로 volume ownership 판단

Crash 뒤 stale PID, PID reuse와 container namespace 때문에 안전한 ownership 증거가 아니다. OS가 process 종료와
함께 해제하는 SQLite exclusive lock을 authoritative lease로 사용한다.

### 모든 forwarded header 또는 hop count 신뢰

Direct origin 접근에서 공격자가 `X-Forwarded-Proto`를 spoof할 수 있다. 명시적 proxy CIDR만 신뢰한다.

### 기본 Compose network를 internal로 변경

Single-service container에 ingress proxy가 없으므로 localhost quickstart를 깨뜨린다. Offline 보장은 별도 두-network
acceptance에서 검증하고 기본 운영 형태는 유지한다.

## Consequences

- 한 SQLite volume에는 lifecycle-aware production runtime 또는 offline Apply 하나만 write ownership을 가진다.
- Readiness는 liveness와 독립적이며 Compose는 readiness endpoint를 healthcheck로 사용한다.
- Opt-in startup migration은 verified backup artifact를 남기며 collision 시 overwrite하지 않는다.
- Graceful shutdown은 server가 이미 받은 atomic write만 drain한다. Browser local buffer는 기존 navigation 보호
  책임으로 남는다.
- Application TLS와 authentication, default automatic migration과 distributed/multi-process SQLite는 P0 범위가
  아니다.

## Verification

- `pnpm --filter @er-diagram/contracts test test/health-api-contract.test.ts`
- `pnpm --filter @er-diagram/storage-sqlite test test/volume-lock.test.ts`
- `pnpm --filter @er-diagram/server test production-config`
- `pnpm --filter @er-diagram/server test:integration production-lifecycle`
- `pnpm test:runtime-lifecycle`
- `pnpm test:container`
