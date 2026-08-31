# ADR 0009: Portable project bundle v1과 atomic re-key import

## 상태

Accepted

## 맥락

Mounted SQLite volume 전체를 복구하는 운영 backup과 달리 사용자는 project 하나를 다른 self-host instance로
옮길 수 있어야 한다. Canonical DBML만 복사하면 invalid current draft, last-valid pointer, retained revision,
per-view layout과 SQL import evidence가 소실된다. 반대로 SQLite row와 내부 ID를 그대로 복제하면 대상 instance의
identity와 충돌하고 visual command receipt나 instance metadata까지 project portable format에 결합된다.

ZIP CRC와 archive path 검증만으로는 semantic entry의 완전성이나 content integrity를 증명할 수 없다. SQL import
artifact에는 opt-in original SQL이 포함될 수 있으므로 portable export 기본값에서 민감 source를 제거하되 남은
evidence hash도 일관되게 재계산해야 한다.

## 결정

### Versioned manifest와 content evidence

Portable container는 M4-002의 bounded ZIP reader를 사용하고 root `manifest.json`에 strict
`bundleSchemaVersion: 1` contract를 둔다. 허용하는 file은 current DBML, retained revision source, per-view layout과
선택된 SQL import artifact뿐이다. Manifest descriptor와 archive path는 code-unit 순서로 정렬하며 각 entry의
UTF-8 byte 수와 lowercase SHA-256을 검증한다. `bundleHash`는 자신을 제외한 manifest metadata와 ordered
descriptor의 canonical JSON SHA-256이다. ZIP CRC는 이 evidence를 대체하지 않는다.

Manifest에 선언하지 않은 entry, 선언했지만 누락된 entry, logical duplicate, byte/hash 불일치와 unsupported schema
version은 archive 전체를 fail-closed 처리한다. Parser version이 현재 runtime과 호환되지 않으면 source를 자동
migration하지 않고 import를 차단한다.

### New-project re-key와 atomic restore

Import는 existing project를 replace하지 않고 항상 새 project를 만든다. Project, revision과 import artifact ID는 새로
발급하고 reference를 함께 re-key한다. Name, dialect, source bytes, retained revision number/origin/validity/timestamp,
last-valid mapping, layout sidecar와 project timestamp는 보존한다. 같은 bundle을 여러 번 import하면 같은 이름의
서로 독립적인 project가 생길 수 있다.

Archive와 manifest를 전부 검증하고 current/last-valid source를 현재 isolated parser로 다시 확인한 뒤에만 SQLite
transaction을 시작한다. Project, revision, layout 또는 artifact insert 중 하나라도 실패하면 새 project 전체를
rollback한다. Visual command receipt, browser undo stack과 instance-level `app_metadata`는 portable data가 아니다.
이 identity까지 그대로 복구하는 기능은 whole-volume backup/restore가 담당한다.

### Report redaction

기본 `REDACTED` mode는 SQL import report를 포함하되 `originalSql=null`, retention `DISCARD`로 바꾸고 project
re-key를 반영해 preview evidence hash를 다시 계산한다. `PREVIEWED` artifact는 다른 instance에서 stale apply
capability가 되지 않도록 `CANCELLED`로 변환한다. `INCLUDE_RETAINED_SQL`은 사용자가 민감 source 포함을 별도로
확인한 경우에만 byte-identical original SQL을 보존하고, `OMIT`은 artifact 전체를 제외한다. On-demand SQL export
report는 durable project data가 아니므로 포함하지 않는다.

### Streaming HTTP 경계

Export는 project schema/layout revision을 optimistic snapshot token으로 확인하고 entry를 한 번에 하나씩 staging한
뒤 streaming ZIP을 만든다. 완료 전 project history, layout 또는 artifact index가 바뀌면 staged output을 폐기하고
`409`를 반환한다. Import는 raw `application/zip`을 mode-0600 temporary file에 bounded streaming하고 validated
entry만 generated staging filename에 저장한다. Client filename과 archive path는 filesystem destination으로 쓰지
않는다. 성공·실패·abort 이후 temporary data를 제거한다.

Import의 `x-command-id`는 transport correlation이며 durable replay registry가 아니다. 응답 유실 때 Web은 같은
upload를 자동 재전송하지 않고 project list에서 결과를 확인하도록 안내한다.

## 결과

- Project 단위 이동은 source/history/layout/report를 함께 보존하면서 대상 instance identity와 격리된다.
- Entry/root SHA-256과 authoritative reparse가 archive 구조 검증과 별도로 semantic integrity를 증명한다.
- 기본 export는 retained SQL을 제거하지만 DBML 자체에는 실제 schema 정보가 포함됨을 UI에서 명시해야 한다.
- Bundle v1은 whole-volume backup, byte-deterministic Git artifact 또는 cross-version source migration을 대체하지
  않는다.

## 검증

- `pnpm test:integration bundles`
- `pnpm test:security archive-reader`
- `pnpm test:e2e project-bundle`
