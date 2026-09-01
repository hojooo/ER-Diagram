# DBML·SQL ERD Studio

DBML·SQL ERD Studio는 큰 DBML schema를 탐색하고 편집하며 PostgreSQL·MySQL DDL을 실행 없이 가져오고 내보내는 Apache-2.0 self-hosted ERD workspace다.

Milestone 3 visual editing integrity gate를 완료하고 Milestone 4 security·recovery·release를 구현하는 단계다. 제품 범위와 구현 순서는 각각 [PRD](docs/product/PRD.md)와 [TASKLIST](TASKLIST.md)를 기준으로 한다. 현재 PostgreSQL·MySQL 보장 수준은 목표와 pinned parser fixture의 관찰 결과를 분리한 [SQL capability matrix ADR](docs/adr/0005-sql-capability-matrix.md)을 따른다.

## P0 범위

- 표준 DBML source를 schema semantics의 유일한 정본으로 사용
- `TablePartial`, `TableGroup`, `DiagramView`를 포함한 DBML v2 parsing과 탐색
- PostgreSQL 14+·MySQL 8.0+ same-dialect DDL import/export
- source, diagram layout, visual schema 편집
- invalid draft·history·layout을 함께 옮기는 versioned portable project bundle
- verified online snapshot과 plan-hash Apply를 사용하는 SQLite whole-volume recovery
- single-user self-host와 SQLite mounted-volume persistence
- 변환 손실·미지원 SQL을 숨기지 않는 진단과 report

P0는 database 연결, SQL 실행, cross-dialect export, 인증, 실시간 공동 편집을 제공하지 않는다.

## 요구 환경

- Node.js 24 LTS
- pnpm 10
- Docker 또는 OrbStack은 container 검증 시 선택 사용

## Container quickstart

```sh
docker compose up --build -d
```

Browser에서 `http://127.0.0.1:8080`을 연다. 기본 구성은 Web과 API를 같은 Fastify process에서 제공하고 SQLite를
named volume에 저장하며 host에는 loopback으로만 공개한다. 운영·backup·optional bind mount 절차는
[Container runbook](docs/operations/container.md)을 따른다.

Production runtime은 strict `ER_DIAGRAM_*` allowlist, `/health/ready`, single-volume lease와 graceful
`SIGTERM` drain을 사용한다. Lifecycle과 offline acceptance는 다음 명령으로 재검증한다.

```sh
pnpm test:runtime-lifecycle
```

Core flow의 WCAG A/AA 자동 검사와 keyboard regression은 다음 명령으로 재검증한다. Axe 자동 검사는 전체
접근성 인증을 대신하지 않으며, release 전에는 [접근성 keyboard checklist](docs/operations/accessibility-checklist.md)를
current stable Chromium에서 함께 수행한다.

```sh
pnpm test:accessibility
```

Versioned large-ERD profile의 parse, cold interactive, first-uncached view switch, drag·pan·zoom과 source-input
latency는 production Chrome에서 다음 명령으로 재검증한다.

```sh
pnpm test:perf
```

`linux/amd64`, `linux/arm64` release image의 OCI metadata, non-root runtime, native SQLite와 resource worker는
publish 없이 다음 명령으로 재검증한다.

```sh
pnpm test:release
```

Stable release image는 `ghcr.io/hojooo/er-diagram:<version>`으로 게시한다. 운영 배포는 GitHub Release가 기록한
immutable digest를 우선한다.

```sh
docker pull ghcr.io/hojooo/er-diagram:1.0.0
docker pull ghcr.io/hojooo/er-diagram@sha256:<release-digest>
```

Tag publish, 최초 GHCR Public 전환과 replay 절차는 [GHCR release runbook](docs/operations/release.md)을 따른다.
실제 P0 tag는 M4-010·M4-011과 `P0-RELEASE` gate 전에는 생성하지 않는다.

## 개발과 검증

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm architecture:check
pnpm test:unit
pnpm build
```

완료된 Milestone 1~3 acceptance gate는 다음 명령으로 재검증한다.

```sh
pnpm test:m1-gate
pnpm test:m2-gate
pnpm test:m3-gate
```

Milestone 0 전체 gate는 다음 명령으로 확인한다.

```sh
pnpm ci:verify
pnpm test:perf --scenario layout-spike
```

## Repository 구조

```text
apps/
  web/                 React SPA, Monaco, React Flow, browser workers
  server/              Fastify HTTP/CLI adapter, static web serving
packages/
  core/                parser-neutral graph, semantic logic, use cases, ports
  contracts/           Zod HTTP, worker, bundle contracts
  source-transform/    minimal TextEdit and reparse verification
  storage-sqlite/      Drizzle migrations and repository adapters
  test-fixtures/       deterministic public synthetic fixtures
docs/
  product/PRD.md       canonical product requirements
  adr/                 accepted architecture decisions
  operations/          operator guidance
```

핵심 package는 framework-free로 유지한다. Fastify는 `apps/server`에서만 사용하며, visual schema 변경은 canonical DBML 전체를 재생성하지 않고 최소 `TextEdit[]`를 적용한 뒤 전체 reparse와 semantic diff를 통과해야 한다. 실제 고객 또는 Digreed schema는 저장소에 포함하지 않는다.

## Architecture decisions

- [ADR 0001: Vite + Fastify monorepo](docs/adr/0001-vite-fastify-monorepo.md)
- [ADR 0002: DBML canonical source와 source fidelity](docs/adr/0002-dbml-canonical-source-fidelity.md)
- [ADR 0003: SQLite persistence](docs/adr/0003-sqlite-persistence.md)
- [ADR 0004: Fastify adapter 교체 경계](docs/adr/0004-fastify-adapter-boundary.md)
- [ADR 0005: SQL capability target과 observed evidence](docs/adr/0005-sql-capability-matrix.md)
- [ADR 0006: Revision 단위 session history와 durable restore](docs/adr/0006-session-history-and-durable-restore.md)
- [ADR 0007: Runtime resource budget과 worker isolation](docs/adr/0007-runtime-resource-budgets-and-worker-isolation.md)
- [ADR 0008: Web CSP, bounded ZIP과 redacted logging](docs/adr/0008-web-and-archive-security-boundaries.md)
- [ADR 0009: Portable project bundle v1과 atomic re-key import](docs/adr/0009-portable-project-bundle.md)
- [ADR 0010: SQLite whole-volume snapshot과 plan-hash recovery](docs/adr/0010-sqlite-volume-recovery.md)
- [ADR 0011: Node 24 non-root container와 same-origin Web packaging](docs/adr/0011-container-packaging.md)
- [ADR 0012: Production lifecycle, SQLite volume ownership와 offline runtime](docs/adr/0012-production-lifecycle-and-offline-runtime.md)
- [ADR 0013: Core-flow accessibility와 keyboard navigation](docs/adr/0013-core-flow-accessibility.md)
- [ADR 0014: Large ERD performance acceptance](docs/adr/0014-large-erd-performance-acceptance.md)
- [ADR 0015: Immutable multi-architecture GHCR release](docs/adr/0015-multi-architecture-ghcr-release.md)

운영 backup, restore dry-run/apply와 pre-migration 절차는
[SQLite volume backup·restore runbook](docs/operations/backup-restore.md)을 따른다.
Container build, localhost Compose와 named-volume 운영은
[Container runbook](docs/operations/container.md)을 따른다.
Core flow의 manual keyboard evidence는
[Accessibility checklist](docs/operations/accessibility-checklist.md)를 따른다.
GHCR dry run, tag publish와 digest deployment는
[GHCR release runbook](docs/operations/release.md)을 따른다.

## License

이 프로젝트는 [Apache License 2.0](LICENSE)으로 배포한다. Third-party license와 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 따른다.
