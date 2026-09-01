# ADR 0015: Immutable multi-architecture GHCR release

- 상태: `ACCEPTED`
- 결정일: 2026-09-01
- 적용 범위: P0

## Context

Container image가 동작하더라도 release tag, source commit과 실제 배포 digest가 연결되지 않으면 같은 version 이름이
다른 byte를 가리키거나 운영자가 어떤 source를 실행 중인지 확인하기 어렵다. `linux/amd64`만 검증한 image는
Apple Silicon과 ARM server에서 native SQLite module이나 worker가 실패할 수 있다. 반대로 모든 branch build에
registry write 권한을 주면 PR이나 수동 dry run이 공개 artifact를 변경할 수 있다.

OCI image digest는 image index byte에서 계산되므로 image 자신 안에 최종 digest를 넣는 것은 self-reference가 된다.
Runtime은 version과 source revision을 보존하고 최종 digest 연결은 registry와 GitHub Release evidence가 소유해야 한다.

## Decision

### Runtime release identity

`RuntimeConfigResponse` version 2는 resource limit과 함께 `RuntimeReleaseIdentity`를 제공한다.

- Development build는 version `development`, source revision과 image reference `null`을 사용한다.
- Release build는 prerelease와 build metadata가 없는 stable SemVer, lowercase full commit SHA와
  `ghcr.io/hojooo/er-diagram:<version>`을 함께 요구한다.
- Parser version `9.1.1`과 portable bundle schema version `1`을 동일 identity에 포함한다.
- Production startup은 `/app/release.json`을 strict contract로 검증한 뒤에만 SQLite를 연다.
- Project Home과 단일 allowlist operational event가 같은 identity를 표시한다. Image digest는 포함하지 않는다.

Docker build args가 `/app/release.json`과 OCI config label을 함께 만든다. Source repository, revision, version,
`Apache-2.0`, title과 description은 image config label 및 multi-platform index·manifest annotation에서 독립 검증한다.
Packaged Web, non-root user, native SQLite와 resource worker는 `linux/amd64`, `linux/arm64`에서 각각 실행한다.

### Publish boundary

`.github/workflows/release.yml`은 두 경계를 분리한다.

- `workflow_dispatch`는 임의 ref에서 전체 release gate와 multi-architecture OCI dry run만 실행한다. GHCR login,
  push와 GitHub Release 생성을 하지 않는다.
- `vMAJOR.MINOR.PATCH` tag push만 `GITHUB_TOKEN`의 `packages: write`, `contents: write`를 사용한다. Tag commit이
  `main` ancestry가 아니면 차단한다.

Action은 immutable commit SHA로 고정한다. Release image는 exact version tag와 현재 repository에서 가장 높은 stable
version일 때만 `latest`를 게시한다. Major/minor floating tag와 prerelease는 만들지 않는다. Build record artifact,
provenance artifact upload는 비활성화한다. M4-010은 immutable scanner의 platform SPDX attestation을 추가하되
SLSA provenance는 계속 생성하지 않는다.

### Immutability와 replay

Version tag가 이미 존재하면 index annotation의 version·source revision, exact platform set과 runtime evidence를
검사한다. 동일하면 exact image를 다시 push하지 않고 replay하며, 다르면 `RELEASE_IMAGE_TAG_CONFLICT`로 실패한다.
`latest`가 필요한 replay에서는 같은 immutable digest를 가리켜야 한다. Existing GitHub Release도 source commit,
image tag와 digest evidence가 같을 때만 replay한다.

Publish 뒤 authentication을 제거하고 digest pull이 성공해야 GitHub Release를 만든다. GHCR의 첫 package는 private일
수 있으므로 운영자가 Package settings에서 한 번 Public으로 전환한 뒤 같은 workflow run을 재실행한다. Public 전환은
되돌릴 수 없는 운영 결정으로 취급한다. Exact image는 이미 검증됐으므로 재실행에서 push하지 않는다.

GitHub Release의 한글 evidence가 source commit, exact tag와 immutable digest pull 명령을 연결한다. 배포와 rollback은
floating tag보다 digest를 우선한다.

## Alternatives considered

### `latest`만 게시

간단하지만 source tag와 immutable runtime을 연결하지 못하고 rollback 대상이 계속 바뀐다. Exact stable version을
정본으로 두고 `latest`는 가장 높은 stable version의 편의 alias로만 유지한다.

### Image 내부에 digest 기록

Digest를 넣으면 image content가 바뀌어 다시 digest가 달라지는 순환이 생긴다. Runtime에는 version과 source revision을
넣고 digest는 registry index와 GitHub Release에서 연결한다.

### Manual workflow에서도 registry push 허용

Dry run이 public state를 바꾸고 arbitrary ref publication 위험을 만든다. Publish 권한은 main ancestry의 exact stable tag
event에만 부여한다.

## Consequences

- 동일 version은 다른 source나 image로 덮어쓸 수 없다. 수정 release는 새 SemVer가 필요하다.
- 첫 GHCR publish는 Public visibility 전환 때문에 한 번 실패하고 안전하게 replay할 수 있다.
- Multi-architecture build와 두 platform runtime smoke로 release gate 시간이 늘어난다.
- Dependency SBOM·EPL source evidence는 ADR 0016을 따르며 전체 P0 acceptance와 실제 P0 tag는
  M4-011·`P0-RELEASE`에 남는다.

## Verification

- `pnpm --filter @er-diagram/contracts test test/runtime-release-contract.test.ts`
- `pnpm --filter @er-diagram/server test runtime-release`
- `pnpm --filter @er-diagram/web test test/runtime-release.test.tsx`
- `pnpm test:release`
- `pnpm test:container`
