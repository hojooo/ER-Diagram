# ER-Diagram Repository Instructions

## Project Context

- Product: DBML·SQL ERD Studio, an Apache-2.0 self-hosted schema workspace.
- Runtime: Node.js 24 LTS with pnpm 10. Use ESM and strict TypeScript.
- Product requirements are canonical in `docs/product/PRD.md`; implementation progress is tracked in `TASKLIST.md`.

## Repository Structure

- `apps/web`: React SPA, Monaco, React Flow, and browser workers.
- `apps/server`: Fastify HTTP/CLI adapter and static web serving.
- `packages/core`: framework-free parser-neutral graph, semantic logic, use cases, and ports.
- `packages/contracts`: Zod contracts shared across trust boundaries.
- `packages/source-transform`: minimal source edits and reparse verification.
- `packages/storage-sqlite`: Drizzle schema, migrations, and repository adapters.
- `packages/test-fixtures`: deterministic public synthetic fixtures only.
- `docs/adr`: accepted architecture decisions; `docs/operations`: operator guidance.

## Architecture Rules

- Fastify imports are allowed only in `apps/server`.
- `packages/core` and `packages/source-transform` must not import DOM, React, Fastify, or SQLite APIs.
- `apps/web` must not import `packages/storage-sqlite`.
- Parser-library objects are adapter internals and must not cross public contracts.
- Canonical DBML source is never replaced by exporting the whole normalized graph. Visual edits must be minimal `TextEdit[]`, applied in reverse-offset order, then fully reparsed and semantically verified.
- Layout and viewport data are sidecars; they never own schema semantics.
- P0 must not connect to or execute against a user database. Do not import `@dbml/connector` in runtime code.

## Coding Conventions

- Keep direct dependencies exact-pinned and commit `pnpm-lock.yaml`.
- Public source offsets are UTF-16 half-open offsets; line and column values are one-based.
- Stable schema element keys use a canonical qualified-name representation rather than parser object identity.
- Prefer explicit result objects with diagnostics at parser and transformation boundaries.
- Keep web/server adapters thin; durable business rules belong in framework-free packages.

## Testing And Verification

- Run focused tests with `pnpm --filter <workspace> test <pattern>`.
- Run architecture rules with `pnpm architecture:check`.
- Run the Milestone 0 gate with `pnpm ci:verify` and `pnpm test:perf --scenario layout-spike`.
- Run `pnpm licenses:check` whenever dependencies or notices change.
- Synthetic fixtures must be byte-identical for the same seed and must never contain private Digreed schema data.

## Documentation And Source Of Truth

- If `TASKLIST.md` and `docs/product/PRD.md` disagree on product behavior, stop and resolve the PRD first.
- Add accepted cross-cutting architecture decisions to `docs/adr`; keep exploratory alternatives in `docs/idea`.
- Mark a task complete only after its implementation, stated verification, and diff review pass.

## Ask The Developer

- Ask before changing a fixed P0 scope, public contract, source-of-truth policy, database execution boundary, license, or release destination.
- Ask before adding a framework dependency to `packages/core` or `packages/source-transform`.

## Known Traps

- The legacy DBML parser mode is not accepted; use the DBML v2 path and prove source-hash fidelity.
- `@dbml/connector` exposes live database schema-fetch APIs and is excluded from P0 runtime dependencies.
- Unsupported SQL must be reported, not hidden in canonical DBML metadata.
- Never commit a real customer or Digreed ERD; use `packages/test-fixtures` generators.
