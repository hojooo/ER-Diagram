# ADR 0018: P0 v0.1.0 release candidate와 OrbStack recovery gate

- 상태: `ACCEPTED`
- 결정일: 2026-09-02
- 적용 범위: P0 release

## Context

M4-011의 complete P0 acceptance는 production Browser, Fastify, resource worker, SQLite와 portable bundle을 하나의
journey로 검증한다. 그러나 최초 public release에는 portable project copy와 다른 운영 경계가 남아 있다. 실행 중인
SQLite 전체 volume을 snapshot하고 원본 application volume을 제거한 뒤 fresh volume에 복구할 수 있어야 하며, 그
복구 결과와 실제 release image의 version·source revision이 같은 candidate를 가리켜야 한다.

Tag push는 GHCR와 GitHub Release를 변경하는 비가역 운영 단계다. Branch gate 성공만으로 임의 tag가 publish되거나,
workflow dispatch가 검토한 commit과 tag commit이 달라지는 것을 허용할 수 없다. 첫 GHCR Public 전환 뒤에는 같은
version을 수정 게시하지 않고 immutable correction version을 사용해야 한다.

## Decision

### 최초 public release identity

최초 release는 `v0.1.0`, image는 `ghcr.io/hojooo/er-diagram:0.1.0`으로 고정한다. Root workspace package version
`0.0.0`은 private monorepo metadata이므로 release version source로 사용하지 않는다. Test-only
`P0_RELEASE_EVIDENCE_VERSION = 1` profile이 version, tag, image reference, product-table inventory, ordered recovery
assertion과 reviewed profile hash를 고정한다.

`pnpm test:release`는 기본적으로 development identity `0.0.0 + current HEAD`를 계속 검증한다. Release candidate는
`--version 0.1.0 --revision <full-HEAD>`를 명시하며, argument revision과 실제 checkout HEAD가 다르면 즉시 실패한다.

### OrbStack whole-volume drill

`pnpm test:p0-release`는 Docker context가 정확히 `orbstack`이고 tracked working tree가 clean일 때만 실행한다.
Host architecture용 release-mode image를 exact version·revision으로 build하고 test-owned container, network와 volume만
사용한다.

1. Production API로 valid→visual edit→invalid current draft, last-valid revision, layout, visual receipt와 retained SQL
   import artifact를 만든다.
2. Server가 실행 중인 상태에서 SQLite online backup을 생성한다.
3. Source application container와 data volume을 제거한다.
4. Fresh volume을 대상으로 restore dry-run을 실행하고, 발급된 exact `planHash`로만 Apply한다.
5. Restored server와 같은 volume의 replacement server에서 project, revision, last-valid pointer, layout, artifact,
   receipt, `app_metadata`와 migration journal을 다시 읽는다.

Gate output은 release identity, native image config hash, backup·plan·database hash, source-free row inventory와 ordered
PASS assertion만 canonical JSON으로 기록한다. DBML, SQL, path, container·volume name과 native 오류는 stdout, stderr와
operational log evidence에 포함하지 않는다. Cleanup은 충분히 긴 unique prefix로 소유권을 확인한 test resource에만
적용한다.

### Exact candidate approval

`workflow_dispatch`는 `ref`, stable `version`, full `expectedRevision`을 받고 checkout HEAD와 exact match를 검증한다.
Registry write 권한이나 repository approval variable은 요구하지 않는다.

Tag event는 publish 또는 GHCR login 전에 다음 repository variable과 peeled tag commit의 exact match를 요구한다.

- `RELEASE_APPROVED_VERSION`
- `RELEASE_APPROVED_REVISION`

누락·불일치는 `RELEASE_CANDIDATE_NOT_APPROVED`로 실패한다. Variables에는 version과 commit SHA만 저장하며 credential은
저장하지 않는다. 실제 tag는 모든 preparation PR이 병합된 final `main`에서 전체 gate와 dispatch dry run을 다시 통과한
뒤 unsigned annotated tag로 만든다.

### Publication과 완료

`P0-RELEASE` task는 preparation PR merge로 완료되지 않는다. Tag workflow, GHCR Public 전환, GitHub Release와
`pnpm verify:release --version 0.1.0 --revision <final-main-SHA>`가 모두 통과한 뒤 별도 evidence PR에서 완료한다.
Verifier는 exact tag와 `latest` digest, 두 platform, OCI identity, SPDX attestation, CycloneDX·EPL assets와 anonymous
digest pull을 검사한다.

`v0.1.0`을 게시한 뒤 수정이 필요하면 tag, image 또는 Release asset을 덮어쓰지 않는다. 기존 evidence를 보존하고
`v0.1.1`을 새로 발행한다.

## Alternatives considered

### Portable bundle import를 whole-volume drill로 간주

Portable bundle은 project ID를 새로 만들고 receipt와 instance metadata를 옮기지 않는다. 운영 volume의 exact recovery를
증명하지 못하므로 별도 gate가 필요하다.

### Tag 생성만으로 승인 의사를 표현

잘못된 local ref나 stale automation도 tag를 만들 수 있다. Reviewed version과 full commit SHA를 repository variable로
한 번 더 고정해 publish 직전의 candidate를 명시한다.

### Root package version을 0.1.0으로 변경

Workspace package metadata와 public image release identity는 역할이 다르다. 불필요한 package graph 변경을 만들지 않고
release manifest와 workflow input을 version source로 사용한다.

## Consequences

- Release candidate 검증에는 OrbStack과 production image build 시간이 필요하다.
- GitHub-hosted runner는 OrbStack gate를 실행하지 않으므로 final operator evidence가 별도로 필요하다.
- 최초 GHCR package의 Public 전환은 되돌릴 수 없는 수동 단계다.
- Preparation branch에서는 실제 tag, GHCR image와 GitHub Release를 만들지 않는다.

## Verification

- `pnpm --filter @er-diagram/test-fixtures test test/p0-release-evidence.test.ts`
- `node --test scripts/test-release-approval.test.mjs`
- `node --test scripts/verify-published-release.test.mjs`
- `pnpm test:release --version 0.1.0 --revision <full-HEAD>`
- `pnpm test:p0-release`
- `pnpm verify:release --version 0.1.0 --revision <final-main-SHA>`
