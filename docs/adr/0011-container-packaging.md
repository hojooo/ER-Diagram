# ADR 0011: Node 24 non-root container와 same-origin Web packaging

## 상태

Accepted

## 맥락

P0 self-host 배포는 별도 Web server나 database service 없이 하나의 image와 mounted SQLite volume으로
실행되어야 한다. 개발용 Vite server와 source tree를 runtime image에 그대로 넣으면 dependency closure와 실제
배포 경계를 검증할 수 없고, root process나 공개 host bind는 local-first 기본값에 맞지 않는다. Monaco, parser
worker, ELK worker가 포함된 production SPA는 Fastify API와 같은 origin에서 CSP를 유지한 채 제공되어야 한다.

`better-sqlite3`는 Node ABI와 image architecture에 맞는 native binary가 필요하다. 현재 arm64 Node 24 slim image에서는
prebuilt artifact 대신 source build가 발생하므로 build stage에는 C++ compiler, `make`, Python이 필요하지만 runtime
stage에는 이 toolchain을 포함할 이유가 없다.

## 결정

### 고정된 build와 runtime closure

Build와 runtime은 모두 exact digest로 고정한 공식
`node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8`
base를 사용한다. Corepack은 repository의 `pnpm@10.32.1`을 활성화하고 frozen lockfile로 전체 workspace와 Web을
build한다. Build stage에만 `g++`, `make`, `python3`을 설치해 architecture별 `better-sqlite3` native module을 만든다.

Runtime stage에는 `pnpm --filter @er-diagram/server deploy --legacy --prod` 결과, compiled Web, SQLite migration,
license와 notice만 복사한다. Workspace package는 `files` allowlist로 `dist`와 storage migration만 배포한다. Source,
test, TypeScript, Vitest, Playwright와 build cache는 runtime closure에 포함하지 않는다.

Application tree는 root-owned이고 `/data`만 built-in `node` UID/GID 1000이 소유한다. 최종 process는 `USER node`로
실행한다. Image는 `/app/web`, `/data/er-diagram.sqlite`, `0.0.0.0:8080`을 packaged 경계로 고정한다.

### Same-origin static Web와 startup fail-closed

Fastify는 `/`와 production asset을 API와 같은 origin에서 제공한다. GET/HEAD HTML navigation만 `index.html`로
fallback하며 `/api`, `/health`, non-GET과 일반 asset miss는 JSON 404 경계를 유지한다. `index.html`과 fallback은
`no-store`, Vite hashed `/assets/*`만 immutable long-term cache를 사용한다. Dotfile, directory listing과 static root
밖 path는 차단하며 ADR 0008의 CSP와 security header를 static, API와 error response에 동일 적용한다. Operational
log에는 raw asset path 대신 `WEB_STATIC` operation만 기록한다.

Entrypoint는 Web root와 `index.html`을 먼저 확인한다. 새 database는 storage schema v3로 초기화하지만 기존 database는
whole-volume validator가 current schema v3와 exact migration history를 확인한 경우에만 연다. Older/future/divergent
database는 기본적으로 자동 migration하지 않고 `SERVER_STORAGE_MIGRATION_REQUIRED`로 종료한다. ADR 0012의 explicit
`APPLY_WITH_BACKUP`만 ADR 0010의 verified plan/apply를 startup에 연결한다. Strict environment, process lock과 signal
lifecycle도 ADR 0012를 따른다.

### Localhost Compose 기본값

기본 Compose는 container listener `0.0.0.0:8080`을 host `127.0.0.1:8080`에만 publish한다. Data는 named volume에
저장하고 memory 2 GiB, PID 128, init process, all-capability drop과 `no-new-privileges`를 적용한다. `container_name`을
고정하지 않아 Compose project별 격리를 유지한다. Host bind mount는 별도 override로만 제공하고 host directory의
UID 1000 소유권과 backup 책임을 operator에게 명시한다.

Portable bundle staging이 임시 filesystem을 사용할 수 있으므로 read-only root와 memory-backed `/tmp`는 강제하지
않는다. Compose는 storage-aware `/health/ready` healthcheck, `SIGTERM`과 application timeout보다 5초 긴 35초 grace를
사용한다. 기본 localhost publish는 유지하고 outbound-disabled 동작은 별도 internal-network acceptance로 검증한다.

## 결과

- Local self-host는 `docker compose up --build -d` 한 명령으로 Web, API와 SQLite를 함께 실행한다.
- Host port는 기본적으로 loopback에만 노출되고 application process는 root 권한을 갖지 않는다.
- Runtime image는 production dependency와 compiled artifact만 포함하며 native SQLite와 Node worker를 실제 image에서
  검증한다.
- Named volume은 container replacement 뒤에도 canonical source와 revision을 유지한다.
- Image startup은 migration을 추측하거나 기존 volume을 자동 변경하지 않는다.
- 동일 volume의 두 production runtime과 offline Apply는 authoritative lifecycle lease로 직렬화된다.

## 검증

- `pnpm --filter @er-diagram/server test static-web`
- `docker compose config --quiet`
- `pnpm test:container`
- `pnpm test:runtime-lifecycle`
