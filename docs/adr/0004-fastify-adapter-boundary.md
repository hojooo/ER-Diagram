# ADR 0004: Fastify adapter와 framework replacement boundary

- 상태: `ACCEPTED`
- 결정일: 2026-08-26
- 적용 범위: P0

## Context

P0 HTTP surface는 project, revision, layout, visual command와 SQL import/export를 제공하지만 single-user이고 authentication, queue, WebSocket orchestration이 없다. Fastify는 이 범위에 작은 adapter를 제공한다. 향후 조직 요구로 NestJS가 필요할 가능성은 있으나 그 가능성만으로 core use case를 framework abstraction에 맞추면 초기 복잡도만 늘어난다.

## Decision

Fastify를 P0 HTTP/CLI adapter와 composition root로 사용하고 import를 `apps/server`로 제한한다.

- Request parsing과 Zod boundary validation은 `apps/server`가 담당한다.
- Business invariant, optimistic concurrency, transaction orchestration과 result mapping은 framework-free application use case가 담당한다.
- Persistence, clock, ID generation 같은 외부 기능은 명시적 port로 주입한다.
- HTTP status, correlation ID와 public error body는 `packages/contracts`의 versioned contract를 따른다.
- Full DBML·SQL source와 query literal을 application log에 남기지 않는다.
- `packages/core`와 `packages/source-transform`은 Fastify 또는 NestJS type을 import하지 않는다.
- Fastify request는 strict Zod schema로 검증하고 response도 같은 contract로 검증한 plain data만 보낸다.
- Correlation ID는 server가 생성하고 inbound request ID header를 신뢰하지 않는다. 성공과 실패 응답에
  동일한 `x-correlation-id`를 제공한다.
- Client `commandId`는 write contract에서 UUID로 검증하고 `x-command-id`로 반환하지만 M1 adapter는
  durable replay 방지를 주장하지 않는다.
- Invalid DBML draft의 저장은 transport error가 아니라 diagnostics를 포함한 application success로
  mapping한다.
- SQL import preview conversion 실패도 artifact와 report를 반환하는 application success로 mapping해
  HTTP `200`을 사용한다. Project·artifact 부재는 `404`, schema/evidence/replay conflict는 `409`, dialect·
  conversion·data-policy 적용 차단은 `422`, persisted artifact invariant는 source를 가린 `500`으로
  mapping한다.
- SQL import route는 strict request parse, `x-command-id` echo, application 호출과 response validation만
  수행한다. Preview hash 생성, authoritative Apply reparse와 SQLite transaction은 handler 밖에 둔다.
- `POST /api/v1/sql-import/preview`는 project persistence가 없는 stateless conversion을 HTTP `200`으로
  mapping한다. 기존 `POST /api/v1/projects` union의 `CREATE_FROM_SQL_IMPORT`는 Core의 authoritative
  reparse와 atomic create use case만 호출하며 성공 시 `201`을 반환한다.
- Stateless preview hash mismatch는 `409`, invalid name·conversion failure·schema element 부재·DML 확인
  누락은 `422`로 mapping한다. Response와 error에는 original SQL, row literal과 내부 persistence 원인을
  포함하지 않는다.
- Project SQL export는 state를 변경하지 않는 `POST`이므로 request body에 expected revision과 source
  selection을 받되 write용 `commandId`와 `x-command-id`는 사용하지 않는다. Target dialect는 HTTP 입력으로
  받지 않고 project primary dialect로 고정한다.
- Export conversion의 fatal result는 검토 가능한 report를 포함한 HTTP `200`으로 mapping한다. Project 부재는
  `404`, stale revision은 `409`, invalid current 또는 last-valid 부재는 `422`, stored project invariant는
  source를 가린 `500`으로 mapping한다.

NestJS 전환이 필요하면 `apps/server` adapter와 composition을 교체하고 contracts, use cases, ports, SQLite adapter를 재사용한다. Authentication, multi-user authorization, queue, WebSocket 또는 복잡한 integration 요구가 실제로 확정될 때 별도 ADR을 작성한다. Spring Boot는 JVM 조직 표준이나 enterprise integration이 제품 핵심이 되는 경우에만 다시 검토한다.

## Alternatives considered

### 처음부터 NestJS 사용

Module, decorator와 integration ecosystem은 향후 복잡한 server에는 유리하지만 P0 endpoint와 single-process composition에는 추가 구조와 framework coupling이 더 크다.

### Fastify handler에 business logic 구현

초기 코드는 짧지만 HTTP transport, transaction, parser behavior가 결합되어 adapter 교체와 focused use-case test가 어려워진다.

### 모든 framework를 감싸는 자체 abstraction

현재 두 framework를 동시에 지원하지 않으므로 실제 공통점보다 추측에 기반한 interface가 될 가능성이 높다. Core의 input/output과 port가 필요한 replacement boundary를 이미 제공한다.

## Consequences

- P0 server 구현과 integration test가 작고 명시적이다.
- Fastify-specific plugin, lifecycle과 error mapping은 `apps/server`에서만 관리한다.
- Fastify `inject` test는 실제 file-backed SQLite adapter까지 연결하되 server factory에는 project,
  layout, SQL import와 SQL export application을 주입해 persistence와 parser 정책을 HTTP handler에서 분리한다.
- Framework 교체 시 HTTP bootstrap과 adapter test는 다시 작성하지만 business rule과 persistence adapter는 유지할 수 있다.
- Core contract 변경 없이 해결할 수 없는 server 요구가 생기면 먼저 제품 범위와 ADR을 갱신해야 한다.

## Verification

- `apps/server` 밖의 Fastify import를 architecture check가 거부해야 한다.
- Use-case unit test는 Fastify server 없이 실행되어야 한다.
- Fastify `inject` integration test는 Zod validation, status와 error response contract를 검증해야 한다.
- NestJS dependency는 별도 ADR 승인 전 direct dependency에 추가하지 않는다.
