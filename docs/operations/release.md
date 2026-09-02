# GHCR release 운영 절차

이 runbook은 source tag, multi-architecture GHCR image와 GitHub Release evidence를 연결하는 절차다. 실제 P0 tag는
M4-010, M4-011과 `P0-RELEASE` gate가 끝나기 전에 만들지 않는다.

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

GitHub Actions의 `Release` workflow에서 `Run workflow`를 선택하고 검증할 ref를 입력한다. CLI에서는 다음처럼 실행한다.

```sh
gh workflow run release.yml -f ref=main
gh run watch
```

Dry run은 repository gate, production E2E·performance와 `linux/amd64`, `linux/arm64` OCI build·runtime smoke를 실행한다.
GHCR login, push와 GitHub Release 생성은 하지 않는다. Local Docker/QEMU 환경에서는 같은 image evidence를 다음으로
검증할 수 있다.

```sh
pnpm test:release
```

## Stable release 게시

M4-010, M4-011과 `P0-RELEASE`가 모두 완료된 뒤 clean 최신 `main`에서만 tag를 만든다.

```sh
git switch main
git pull --ff-only origin main
git tag v1.0.0
git push origin v1.0.0
```

Workflow는 tag 형식과 `main` ancestry를 확인하고 full gate를 다시 실행한다. Exact version tag가 없을 때만 image를
push한다. 가장 높은 stable version이면 같은 digest에 `latest`도 붙인다. Publish 뒤에는 다음을 검사한다.

- Index platform이 정확히 `linux/amd64`, `linux/arm64`
- Index·manifest annotation과 image config label의 source, revision, version, license, title, description
- 양 platform의 non-root user, packaged Web, native SQLite와 resource worker
- 인증을 제거한 anonymous digest pull
- GitHub Release 본문의 source commit, image tag와 immutable digest

## 첫 GHCR package 공개

GHCR의 첫 package publish는 private visibility로 생성될 수 있다. 이 경우 exact image push와 authenticated 검증 뒤
anonymous digest pull에서 `RELEASE_IMAGE_NOT_PUBLIC`으로 멈추며 GitHub Release는 아직 만들지 않는다.

1. GitHub organization 또는 account의 Packages에서 `er-diagram` package settings를 연다.
2. Source repository가 `hojooo/ER-Diagram`인지 확인한다.
3. Visibility를 Public으로 변경한다. Public 전환은 되돌릴 수 없다는 GitHub 경고를 다시 확인한다.
4. 실패한 동일 workflow를 재실행한다.

재실행은 existing exact version의 source revision·platform·OCI evidence를 검증하고 image를 다시 push하지 않는다.
Anonymous digest pull이 성공한 뒤에만 GitHub Release를 생성한다.

## 배포와 확인

사람이 읽는 exact version은 다음처럼 받을 수 있다.

```sh
docker pull ghcr.io/hojooo/er-diagram:1.0.0
```

운영 배포와 rollback은 GitHub Release에 기록된 immutable digest를 사용한다.

```sh
docker pull ghcr.io/hojooo/er-diagram@sha256:<release-digest>
docker image inspect ghcr.io/hojooo/er-diagram@sha256:<release-digest>
```

Project Home의 `Runtime release`에서 image version, full source revision, parser와 bundle schema version을 확인한다.
Operational log의 `SERVER_RELEASE_IDENTITY`도 같은 source-free evidence를 한 번 기록한다. Digest는 self-reference를
피하기 위해 container 내부에 넣지 않으며 GitHub Release가 tag·commit과 연결한다.

## Conflict와 복구

- `RELEASE_IMAGE_TAG_CONFLICT`: 기존 exact tag가 다른 source/evidence를 가리킨다. Tag나 image를 강제로 덮어쓰지
  말고 원인을 조사한 뒤 수정본은 새 SemVer로 게시한다.
- `RELEASE_LATEST_TAG_CONFLICT`: `latest`가 expected exact digest와 다르다. Registry state와 stable tag 순서를
  확인하고 자동으로 이동시키지 않는다.
- `RELEASE_GITHUB_RELEASE_CONFLICT`: 기존 Release body가 source/tag/digest evidence와 다르다. 기존 evidence를
  보존하고 별도 incident로 조사한다.
- `RELEASE_IMAGE_NOT_PUBLIC`: 최초 visibility 절차를 완료한 뒤 동일 run을 재실행한다.

Release tag나 GitHub Release를 삭제해 같은 version을 다시 사용하는 것을 복구 수단으로 삼지 않는다.
