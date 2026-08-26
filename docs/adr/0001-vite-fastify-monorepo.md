# ADR 0001: Vite + Fastify pnpm monorepo

- 상태: `ACCEPTED`
- 결정일: 2026-08-26
- 적용 범위: P0

## Context

제품은 React 기반 source editor와 큰 graph canvas, parser·layout Web Worker, self-hosted HTTP API, 단일 image 배포를 함께 제공해야 한다. 동시에 schema parsing, semantic validation, source transformation 같은 규칙은 UI와 HTTP framework에 종속되지 않아야 한다. 독립 repository로 나누면 shared contract 변경의 원자적 검증과 exact dependency pin 관리가 복잡해진다.

## Decision

Node.js 24 LTS, pnpm 10, ESM, strict TypeScript 기반 monorepo를 사용한다.

- `apps/web`은 React와 Vite로 SPA, Monaco, React Flow, browser worker를 제공한다.
- `apps/server`는 Fastify HTTP/CLI adapter이며 production에서 built SPA를 제공한다.
- `packages/core`는 parser-neutral graph, semantic logic, application use case와 port를 소유한다.
- `packages/contracts`는 HTTP, worker, bundle trust boundary의 Zod contract를 소유한다.
- `packages/source-transform`은 framework-free source patch와 검증을 소유한다.
- `packages/storage-sqlite`는 persistence port의 SQLite adapter를 소유한다.
- `packages/test-fixtures`는 공개 가능한 deterministic fixture만 생성한다.

다음 dependency boundary를 CI에서 검사한다.

- Fastify import는 `apps/server`에서만 허용한다.
- `packages/core`와 `packages/source-transform`은 DOM, React, Fastify, SQLite를 import하지 않는다.
- `apps/web`은 `packages/storage-sqlite`를 import하지 않는다.
- parser-library object는 adapter 내부에 머물고 public contract로 전달되지 않는다.

## Alternatives considered

### 하나의 application package

초기 파일 수는 줄지만 UI, HTTP, persistence, domain dependency가 쉽게 뒤섞이고 NestJS 같은 adapter 교체 비용이 core 변경으로 전파된다.

### Web과 server를 별도 repository로 분리

배포 주기를 독립시킬 수 있지만 P0에서는 shared contract와 fixture를 원자적으로 변경·검증하는 비용이 더 크다.

### SSR 중심 full-stack framework

server-rendered page가 핵심인 제품에는 적합하지만 이 제품은 Monaco, canvas, worker 중심의 authenticated-free SPA다. P0에 SSR 복잡도를 추가할 근거가 없다.

## Consequences

- 하나의 lockfile과 CI에서 web, server, shared package의 호환성을 검증할 수 있다.
- package boundary를 유지하기 위해 type-only import까지 읽는 source dependency graph와
  dependency-cruiser runtime graph를 함께 검사해야 한다.
- production build는 SPA asset과 Fastify server를 한 image에 조립해야 한다.
- 향후 UI 또는 server adapter 교체는 가능하지만 public contract 변경은 별도 versioning과 compatibility 검증을 거친다.

## Verification

- value import, type-only framework import와 package cycle fixture가 architecture check를
  실패시켜야 한다.
- `pnpm architecture:check`, `pnpm check`, `pnpm build`가 통과해야 한다.
