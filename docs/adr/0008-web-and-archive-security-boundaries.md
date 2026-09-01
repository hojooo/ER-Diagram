# ADR 0008: Web CSP, bounded ZIP과 redacted operational logging

- 상태: `ACCEPTED`
- 결정일: 2026-08-31
- 적용 범위: P0

## Context

DBML, SQL, project 이름과 diagnostic은 사용자가 제어하는 text다. React text rendering과 Monaco model은
기본적으로 이를 실행하지 않지만, unsafe DOM sink 또는 느슨한 browser policy가 추가되면 source fidelity를
유지한 문자열이 script나 HTML로 해석될 수 있다. Monaco와 React Flow는 runtime inline style을 사용하므로
script와 style에 같은 CSP 제한을 적용하면 editor와 diagram이 동작하지 않는다.

Portable bundle은 아직 format과 manifest를 정의하지 않았지만 M4-001에서 archive, expanded data, entry와
count budget을 이미 공개했다. Path 문자열이나 ZIP metadata만 신뢰하면 traversal, duplicate path, symlink,
special file과 decompression bomb가 filesystem 또는 memory 경계를 넘을 수 있다. 운영 로그 역시 Fastify
request나 error object를 그대로 직렬화하면 DBML, SQL literal, note와 native error를 유출할 수 있다.

## Decision

Fastify는 모든 HTTP response에 enforced Content Security Policy와 security header를 적용한다. Script와 worker,
connection은 same-origin만 허용하고 inline script, script attribute, eval, object, frame과 외부 embedding을
차단한다. Monaco와 React Flow 호환을 위해 style에만 `unsafe-inline`을 허용한다. 이 예외를 script policy로
확장하지 않는다. ADR 0012에 따라 HSTS 기본값은 off이며, 명시한 proxy IP/CIDR를 통과해 HTTPS로 판정된 response에만
제한된 `max-age`를 추가한다. Application 자체 TLS는 제공하지 않는다.

Production source에서는 `dangerouslySetInnerHTML`, HTML insertion API, `document.write`, `srcdoc`, `eval`과
`Function`을 fail-closed 검사로 금지한다. Canonical DBML·SQL이나 사용자 text를 sanitize하거나 rewrite하지
않는다. JSX text, textarea, Monaco와 download는 byte fidelity를 유지하고 executable sink만 허용하지 않는다.
Shared Zod contract는 `jitless` mode를 schema 생성 전에 전역 적용해 strict `script-src 'self'` 아래에서도
`Function` constructor probe 없이 request와 response를 검증한다.

Portable archive container는 ZIP으로 고정하고 server adapter의 file-backed bounded reader가 `yauzl`의 lazy
central-directory traversal을 사용한다. Reader는 archive를 filesystem에 extract하지 않는다. Input file은
symlink를 따라가지 않고 regular file인지 확인하며, 모든 entry metadata를 먼저 검증한 뒤 content stream을
순차적으로 읽는다. Absolute/parent/Windows path, portable-name collision, encrypted entry, non-regular Unix
type, Store·Deflate 이외 compression과 M4-001 budget 초과는 archive 전체 실패다. Declared size뿐 아니라
실제 decompressed byte도 센다. Safe zero-byte directory는 count에 포함하지만 content visitor에는 전달하지
않는다.

M4-002 reader는 container structure, path, entry type과 resource budget만 보장한다. Bundle manifest, exact
entry allowlist, version, per-entry/root SHA-256, import/export API와 atomic restore는 ADR 0009가 담당한다. Reader
consumer는 최종 destination에 직접 쓰지 않고 staging을 사용하며 전체 성공 후에만 commit한다.

Operational logging은 versioned allowlist event를 newline-delimited JSON으로 기록한다. Production SQLite
composition은 stdout sink를 기본 사용하고 tests와 low-level adapter는 sink를 주입할 수 있다. UTC timestamp,
correlation ID, static operation, method/status/latency, validated opaque project ID, safe byte·element count, parser/exporter
version과 diagnostic/error code만 허용한다. Raw URL, query, headers, body, source, SQL literal, note, command,
response, diagnostic message, native error와 stack은 event type에 존재하지 않는다. Sink failure는 request나
transaction 결과를 바꾸지 않는다.

## Alternatives considered

### Report-only CSP

호환성 관찰에는 유용하지만 P0에서 inline script와 remote resource를 실제로 차단하지 않는다. Production
build browser acceptance로 enforced policy를 검증한다.

### Style nonce-only CSP

Monaco 0.56과 React Flow의 runtime style injection을 별도 adapter로 바꿔야 한다. M4-002에서는 script 경계를
약화하지 않고 style에만 제한된 예외를 둔다.

### Format-neutral archive validator

실제 central directory, compression metadata와 Unix entry type을 검증하지 못해 traversal·bomb·symlink 방어를
증명할 수 없다. ZIP container와 concrete lazy reader를 먼저 고정하고 semantic bundle format은 후속으로
분리한다.

### Fastify request/error 자동 logging

Serializer 누락 하나로 source나 native error가 기록될 수 있다. Product log는 request object가 아니라
명시적 allowlist event만 받는다.

## Consequences

- Monaco와 diagram은 inline style을 사용하지만 script, worker와 remote resource policy는 엄격히 유지된다.
- ZIP metadata와 content는 bounded stream으로 읽고 filesystem extraction surface를 만들지 않는다.
- CRC는 bundle content integrity의 근거로 사용하지 않는다. M4-003 manifest SHA-256이 이를 검증한다.
- Production log는 INFO/OFF allowlist 환경 설정을 사용한다. Lifecycle event에는 state와 static reason code만
  추가하며 graceful shutdown은 pending JSONL write를 best-effort flush한다.
- Production Browser→Fastify static serving은 M4-005 container acceptance에서 same-origin SPA/API, asset cache와
  실제 Monaco/parser/layout worker까지 검증한다. M4-002 browser harness는 built Web assets와 동일 CSP의 호환성을
  먼저 증명한 경계로 유지한다.

## Verification

- 모든 Fastify status path에서 CSP와 framing/header policy를 검사한다.
- Script-like text와 unsafe DOM sink, malicious CSS value, Monaco/textarea/download fidelity를 검사한다.
- ZIP traversal, collision, non-regular entry, encryption, compression, corruption과 exact/over budget을 검사한다.
- 성공과 failure log에서 allowlist metadata만 남고 source/native sentinel이 없는지 검사한다.
- Production Vite build에서 Monaco, parser/layout worker와 React Flow가 CSP violation 없이 동작하는지 검사한다.
- `pnpm test:security`와 `pnpm test:e2e:security`를 focused M4-002 gate로 사용한다.
