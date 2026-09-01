# ADR 0016: CycloneDX·SPDX SBOM과 EPL source evidence

- 상태: `ACCEPTED`
- 결정일: 2026-09-01
- 적용 범위: P0

## Context

Application package dependency와 container filesystem은 서로 다른 질문에 답한다. pnpm graph만 기록하면 image에
실제로 들어간 OS package와 native binary를 확인할 수 없고, filesystem scan만 제공하면 workspace dependency edge와
dual-license 선택을 잃는다. 또한 `elkjs@0.12.0`을 EPL-2.0으로 배포한다는 고지만으로는 release 시점의 exact source와
license text가 실제 binary evidence에 연결됐음을 보장하지 못한다.

SBOM에 build timestamp, random serial, local path나 username이 들어가면 같은 source에서 byte-identical application
evidence를 만들 수 없다. 반대로 platform scan의 timestamp까지 임의로 제거하면 scanner 원본 evidence를 변조하게 된다.
따라서 application inventory의 결정성과 scanner가 만든 platform evidence의 원본 보존을 분리해야 한다.

## Decision

### Application CycloneDX

`apps/server`, `apps/web`의 pnpm production closure와 그들이 참조하는 internal workspace package를
CycloneDX JSON 1.6으로 기록한다.

- Component identity는 exact package version과 deterministic npm PURL이다.
- Component와 dependency edge는 code-unit 순서로 정렬한다.
- 각 component는 HTTPS source와 검토된 license를 가져야 한다.
- `elkjs@0.12.0`은 `EPL-2.0`, `dompurify@3.4.8`은 `Apache-2.0` 선택을 명시한다.
- Development-only generator, absolute path, username, timestamp와 random serial number는 제외한다.
- `@cyclonedx/cyclonedx-library@10.2.0` normalizer·serializer를 사용하되 생성 도구 자체는 production closure에
  포함하지 않는다.
- Canonical JSON은 단일 trailing LF를 가지며 같은 release identity에서 두 번 생성한 byte가 같아야 한다.

Release image는 `/app/sbom/er-diagram.cdx.json`을 포함한다. GitHub Release의
`er-diagram-<version>.cdx.json`은 같은 byte와 SHA-256이어야 한다.

### Platform SPDX attestation

Container filesystem은 immutable digest로 고정한
`docker/buildkit-syft-scanner`가 platform별 SPDX 2.2 또는 2.3으로 검사한다. Buildx exporter는
`oci-artifact=true`를 사용하며 각 `linux/amd64`, `linux/arm64` image manifest에 다음을 요구한다.

- `unknown/unknown` descriptor가 해당 image manifest digest를 정확히 참조한다.
- Attestation manifest의 OCI subject가 같은 image manifest digest를 가리킨다.
- SPDX predicate layer가 정확히 하나이며 package와 relationship 구조가 유효하다.
- Attestation descriptor를 runnable platform image로 계산하지 않는다.
- SLSA provenance는 별도 결정 전까지 `false`를 유지한다.

Dry run은 OCI layout에서 attestation blob을 직접 검증한다. Publish는 registry에서 platform별 SPDX를 다시 추출해
manifest subject와 대조한 뒤 원본 JSON을 GitHub Release asset으로 보존한다.

### EPL source와 Release asset

Release 준비 단계는 npm registry의 exact `elkjs-0.12.0.tgz` byte를 내려받고 `pnpm-lock.yaml`의 SHA-512 integrity와
비교한다. 재압축하거나 수정하지 않는다. 설치된 `LICENSE.md`, image의
`/app/licenses/elkjs-EPL-2.0.txt`와 Release license asset도 byte/hash로 연결한다.

GitHub Release는 CycloneDX, 두 platform SPDX, exact ELK source archive, EPL text와 `SHA256SUMS`를 함께 제공한다.
Existing Release는 모든 asset의 SHA-256이 같을 때만 replay하고 하나라도 다르면
`RELEASE_SBOM_ASSET_CONFLICT`로 차단한다. 실제 stable tag publish는 M4-011과 `P0-RELEASE` gate 뒤에만 수행한다.

## Alternatives considered

### CycloneDX 하나로 모든 evidence 표현

Application graph에는 적합하지만 OS package와 platform별 native filesystem 차이를 증명하지 못한다. Application은
CycloneDX, container filesystem은 BuildKit SPDX를 사용한다.

### SPDX scanner 결과만 제공

Image에 보이는 package는 제공하지만 pnpm workspace edge와 dual-license 선택을 명확히 고정하기 어렵다. 별도
application CycloneDX를 유지한다.

### EPL source URL만 고지

Upstream URL은 시간이 지나며 바뀔 수 있고 배포 byte와 exact source archive의 연결을 증명하지 못한다. Lockfile
integrity로 검증한 source archive를 versioned Release asset으로 함께 제공한다.

## Consequences

- Release gate는 multi-platform filesystem scan과 asset hash 검증 때문에 더 오래 걸린다.
- Application CycloneDX는 재현 가능하지만 platform SPDX는 scanner가 기록한 생성 metadata를 원본 그대로 가진다.
- 새 production dependency나 license expression은 inventory와 SBOM closure 검증을 통과해야 한다.
- SBOM은 취약점 판정이나 VEX가 아니며 signing·SLSA provenance는 후속 범위다.

## Verification

- `pnpm licenses:check`
- `pnpm sbom:check`
- `pnpm test:release`
- `pnpm test:container`
