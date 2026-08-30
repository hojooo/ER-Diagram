# DBML·SQL ERD Studio

DBML·SQL ERD Studio는 큰 DBML schema를 탐색하고 편집하며 PostgreSQL·MySQL DDL을 실행 없이 가져오고 내보내는 Apache-2.0 self-hosted ERD workspace다.

Milestone 2 SQL interchange gate를 완료하고 Milestone 3 visual schema editing을 구현하는 단계다. 제품 범위와 구현 순서는 각각 [PRD](docs/product/PRD.md)와 [TASKLIST](TASKLIST.md)를 기준으로 한다. 현재 PostgreSQL·MySQL 보장 수준은 목표와 pinned parser fixture의 관찰 결과를 분리한 [SQL capability matrix ADR](docs/adr/0005-sql-capability-matrix.md)을 따른다.

## P0 범위

- 표준 DBML source를 schema semantics의 유일한 정본으로 사용
- `TablePartial`, `TableGroup`, `DiagramView`를 포함한 DBML v2 parsing과 탐색
- PostgreSQL 14+·MySQL 8.0+ same-dialect DDL import/export
- source, diagram layout, visual schema 편집
- single-user self-host와 SQLite mounted-volume persistence
- 변환 손실·미지원 SQL을 숨기지 않는 진단과 report

P0는 database 연결, SQL 실행, cross-dialect export, 인증, 실시간 공동 편집을 제공하지 않는다.

## 요구 환경

- Node.js 24 LTS
- pnpm 10
- Docker 또는 OrbStack은 container 검증 시 선택 사용

## 개발과 검증

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm architecture:check
pnpm test:unit
pnpm build
```

완료된 read-only workspace와 same-dialect SQL interchange gate는 다음 명령으로 재검증한다.

```sh
pnpm test:m1-gate
pnpm test:m2-gate
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

## License

이 프로젝트는 [Apache License 2.0](LICENSE)으로 배포한다. Third-party license와 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 따른다.
