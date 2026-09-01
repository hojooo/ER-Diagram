# DBML·SQL ERD Studio 구현 Tasklist

## 1. 구현 기준

- 제품 표시명: `DBML·SQL ERD Studio`
- npm scope: `@er-diagram/*`
- 라이선스: `Apache-2.0`
- 저작권자: `Copyright 2026 hojooo`
- 배포: 공개 GitHub source + `ghcr.io/hojooo/er-diagram`
- P0 server adapter: Fastify
- 확장 경계: framework-free core/application/contracts를 유지해 NestJS adapter로 교체 가능
- 런타임: Node.js 24 LTS, pnpm 10
- P0 SQL: PostgreSQL 14+, MySQL 8.0+ same-dialect DDL import/export
- P1 SQL: 실행 없는 PostgreSQL·MySQL `SELECT` table-level lineage

### 고정 기술 기준

| 영역 | 기준 |
| --- | --- |
| Web | React 19.2.8, React Router DOM 7.18.2, Vite 8.2.2, TypeScript 7.0.2 |
| Server | Fastify 5.12.1, `@fastify/helmet` 13.0.0, `yauzl` 3.4.0 |
| DBML | `@dbml/core`, `@dbml/parse` 9.1.1 exact pin; `@dbml/connector` P0 제외 |
| Diagram | `@xyflow/react` 12.11.5, ELK.js 0.12.0 |
| Editor | Monaco Editor 0.56.0 |
| Store | SQLite, Drizzle ORM 0.45.2, better-sqlite3 13.0.3 |
| Contract | Zod 4.4.3 |
| Client state | TanStack Query 5.102.4, Zustand 5.0.15 |
| UI | Tailwind CSS 4.3.3, Radix Dialog 1.1.23, 필요한 접근성 widget만 Radix primitive 사용 |
| Test | Vitest 4.1.11, React Testing Library 16.3.2, Playwright 1.62.1 |
| P1 SQL AST | node-sql-parser 5.4.0 |
| Quality | Biome format/lint, strict TypeScript, dependency-cruiser architecture check |

모든 direct dependency는 exact version으로 저장하고 `pnpm-lock.yaml`을 커밋한다.

### 기술 스택 선정 원칙

기술 스택은 다음 우선순위로 선정한다.

1. **DBML source fidelity**: parser나 visual editor의 편의를 위해 comment, source range,
   `TablePartial`, `TableGroup`, `DiagramView` 같은 표준 문법을 손실하지 않는다.
2. **single-user self-host 단순성**: 별도 database server나 분산 infrastructure 없이 하나의
   container와 mounted volume으로 실행·백업·복구할 수 있어야 한다.
3. **교체 가능한 adapter 경계**: UI, HTTP framework, persistence 기술이 parser·semantic diff·
   application use case를 오염시키지 않아야 한다.
4. **대규모 ERD의 반응성**: parsing과 layout을 worker로 격리하고 view·group·LOD로 rendering
   범위를 줄일 수 있어야 한다.
5. **재현 가능한 open-source 배포**: local, CI, GHCR image가 같은 dependency graph와 parser
   semantics를 사용하고 third-party license 의무를 추적할 수 있어야 한다.

### 기술별 선정 이유와 경계

| 영역 | 선정 이유 | 한계·재검토 조건 |
| --- | --- | --- |
| Node.js 24 LTS + pnpm 10 | Web, worker, server, CLI, shared contract를 TypeScript 단일 toolchain으로 구성한다. pnpm workspace는 `@er-diagram/*` package의 의존 경계와 exact lockfile 재현성을 관리하기 적합하다. | native module 지원과 release image의 Node ABI를 검증한다. Node major 또는 pnpm major 변경은 lockfile·native build·worker behavior를 다시 검증하는 compatibility event로 취급한다. |
| React 19.2.8 | Monaco와 React Flow를 포함한 상태가 많은 schema workspace를 component 단위로 구성하고, source·diagram·inspector의 선택 상태를 명시적으로 동기화하기 위해 사용한다. | React state를 canonical DBML이나 durable revision의 정본으로 사용하지 않는다. 다른 UI runtime으로의 교체는 web package 내부 변경으로 제한한다. |
| React Router DOM 7.18.2 | Project Home과 project별 workspace를 URL로 분리하고, 새로고침·뒤로 가기·not-found·route error 상태를 SPA 안에서 명시적으로 표현한다. | route state를 project 정본으로 사용하지 않는다. Production history fallback과 Fastify static serving은 container packaging에서 별도로 검증한다. |
| Vite 8.2.2 | React SPA의 빠른 개발 server와 production bundling을 제공하고 parser/layout Web Worker를 별도 bundle로 구성하기 쉽다. P0에는 SSR이 필요하지 않다. | worker asset, Monaco chunk, offline production build를 실제 container에서 검증한다. SSR·server component가 필요해지면 별도 결정이 필요하다. |
| TypeScript 7.0.2 | parser-neutral graph, visual command, HTTP/worker/bundle contract를 정적 타입으로 공유하고 adapter 경계의 실수를 조기에 탐지한다. | 타입 검사는 runtime 입력이나 semantic invariant 검증을 대체하지 않는다. 외부 입력은 Zod와 application validation을 반드시 통과한다. |
| Fastify 5.12.1 | P0 API가 CRUD, revision conflict, import/export orchestration 중심이므로 작은 HTTP/CLI adapter를 구성하기에 충분하며 core를 framework 밖에 유지하기 쉽다. | auth, multi-user policy, queue, WebSocket orchestration 또는 복잡한 integration이 확정되면 NestJS adapter를 별도 ADR로 검토한다. Fastify plugin을 core로 누출하지 않는다. |
| `@fastify/helmet` 13.0.0 + `yauzl` 3.4.0 | Fastify response에 enforced CSP·security header를 일관 적용하고, file-backed ZIP을 central directory 기반 bounded stream으로 검증한다. | Style inline 예외는 Monaco·React Flow에만 필요한 CSP tradeoff다. Bundle manifest·hash·entry allowlist와 import/export transaction은 M4-003에서 추가하고 archive를 filesystem에 직접 extract하지 않는다. |
| `@dbml/core` + `@dbml/parse` 9.1.1 | 공식 DBML grammar/compiler model과 PostgreSQL·MySQL 변환 경로를 재사용해 custom dialect와 정규식 전처리를 피한다. | parser object를 공개 계약으로 노출하지 않는다. `@dbml/connector` 9.1.1은 호환성 조사에만 사용했으며 live database schema fetch API를 노출하므로 P0에서 설치·pin·import하지 않는다. Version 변경은 revalidation·semantic diff가 필요한 compatibility event다. |
| `@xyflow/react` 12.11.5 | table custom node, relationship edge, selection, viewport, compound parent 같은 interactive diagram 기능을 직접 canvas engine부터 구현하지 않고 제공한다. | React Flow layout을 schema semantics의 정본으로 사용하지 않는다. 대규모 graph에서는 node/edge memoization, viewport culling, LOD를 별도로 적용한다. |
| ELK.js 0.12.0 | group을 포함한 compound graph와 많은 edge의 자동 배치를 UI rendering과 분리해 계산할 수 있다. | layout worker와 timeout을 적용하고 결과는 preview 후 sidecar에만 저장한다. EPL-2.0 notice와 source 제공 안내를 release artifact에서 검증한다. |
| Monaco Editor 0.56.0 | source range diagnostics, navigation, search/replace, bracket matching 등 DBML을 정본으로 다루는 source-first 편집 경험에 적합하다. | bundle 크기와 worker 설정을 관리하고, Monaco model을 durable source로 간주하지 않는다. autosave 전 draft hash와 stale response를 검증한다. |
| SQLite + Drizzle ORM 0.45.2 + better-sqlite3 13.0.3 | single-user self-host에서 별도 DB 운영 없이 mounted volume에 project·revision·layout을 원자 저장한다. Drizzle은 typed schema/migration 표현을, better-sqlite3는 단일 process transaction adapter를 담당한다. | WAL이어도 multi-process horizontal write는 지원하지 않는다. 동시 사용자·원격 DB·고가용성이 요구되면 persistence port를 유지한 채 별도 store를 검토한다. native build와 read-only/full-disk 복구를 검증한다. |
| Zod 4.4.3 | HTTP, worker message, portable bundle, `VisualCommand`처럼 신뢰 경계를 넘는 입력을 runtime에서 검증하면서 TypeScript 타입을 함께 유지한다. | Zod parse 성공은 DBML reparse, semantic diff, 권한 또는 revision invariant 성공을 의미하지 않는다. domain 검증은 core/application에 남긴다. |
| TanStack Query 5.102.4 + Zustand 5.0.15 | server project/revision/layout cache와 editor·selection·viewport·undo 같은 session UI state를 분리해 서로 다른 수명주기를 표현한다. | 동일 데이터를 두 store에 중복 정본화하지 않는다. TanStack Query는 server state, Zustand는 ephemeral client state로 사용하며 canonical source는 server revision에 둔다. |
| Tailwind CSS 4.3.3 + Radix Dialog 1.1.23 | 초기 design token과 responsive layout을 빠르게 일관화하고, destructive confirmation과 form dialog의 focus trap·Escape·focus return만 검증된 접근성 primitive에 맡긴다. | Radix를 전면 component framework로 사용하지 않는다. semantic HTML과 keyboard flow를 우선하고 styling만으로 접근성을 충족했다고 간주하지 않는다. |
| Vitest 4.1.11 + React Testing Library 16.3.2 + Playwright 1.62.1 | Vite/TypeScript와 같은 module 환경에서 parser·use case unit test, 사용자 관점 component test, 실제 browser E2E를 계층별로 구성한다. | mock interaction count보다 source·revision·layout의 관찰 가능한 결과를 검증한다. SQLite restart, container, backup/restore, performance는 browser unit test와 분리된 acceptance gate로 둔다. |
| node-sql-parser 5.4.0 | P1의 PostgreSQL·MySQL `SELECT`를 실행하지 않고 AST로 변환해 table-level lineage 후보를 추출할 수 있다. | P1 전용 adapter에 격리하고 AST를 core 밖으로 노출하지 않는다. 지원하지 않는 syntax와 ambiguity는 확정 edge가 아니라 diagnostic으로 반환하며 SQL 실행 기능을 추가하지 않는다. |
| Biome + strict TypeScript + dependency-cruiser | format/lint/type error를 일관되게 검사하고 Fastify, React, SQLite가 framework-free package로 역류하는 것을 CI에서 차단한다. | 정적 검사는 behavior·source fidelity·runtime security 검증을 대체하지 않는다. architecture rule 변경은 ADR과 forbidden-dependency fixture를 함께 갱신한다. |

exact version 고정은 영구적으로 upgrade를 금지한다는 의미가 아니다. dependency upgrade는 별도 PR에서
parser fidelity, source preservation, SQL semantic round-trip, worker performance, license inventory를
재검증한 뒤 수행한다.

## 2. 구조와 공개 계약

### 2.1 Monorepo 구조와 의존 방향

```text
apps/
  web/                 React SPA, Monaco, React Flow, Web Workers
  server/              Fastify HTTP/CLI adapter, static Web serving
packages/
  core/                parser, normalized graph, semantic diff, application use cases, ports
  contracts/           Zod HTTP/worker/bundle contracts
  source-transform/    VisualCommand → TextEdit → reparse verification
  storage-sqlite/      Drizzle schema, migrations, repository adapters
  test-fixtures/       synthetic DBML/SQL fixtures and generators
docs/
  product/PRD.md
  adr/
  operations/
```

- Fastify import는 `apps/server` 밖에서 금지한다.
- `packages/core`와 `packages/source-transform`은 DOM, React, Fastify, SQLite를 참조하지 않는다.
- `apps/web`은 `packages/storage-sqlite`를 직접 참조하지 않는다.
- NestJS 전환 시 `apps/server`만 교체하고 contracts, use cases, ports, storage adapter를 재사용한다.

### 2.2 핵심 계약

- `PrimaryDialect`: `POSTGRESQL | MYSQL`
- `DraftValidity`: `VALID | INVALID`
- `ConversionStatus`: `EXACT | NORMALIZED | PARTIAL | UNSUPPORTED | ERROR`
- `SchemaGraph`: parser version, semantic hash, tables, enums, references, groups, partials,
  views, diagnostics, source map을 갖는 parser-neutral graph다.
- `VisualCommand`: expected schema revision과 command ID를 포함하고 table, column, reference,
  index, check, group, view의 20개 mutation을 구분하는 strict Zod discriminated union이다.
- 모든 visual mutation은 `VisualCommand → TextEdit[] → full reparse → expected semantic diff`
  순서를 통과해야 한다.

### 2.3 HTTP API

- `GET/POST /api/v1/projects`
- `GET/PATCH/DELETE /api/v1/projects/:projectId`
- `PUT /api/v1/projects/:projectId/draft`
- `GET /api/v1/projects/:projectId/revisions`
- `POST /api/v1/projects/:projectId/revisions/:revisionNo/restore`
- `GET/PUT /api/v1/projects/:projectId/layouts/:viewKey`
- `POST /api/v1/projects/:projectId/visual-commands`
- `POST /api/v1/projects/:projectId/sql-import/preview`
- `POST /api/v1/projects/:projectId/sql-import/apply`
- `POST /api/v1/projects/:projectId/sql-export`
- `GET /health/live`, `GET /health/ready`

모든 write request는 `commandId`와 대상에 맞는 `expectedSchemaRevisionNo` 또는
`expectedLayoutRevisionNo`를 받는다. stale write는 `409`, parse·semantic 실패는 `422`, 크기
초과는 `413`이다. Error response는 `code`, `message`, `correlationId`를 필수로, 현재 revision과
diagnostics를 선택적으로 포함한다.

### 2.4 SQLite schema

- `projects`
- `schema_revisions`
- `diagram_layouts`
- `import_artifacts`
- `visual_command_receipts`
- `app_metadata`

Project·revision·artifact ID는 UUIDv7 text, command ID는 lowercase RFC UUID text, 시간은 UTC ISO-8601
text로 저장한다. `foreign_keys=ON`, WAL mode,
`busy_timeout=5000`을 적용한다. 최근 non-checkpoint revision 100개를 보존하고 import·restore·
parser migration checkpoint는 pruning하지 않는다. `original_sql`은 사용자가 선택한 경우만 저장한다.

## 3. 작업 상태 규칙

- `[ ]`: 검증 증적까지 완료되지 않음
- `[x]`: 구현, 테스트, 명시된 검증, diff 재검토까지 완료
- 각 작업은 가능한 경우 실패하는 behavior test를 먼저 작성한다.
- 부분 구현은 체크하지 않고 작업 기록에서 별도로 추적한다.
- Milestone Gate가 통과하기 전에는 다음 Milestone 완료를 선언하지 않는다.

## 4. 상세 작업 목록

### Milestone 0 — Repository, License, Architecture Spike

- [x] `M0-001` 저장소 정본 구성
  - `README.md`, `AGENTS.md`, `docs/product/PRD.md`, `TASKLIST.md`
  - PRD v0.4 provenance를 보존하고 revision 100개, Release Gate A~F를 확정한다.
  - 검증: Markdown fence/table/trailing whitespace와 미결정 marker가 없어야 한다.
- [x] `M0-002` Apache-2.0 배포 파일 구성
  - `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `scripts/check-licenses.mjs`
  - 검증: `pnpm licenses:check`
- [x] `M0-003` pnpm TypeScript monorepo bootstrap
  - strict ESM, exact direct dependencies, Biome, dependency-cruiser, lockfile
  - 검증: `pnpm install --frozen-lockfile && pnpm check && pnpm build`
- [x] `M0-004` architecture ADR 0001~0004 및 금지 의존성 test
  - Fastify adapter, DBML canonical/source fidelity, SQLite, NestJS replacement boundary
  - 검증: `pnpm architecture:check`
- [x] `M0-005` GitHub Actions CI와 release workflow
  - Node 24, pnpm cache, isolated quality/test/build/release jobs; fork PR publish 금지
  - 검증: `actionlint`, `pnpm ci:verify`
- [x] `M0-006` deterministic synthetic fixture generator
  - fidelity: 143 tables, 86 enums, 4 partials, 15 groups, 7 views, 573 refs
  - scale: 200 tables, 1,000 refs
  - 검증: `pnpm --filter @er-diagram/test-fixtures test`
- [x] `M0-007` DBML v2 parser spike
  - `TablePartial`, `TableGroup`, `DiagramView`, comments, metadata와 source hash를 증명한다.
  - `@dbml/connector`의 비연결 사용 필요성을 확인하고, 근거가 없으면 P0 direct runtime dependency에서 제외한다.
  - 검증: `pnpm --filter @er-diagram/core test parser-spike`
- [x] `M0-008` minimal source transformation spike
  - source range `TextEdit[]`, reverse-offset 적용, reparse와 semantic diff gate
  - 검증: `pnpm --filter @er-diagram/source-transform test fidelity-spike`
- [x] `M0-009` React Flow + ELK compound graph spike
  - 15 groups, collapsed aggregate edge, 7 views, worker/culling/LOD prototype
  - 검증: `pnpm test:perf --scenario layout-spike`
- [x] `M0-GATE` parser fidelity, minimal source patch, scale layout 통과

### Milestone 1 — Read-only Schema Workspace

- [x] `M1-001` stable qualified key와 source range를 갖는 normalized `SchemaGraph`
  - 검증: `pnpm --filter @er-diagram/core test test/normalized-graph.test.ts`
- [x] `M1-002` lexical/syntax/semantic diagnostics와 shared source map
  - 검증: `pnpm --filter @er-diagram/core test test/diagnostics.test.ts`
- [x] `M1-003` canonical semantic hash, add/update/delete diff, rename candidate
  - 검증: `pnpm --filter @er-diagram/core test test/semantic-diff.test.ts`
- [x] `M1-004` SQLite initial five-table migration, WAL/FK/busy timeout, UUIDv7 adapter
  - 검증: `pnpm --filter @er-diagram/storage-sqlite test test/storage-sqlite.test.ts`
- [x] `M1-005` project/revision use cases와 transaction/retention
  - 검증: `pnpm --filter @er-diagram/core test test/application/project.test.ts`
- [x] `M1-006` project/draft/revision/restore Fastify API와 correlation ID
  - 검증: `pnpm --filter @er-diagram/server test:integration projects`
- [x] `M1-007` accessible Web shell과 Project Home
  - 검증: `pnpm --filter @er-diagram/web test test/project-home.test.tsx`
- [x] `M1-008` Monaco DBML editor, parser worker, 750 ms autosave와 stale-response guard
  - 검증: `pnpm --filter @er-diagram/web test test/source-editor.test.tsx`
- [x] `M1-009` table/column/PK/FK/ref base diagram과 source navigation
  - 검증: `pnpm --filter @er-diagram/web test test/diagram-base.test.tsx`
- [x] `M1-010` `TableGroup` compound node와 collapse edge aggregation
  - 검증: `pnpm --filter @er-diagram/web test test/table-groups.test.tsx`
- [x] `M1-011` `DiagramView`, search, `NAME_ONLY|KEYS_ONLY|FULL` LOD
  - 검증: `pnpm --filter @er-diagram/web test test/views-search-lod.test.tsx`
- [x] `M1-012` per-view layout persistence와 auto-layout preview/apply/cancel/reset
  - project-global layout revision, explicit conflict recovery, full current-view reset
  - 검증: `pnpm --filter @er-diagram/web test test/layout-persistence.test.tsx`
- [x] `M1-GATE` fidelity 탐색과 invalid-draft restart recovery 통과
  - 실제 Monaco/parser/ELK browser 탐색과 file-backed SQLite reopen을 분리해 검증한다.
  - 검증: `pnpm test:m1-gate`

### Milestone 2 — PostgreSQL·MySQL SQL Interchange

- [x] `M2-001` versioned PostgreSQL/MySQL DDL capability matrix
  - target/observed status, parser provenance와 atomic golden fixture를 공개 계약으로 유지한다.
  - 검증: `pnpm --filter @er-diagram/core test test/sql-capabilities.test.ts`
- [x] `M2-002` SQL import와 clause별 `ConversionReport`, graph A→DBML→graph B 비교
  - 검증: `pnpm --filter @er-diagram/core test test/sql-import.test.ts`
- [x] `M2-003` DML/민감 data exclusion과 opt-in original SQL retention
  - conversion report와 사용자 DDL-only 승인 상태를 분리하고 original SQL은 opt-in일 때만 보존한다.
  - 검증: `pnpm --filter @er-diagram/core test test/data-exclusion.test.ts`
- [x] `M2-004` import preview/apply API, hash 재검증, checkpoint/rollback
  - 성공·실패 preview artifact, versioned evidence hash와 authoritative Apply reparse를 구현한다.
  - Apply는 `SQL_IMPORT` checkpoint, project pointer와 artifact status를 원자적으로 저장한다.
  - 검증: `pnpm --filter @er-diagram/server test:integration sql-import`
- [x] `M2-005` new-project/replace-only import preview UI
  - stateless preview와 atomic new-project import, saved-workspace replace 진입과 독립 loss/data 확인을 제공한다.
  - 검증: `pnpm --filter @er-diagram/web test test/sql-import.test.tsx`
- [x] `M2-006` same-dialect export, reparse와 semantic equality
  - record/inactive-free export clone, versioned loss report와 exportable graph B→C 검증을 적용한다.
  - 검증: `pnpm --filter @er-diagram/core test test/sql-export.test.ts`
- [x] `M2-007` invalid/last-valid export UX와 report download
  - read-only project export API, explicit last-valid selection과 SQL/report 별도 download를 제공한다.
  - 검증: `pnpm test:e2e sql-export`
- [x] `M2-GATE` PostgreSQL/MySQL same-dialect semantic round-trip, silent loss 0
  - known `PARTIAL|UNSUPPORTED`는 source-ranged evidence가 있을 때만 허용하고 설명되지 않은 semantic diff는 차단한다.
  - 실제 Core conversion browser flow와 file-backed SQLite reopen acceptance를 분리해 검증한다.
  - 검증: `pnpm test:m2-gate`

### Milestone 3 — Visual Schema Editing

- [x] `M3-001` expected revision을 포함한 `VisualCommand` Zod union
  - 20개 command와 strict payload, typed default, stable-key kind, non-empty patch를 검증한다.
  - pinned DBML v2의 empty-table 제약에 맞춰 `CREATE_TABLE`은 unique한 초기 column을 한 개 이상 요구한다.
  - 검증: `pnpm --filter @er-diagram/contracts test test/visual-command.test.ts`
- [x] `M3-002` table/column create/update/rename/reorder/delete minimal patch
  - token-aware fragment patch, official table rename, structural column rename, dependency·partial 보호와 full reparse·semantic diff rollback을 적용한다.
  - 검증: `pnpm --filter @er-diagram/source-transform test test/table-column.test.ts`
- [x] `M3-003` reference/index/constraint patch와 DBML capability guard
  - standalone·inline Ref, ordered composite endpoint와 16가지 multiplicity를 source-preserving edit로 처리한다.
  - index/check의 owner·PK·partial·anonymous identity와 pinned grammar capability를 fail-closed 검증한다.
  - 검증: `pnpm --filter @er-diagram/source-transform test test/relationships-indexes.test.ts`
- [x] `M3-004` group/view patch와 `TablePartial` provenance protection
  - strict membership delta, source-preserving view filter와 partial definition/affected-table impact를 구현한다.
  - 검증: `pnpm --filter @er-diagram/source-transform test test/groups-views-partials.test.ts`
- [x] `M3-005` idempotent command application transaction과 layout rename migration
  - project-scoped receipt는 동일 command replay를 stale 검사보다 먼저 처리하고 payload mismatch를 차단한다.
  - semantic no-op은 receipt만 저장하며 explicit table/column rename은 모든 view layout key를 같은 transaction에서 migration한다.
  - 검증: `pnpm --filter @er-diagram/core test test/application/visual-command.test.ts`
- [x] `M3-006` thin Fastify visual-command API, 409/422, source redaction
  - strict command/path validation, durable replay response, partial impact transport와 redacted error mapping을 제공한다.
  - 검증: `pnpm --filter @er-diagram/server test:integration visual-commands`
- [x] `M3-007` accessible visual inspector/form과 source fallback
  - selection-driven inspector에서 20종 command를 제공하고 source/layout flush, authoritative state adoption, safe replay와 partial source fallback을 적용한다.
  - 검증: `pnpm --filter @er-diagram/web test test/visual-editor.test.tsx`
- [x] `M3-008` source/visual session undo-redo와 durable restore
  - project별 100단계 revision snapshot stack에서 source autosave와 visual command를 통합하고 reload·외부 conflict에서는 초기화한다.
  - undo/redo는 pruning 대상 `SOURCE_EDIT`, 명시적 revision restore는 `RESTORE` checkpoint로 저장한다. Source-changing restore만 undo step이며 layout은 복구하지 않는다.
  - source-free History, invalid revision restore와 accessible button·shortcut·상태를 제공한다.
  - 검증: `pnpm --filter @er-diagram/web test test/history-session.test.ts test/history-ui.test.tsx && pnpm test:e2e undo-redo`
- [x] `M3-GATE` unrelated source preservation, reparse, semantic diff, rollback 통과
  - versioned corpus의 20종 command를 모두 실행하고 target 밖 source byte, full reparse와 semantic closure를 검증한다.
  - 실제 Fastify·file-backed SQLite restart와 Monaco/parser/React Flow/ELK browser acceptance를 분리해 검증한다.
  - 검증: `pnpm test:m3-gate`

### Milestone 4 — Security, Recovery, Open-source Release

- [x] `M4-001` source/bundle/worker size와 timeout limit
  - 검증: `pnpm test:security limits-timeouts`
- [x] `M4-002` CSP, text escaping, archive traversal/bomb/symlink 방어, redacted logging
  - enforced CSP와 Zod jitless contract, bounded ZIP central-directory/stream 검증, allowlist JSONL logging을 적용한다.
  - 검증: `pnpm test:security && pnpm test:e2e:security`
- [ ] `M4-003` portable bundle v1과 hash/version/traversal validation
  - 검증: `pnpm test:integration bundles`
- [ ] `M4-004` backup, restore dry-run/apply와 pre-migration checksum
  - 검증: `pnpm --filter @er-diagram/server test:integration backup-restore`
- [ ] `M4-005` Node 24 non-root multi-stage image와 localhost compose
  - 검증: `docker compose config && docker compose up --build -d`
- [ ] `M4-006` live/ready, graceful shutdown, outbound-disabled runtime
  - 검증: health curl, offline E2E, SIGTERM autosave
- [ ] `M4-007` core-flow accessibility와 keyboard navigation
  - 검증: Playwright axe + manual keyboard checklist
- [ ] `M4-008` parse/interactive/view switch/FPS performance acceptance
  - 검증: `pnpm test:perf`
- [ ] `M4-009` tag-triggered amd64/arm64 GHCR release와 immutable digest
  - 검증: release dry run과 image inspect
- [ ] `M4-010` CycloneDX/SPDX SBOM, license inventory, EPL source 안내
  - 검증: `pnpm licenses:check && pnpm sbom:check`
- [ ] `M4-011` complete P0 end-to-end acceptance suite
  - 검증: `pnpm test:e2e`
- [ ] `P0-RELEASE` `pnpm ci:verify`, Release Gate A~F, OrbStack restore drill,
      source/image mapping 통과 후에만 P0 tag 생성

### Milestone 5 — P1 Static SELECT Lineage

- [ ] `M5-001` `node-sql-parser@5.4.0` P1 adapter와 neutral AST
  - 검증: `pnpm --filter @er-diagram/core test query-parser`
- [ ] `M5-002` alias/CTE/schema qualification table-level lineage resolver
  - 검증: `pnpm --filter @er-diagram/core test table-lineage`
- [ ] `M5-003` ambiguity/unsupported/confidence diagnostics와 capability report
  - 검증: `pnpm --filter @er-diagram/core test lineage-diagnostics`
- [ ] `M5-004` non-executing query editor와 lineage overlay
  - 검증: `pnpm test:e2e lineage`
- [ ] `M5-005` 1 MiB, 2초 timeout, crash isolation, literal-redacted logging
  - 검증: `pnpm test:security lineage && pnpm test:perf lineage`

## 5. 공통 검증 명령

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm architecture:check
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test:security
pnpm test:perf
pnpm build
pnpm licenses:check
pnpm sbom:check
pnpm ci:verify
docker compose config
```

`pnpm ci:verify`는 format check, lint, typecheck, architecture, unit, integration, build,
license 검사를 모두 실행한다. Playwright와 Docker acceptance는 CI의 별도 job에서 실행하되
P0 release 전에는 모두 필수로 통과해야 한다.

## 6. 확정 가정

- 공개 repository에는 Digreed의 실제 `ERD.dbml`을 복사하지 않고 deterministic synthetic
  fixture를 사용한다.
- P0는 single-user이며 제품 내 인증을 구현하지 않는다.
- remote access는 reverse proxy 인증을 운영자 책임으로 둔다.
- PostgreSQL↔MySQL cross-dialect export는 P0에서 차단한다.
- source edit는 750ms debounce 후 revision을 생성하며 최근 100개 non-checkpoint revision을
  보존한다.
- SQLite는 단일 server process만 write하며 multi-process horizontal scaling은 범위 밖이다.
- Fastify는 HTTP/CLI adapter 역할만 하며 framework-independent package에 business logic을 둔다.
- NestJS 전환은 실제 auth, multi-user, queue, WebSocket 또는 복잡한 integration 요구가 확정될
  때 별도 ADR로 수행한다.
- Spring Boot 전환은 JVM 조직 표준이나 enterprise integration이 제품 핵심이 되는 경우에만
  재검토한다.
