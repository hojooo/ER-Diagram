# GHCR release 운영 절차

이 runbook은 source tag, multi-architecture GHCR image, SBOM과 GitHub Release evidence를 연결하는 절차다. 최초
public candidate는 `v0.1.0`이다. Preparation PR merge, final `main` gate, OrbStack restore drill과 publish 없는 dispatch가
끝나기 전에는 tag를 만들지 않는다. `P0-RELEASE` task는 실제 원격 publication·검증 뒤 별도 evidence PR에서 완료한다.

## 고정 경계

- Registry: `ghcr.io/hojooo/er-diagram`
- Platform: `linux/amd64`, `linux/arm64`
- Version tag: prerelease가 없는 `vMAJOR.MINOR.PATCH`
- Image tag: 앞의 `v`를 제거한 exact SemVer
- `latest`: repository의 가장 높은 stable version에만 사용
- Publish credential: repository-scoped `GITHUB_TOKEN`

Major/minor floating tag와 prerelease image는 게시하지 않는다. 동일 exact image tag는 source revision과 digest가 같은
replay만 허용하며 덮어쓰지 않는다.

## Publish 없는 dry run

GitHub Actions의 `Release` workflow에서 `Run workflow`를 선택하고 검증할 ref, version과 full expected revision을
입력한다. Checkout 결과가 expected revision과 다르면 image build 전에 실패한다. CLI에서는 다음처럼 실행한다.

```sh
gh workflow run release.yml \
  -f ref=<final-main-SHA> \
  -f version=0.1.0 \
  -f expectedRevision=<final-main-SHA>
gh run watch
```

Dry run은 repository gate, complete P0 production acceptance, production E2E·performance와 `linux/amd64`,
`linux/arm64` OCI build·runtime smoke를 실행한다.
Application CycloneDX, platform SPDX attestation, ELK source archive와 license asset도 staging하고 검증하지만 GHCR login,
push와 GitHub Release 생성은 하지 않는다. Local Docker/QEMU 환경에서는 같은 evidence를 다음으로 검증할 수 있다.

```sh
pnpm test:release --version 0.1.0 --revision <final-main-SHA>
```

Tag 전에는 production image의 Browser→Fastify→SQLite 전체 흐름, portable bundle의 별도-volume 복구와 실제
whole-volume 복구를 직접 재검증한다.

```sh
pnpm test:p0-gate
docker context show
pnpm test:p0-release
```

`test:p0-release`는 context가 정확히 `orbstack`이고 tracked working tree가 clean일 때만 실행한다. 실행 중 online
backup, source data volume 제거, dry-run plan hash Apply와 restored volume 재기동을 검증한다. 성공 출력의 profile
hash, release version/revision, image config·backup·plan·database hash, source-free inventory와 ordered assertion ID만
PR·release 검토 evidence에 보존한다. 원본 DBML, SQL, path, container·volume 이름이나 native 오류는 복사하지 않는다.

## Candidate 승인

Dispatch와 OrbStack gate가 성공한 exact final `main` commit에만 repository variable을 설정한다.

```sh
gh variable set RELEASE_APPROVED_VERSION --body 0.1.0
gh variable set RELEASE_APPROVED_REVISION --body <final-main-SHA>
gh variable list
```

Tag workflow는 GHCR login과 모든 write 전에 tag version·peeled full commit을 두 variable과 비교한다. Variable이 없거나
하나라도 다르면 `RELEASE_CANDIDATE_NOT_APPROVED`로 실패한다. Version과 commit SHA는 secret이 아니며 credential을
variable에 저장하지 않는다.

## Stable release 게시

Preparation PR을 모두 병합하고 final `main`의 전체 gate, OrbStack drill, dispatch와 candidate approval을 끝낸 뒤에만
unsigned annotated tag를 만든다.

```sh
git switch main
git pull --ff-only origin main
git tag -a v0.1.0 -m "DBML SQL ERD Studio v0.1.0"
git push origin v0.1.0
```

Workflow는 tag 형식과 `main` ancestry를 확인하고 full gate를 다시 실행한다. Exact version tag가 없을 때만 image를
push한다. 가장 높은 stable version이면 같은 digest에 `latest`도 붙인다. Publish 뒤에는 다음을 검사한다.

- Index platform이 정확히 `linux/amd64`, `linux/arm64`
- Index·manifest annotation과 image config label의 source, revision, version, license, title, description
- 각 platform image manifest를 가리키는 OCI-artifact SPDX attestation과 exact platform set
- Image의 `/app/sbom/er-diagram.cdx.json`, `/app/licenses/elkjs-EPL-2.0.txt`
- 양 platform의 non-root user, packaged Web, native SQLite와 resource worker
- 인증을 제거한 anonymous digest pull
- GitHub Release 본문의 source commit, image tag와 immutable digest
- Release CycloneDX·platform SPDX·ELK source/license와 `SHA256SUMS`

## SBOM과 EPL source 확인

Release asset은 다음 이름으로 고정한다.

```text
er-diagram-<version>.cdx.json
er-diagram-<version>-linux-amd64.spdx.json
er-diagram-<version>-linux-arm64.spdx.json
elkjs-0.12.0-source.tgz
elkjs-0.12.0-EPL-2.0.txt
SHA256SUMS
```

Asset을 내려받고 게시된 byte를 먼저 검증한다.

```sh
mkdir er-diagram-release-evidence
gh release download v0.1.0 --dir er-diagram-release-evidence
cd er-diagram-release-evidence
sha256sum --check SHA256SUMS
```

Application CycloneDX는 pnpm production dependency와 workspace edge, 검토된 license 선택을 제공한다. Container
filesystem SPDX는 platform별 OS·native package evidence다. Registry에 연결된 SPDX는 다음처럼 직접 확인한다.

```sh
docker buildx imagetools inspect ghcr.io/hojooo/er-diagram:0.1.0 \
  --format '{{ json (index .SBOM "linux/amd64").SPDX }}'
docker buildx imagetools inspect ghcr.io/hojooo/er-diagram:0.1.0 \
  --format '{{ json (index .SBOM "linux/arm64").SPDX }}'
```

`elkjs-0.12.0-source.tgz`는 npm source archive를 수정 없이 보존한다. Workflow는 이 byte의 SHA-512를 lockfile
integrity와 비교하고 EPL text가 설치 package와 같은지 확인한 뒤에만 Release를 만든다.

## 첫 GHCR package 공개

GHCR의 첫 package publish는 private visibility로 생성될 수 있다. 이 경우 exact image push와 authenticated 검증 뒤
anonymous digest pull에서 `RELEASE_IMAGE_NOT_PUBLIC`으로 멈추며 GitHub Release는 아직 만들지 않는다.

1. GitHub organization 또는 account의 Packages에서 `er-diagram` package settings를 연다.
2. Source repository가 `hojooo/ER-Diagram`인지 확인한다.
3. Visibility를 Public으로 변경한다. Public 전환은 되돌릴 수 없다는 GitHub 경고를 다시 확인한다.
4. 실패한 동일 workflow를 재실행한다.

재실행은 existing exact version의 source revision·platform·OCI evidence를 검증하고 image를 다시 push하지 않는다.
Anonymous digest pull이 성공한 뒤에만 GitHub Release를 생성한다.

Public 전환은 되돌릴 수 없는 운영 단계다. `v0.1.0` publication 뒤 evidence를 수정해야 하면 기존 tag, image와
Release asset을 삭제·덮어쓰기하지 않고 `v0.1.1`을 새로 발행한다.

## 배포와 확인

사람이 읽는 exact version은 다음처럼 받을 수 있다.

```sh
docker pull ghcr.io/hojooo/er-diagram:0.1.0
```

운영 배포와 rollback은 GitHub Release에 기록된 immutable digest를 사용한다.

```sh
docker pull ghcr.io/hojooo/er-diagram@sha256:<release-digest>
docker image inspect ghcr.io/hojooo/er-diagram@sha256:<release-digest>
```

Project Home의 `Runtime release`에서 image version, full source revision, parser와 bundle schema version을 확인한다.
Operational log의 `SERVER_RELEASE_IDENTITY`도 같은 source-free evidence를 한 번 기록한다. Digest는 self-reference를
피하기 위해 container 내부에 넣지 않으며 GitHub Release가 tag·commit과 연결한다.

전체 원격 evidence는 사용자의 Docker 인증을 바꾸지 않는 임시 `DOCKER_CONFIG`로 다시 검증한다.

```sh
pnpm verify:release --version 0.1.0 --revision <final-main-SHA>
```

Exact version과 `latest`가 같은 multi-architecture digest인지, 두 platform identity와 SPDX attestation, CycloneDX·EPL
asset, `SHA256SUMS`, anonymous digest pull과 runtime identity가 모두 일치해야 성공한다. 성공 뒤 작은
`codex/p0-release-evidence` PR에서 released version·commit·immutable digest와 Gate A~F·OrbStack 결과를 기록하고
`P0-RELEASE`를 완료한다.

## Conflict와 복구

- `RELEASE_IMAGE_TAG_CONFLICT`: 기존 exact tag가 다른 source/evidence를 가리킨다. Tag나 image를 강제로 덮어쓰지
  말고 원인을 조사한 뒤 수정본은 새 SemVer로 게시한다.
- `RELEASE_LATEST_TAG_CONFLICT`: `latest`가 expected exact digest와 다르다. Registry state와 stable tag 순서를
  확인하고 자동으로 이동시키지 않는다.
- `RELEASE_GITHUB_RELEASE_CONFLICT`: 기존 Release body가 source/tag/digest evidence와 다르다. 기존 evidence를
  보존하고 별도 incident로 조사한다.
- `RELEASE_SBOM_ASSET_CONFLICT`: 기존 Release asset의 파일 집합 또는 SHA-256이 새 evidence와 다르다. Asset을
  덮어쓰지 말고 새 SemVer 또는 incident 조사를 선택한다.
- `RELEASE_IMAGE_NOT_PUBLIC`: 최초 visibility 절차를 완료한 뒤 동일 run을 재실행한다.
- `RELEASE_CANDIDATE_NOT_APPROVED`: tag version 또는 peeled commit이 repository approval variable과 다르다. Tag를
  이동하지 말고 final candidate와 variable 설정을 다시 검토한다.
- `RELEASE_PUBLISHED_EVIDENCE_INVALID`: exact image, `latest`, Release body, asset 또는 anonymous runtime evidence가
  서로 다르다. 기존 publication을 덮어쓰지 않고 incident로 조사한다.

Release tag나 GitHub Release를 삭제해 같은 version을 다시 사용하는 것을 복구 수단으로 삼지 않는다.
