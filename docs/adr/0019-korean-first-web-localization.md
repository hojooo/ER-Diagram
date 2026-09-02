# ADR 0019: Korean-first Web localization과 client-only language preference

- 상태: `ACCEPTED`
- 결정일: 2026-09-02
- 적용 범위: Web product UI

## Context

DBML·SQL ERD Studio의 Web UI는 기존에 영어 문구를 component 안에 직접 보유했다. 한국어를 기본
언어로 제공하려면 product workflow 전체의 visible text와 accessibility name을 같은 locale 계약으로
전환해야 한다. 단순히 최상위 page만 번역하면 dialog, live region, error recovery와 visual command form이
서로 다른 언어로 노출되고 keyboard·screen reader contract도 일관성을 잃는다.

반면 project name, DBML·SQL source, diagnostic message와 evidence hash는 product 문구가 아니다. 이 데이터를
번역하면 byte fidelity와 troubleshooting evidence를 훼손할 수 있다. 언어 preference를 project·server state로
저장하는 것도 portable project·backup contract에 사용자 UI 설정을 섞는 불필요한 변경을 만든다.

## Decision

### Locale contract

Web 내부에 `UiLocale = "ko" | "en"`과 type-safe message catalog를 둔다. 두 catalog는 같은 key와
interpolation signature를 compile time에 검증한다. 기본값은 browser·OS language negotiation을 하지 않고
항상 `ko`로 고정한다. 날짜와 숫자는 locale별 `ko-KR`, `en-US`를 명시해 형식화한다.

Locale provider는 `<html lang>`, document title, route heading, visible text, accessible name과 live region을 같이
갱신한다. Locale 전환은 provider state만 변경하며 Router, Query client, Monaco model, Diagram,
source·layout session과 visual form의 identity를 바꾸지 않는다.

### Persistence·selection surface

선택값은 `er-diagram.ui-locale.v1` localStorage key에만 저장한다. `ko`와 `en` 외의 값, 손상된
storage, read/write 예외는 한국어 fallback 또는 in-memory 전환으로 처리하고 UI를 차단하지
않는다. 이 값은 URL, HTTP request, project data, SQLite, bundle·backup과 operational log에 포함하지 않는다.

Native language select는 한 route에 하나만 노출한다. 일반 route는 AppShell header, canvas workspace는
floating command bar, router 이전 startup·root error는 각 recovery surface에 배치한다.

### Translation boundary

Project Home, canvas workspace, Source·Outline·Inspector, visual command 20종, history, SQL import·export,
portable bundle, startup·route·error와 접근성 문구를 모두 catalog에서 제공한다. DBML, SQL,
parser, schema hash, PostgreSQL·MySQL 같은 기술 식별자는 유지한다.

사용자가 작성한 project·schema name, source, note, comment, SQL·DBML, hash, code, correlation ID,
download bytes는 절대 번역하지 않는다. Parser·server diagnostic message도 원문을 유지하고
버튼, 제목, 상태, recovery instruction만 locale에 맞게 보여준다.

## Alternatives considered

### Browser language에 따른 최초 언어 탐지

제품의 Korean-first 정체성과 같은 browser profile에서의 결정론적 첫 진입을 약화한다. English는
명시적으로 선택할 수 있으므로 negotiation을 사용하지 않는다.

### Server-side preference

P0에는 account·user preference domain이 없다. UI locale 하나를 위해 project contract·SQLite·bundle을
변경하지 않고 browser-local state로 국한한다.

### Diagnostic message 번역

Native parser·server message를 catalog key로 재해석하면 version drift와 오역 가능성이 있다. Evidence는
원문을 유지하고 product-owned context만 번역한다.

## Consequences

- UI text와 accessibility contract의 변경은 두 catalog를 함께 갱신해야 한다.
- Existing behavior test는 explicit English render helper로 selector를 안정화하고 Korean-first 기본값은 별도
  localization matrix로 검증한다.
- LocalStorage를 사용할 수 없는 environment에서도 한국어 UI와 현재 session 전환은 동작한다.
- E2E·accessibility locale acceptance는 CI에서 자동 실행하지 않고 operator가 명시적으로 실행한다.

## Verification

- `pnpm --filter @er-diagram/web test test/localization.test.tsx`
- `pnpm --filter @er-diagram/web test`
- `pnpm --filter @er-diagram/web typecheck`
- `pnpm --filter @er-diagram/web build`
- `pnpm test:e2e localization`
- `pnpm test:accessibility`
