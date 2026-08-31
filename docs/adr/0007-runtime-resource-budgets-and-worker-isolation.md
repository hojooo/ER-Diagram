# ADR 0007: Runtime resource budget과 bounded worker isolation

- 상태: `ACCEPTED`
- 결정일: 2026-08-31
- 적용 범위: P0

## Context

DBML·SQL source, generated DDL, normalized graph와 ELK projection은 모두 사용자가 제어하는 입력에서 크기가
결정된다. Fastify body limit만 두면 압축되지 않은 JSON body는 제한할 수 있어도 Unicode source의 실제
UTF-8 크기, parser가 만든 graph, generated output과 CPU 시간을 제어할 수 없다. Browser worker timeout만
두어도 server process의 parser, SQL conversion과 visual transform이 main event loop 또는 process heap을
고갈시키는 경로가 남는다.

Self-host operator와 browser는 같은 제한을 알아야 한다. Client에 compile-time 숫자만 두면 server override와
달라져 oversized file을 읽거나 mutation을 전송한 뒤에야 실패한다. 반대로 client preflight만 신뢰하면 raw
HTTP caller, 저장된 legacy source와 worker protocol을 통해 제한을 우회할 수 있다.

## Decision

`RuntimeResourceLimits` version 1을 Contracts의 plain-data Zod contract로 정의하고
`GET /api/v1/runtime-config`에서 `Cache-Control: no-store`로 제공한다. Web application은 이 응답을 검증하기
전에는 router, project query, parser 또는 layout worker를 시작하지 않는다. 설정 조회 실패는 accessible
startup error와 명시적 Retry로만 복구한다. ADR 0012의 production bootstrap은 strict environment allowlist로
이 contract의 모든 server resource limit을 override하며 같은 cross-field validation을 다시 사용한다.

Balanced P0 기본 profile은 다음과 같다.

| Resource | Default |
| --- | ---: |
| DBML·SQL source | 5 MiB UTF-8 |
| Generated SQL/report transport | 16 MiB |
| Fastify raw JSON body | 32 MiB |
| DBML parse / visual transform | 5 seconds |
| SQL import/export conversion | 15 seconds |
| ELK layout | 10 seconds |
| Node workers / FIFO queue | 2 / 8 |
| Queue wait | 5 seconds |
| Worker old / young / stack memory | 256 / 32 / 4 MiB |
| Tables / references / total schema elements | 2,000 / 10,000 / 100,000 |
| Layout nodes / edges | 2,500 / 10,000 |
| Bundle archive / expanded / entry / count | 256 MiB / 1 GiB / 16 MiB / 2,048 |

UTF-8 source size는 JavaScript code-unit 길이가 아니라 lone surrogate를 replacement character로 처리하는
platform UTF-8 encoding과 같은 공용 helper로 계산한다. Total schema element는 table, column, enum과 value,
reference, index, check, group, partial과 injected child, view, note를 모두 합산한다. Bundle 값은 M4-002와
M4-003의 bounded archive reader가 사용할 contract이며 이번 결정에서 archive format을 만들지는 않는다.

Server composition은 DBML parse, SQL import/export conversion과 visual source transform을 persistent
`worker_threads` pool로 보낸다. Worker 두 개는 각각 한 operation만 처리하고 FIFO queue는 여덟 개까지만
받는다. Queue full 또는 wait timeout은 busy error다. Operation timeout, crash, protocol mismatch와 V8 heap
exhaustion은 해당 worker만 terminate하고 새 worker로 교체한다. Server close는 active와 queued operation을
모두 실패시키고 worker를 종료한다. SQLite transaction은 worker 결과가 성공한 뒤에만 시작하므로 resource
failure가 revision, artifact, receipt 또는 layout row를 만들지 않는다.

제한은 여러 신뢰 경계에서 중복 적용한다.

- Fastify는 raw JSON body를 제한하고 route adapter는 decoded source와 layout position 수를 검사한다.
- Node worker는 source byte, parsed graph와 serialized/generated output을 다시 검사한다.
- Browser는 `File.size`를 먼저 검사해 oversized file에서 `file.text()`를 호출하지 않는다.
- Monaco와 SQL textarea는 UTF-8 byte를 검사해 local buffer를 보존하면서 parse와 mutation을 중지한다.
- Parser와 layout worker request는 effective count/byte budget을 포함하고 worker도 결과 반환 전에 재검사한다.
- Stored legacy source는 read와 backup을 위해 자르지 않고 반환하지만 parse, mutation과 export에는 현재 제한을
  적용한다.

Resource error는 source, SQL literal, worker/native error와 stack을 포함하지 않는다. Source/body 초과는
각각 `RESOURCE_SOURCE_TOO_LARGE`와 `REQUEST_BODY_TOO_LARGE` 413, graph/output 초과는 422, busy/timeout/crash는
503이다. Queue pressure만 `Retry-After: 1`을 반환한다. 사용자는 oversized local buffer를 줄일 때까지
unsaved-navigation protection을 유지한다.

## Alternatives considered

### Fastify body limit만 적용

Raw transport는 제한하지만 decoded source, stored source, parser expansion, generated output과 CPU 시간을
제어하지 못한다. 또한 source와 envelope 크기를 같은 오류로만 보고하게 된다.

### Operation마다 새 worker 생성

Isolation은 단순하지만 pinned parser와 exporter module을 매 요청마다 로드해 정상 작업 latency와 memory
churn이 커진다. 작은 persistent pool이 동시성 상한과 module warm-up을 함께 제공한다.

### Browser preflight를 server enforcement로 사용

Browser가 아닌 HTTP caller와 변조된 worker message가 우회할 수 있다. Client 검사는 UX 최적화이고 server와
worker의 독립 검사가 authoritative하다.

### Worker timeout만 적용하고 memory budget은 container에 위임

Timeout 이전의 heap exhaustion이 전체 server process를 불안정하게 만들 수 있다. Worker V8 budget은 해당
isolate만 종료한다. 다만 native/external memory와 전체 process RSS를 완전하게 보장하지 않으므로 OCI memory
limit과 process 운영 기준은 ADR 0011의 2 GiB container budget과 ADR 0012의 strict environment·shutdown
lifecycle에서 보완한다.

## Consequences

- Runtime parser/exporter/source-transform object는 worker 경계에서 structured-clone 가능한 plain data만
  오간다.
- Worker pool 크기만큼 parser module memory가 상주하지만 동시 작업과 failure blast radius가 제한된다.
- Browser와 server는 같은 공개 값으로 preflight하되 server 검사를 생략하지 않는다.
- Existing oversized project는 유실 없이 조회·backup할 수 있으나 축소하기 전에는 parse·mutation·export가
  차단된다.
- Large Vite worker chunk 자체는 runtime input/output budget과 다른 build artifact 문제다. Offline packaging과
  container memory acceptance에서 별도로 관찰한다.
- Bundle reader와 production static serving은 이 contract를 소비한다. Production environment override와
  graceful shutdown의 worker drain 순서는 ADR 0012가 확정한다.

## Verification

- ASCII, Unicode, emoji, CRLF와 unpaired surrogate의 정확한 UTF-8 경계를 검사한다.
- Source, raw body, graph, generated output와 layout projection이 limit 직전에는 통과하고 초과 시 올바른
  redacted error와 status를 반환하는지 검사한다.
- Oversized file에서 read, parser worker와 fetch가 호출되지 않고 Monaco/textarea buffer가 유지되는지 검사한다.
- Built Node worker에서 DBML, SQL import/export와 visual transform을 실행하고 hang, crash, V8 heap exhaustion,
  protocol error와 queue pressure 뒤 worker 교체를 검사한다.
- Worker가 점유된 동안 `/health/live`가 응답하고 resource failure 뒤 SQLite project/revision/artifact/receipt/layout
  상태가 바뀌지 않는지 검사한다.
- Browser startup retry, parser/layout cap과 worker termination/recreation을 검사한다.
- `pnpm test:security limits-timeouts`를 focused security gate로 사용한다.
