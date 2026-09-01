# Core-flow accessibility keyboard checklist v1

이 문서는 axe로 자동 판정할 수 없는 keyboard 흐름을 production Compose에서 반복 검증하기 위한 운영
checklist다. 자동 검사 결과와 이 기록을 합쳐 M4-007 evidence로 사용한다. Axe violation 0건만으로 전체 WCAG
적합성을 주장하지 않는다.

## 실행 환경 기록

각 실행은 다음 값을 먼저 기록한다.

- 실행 commit
- 날짜와 tester
- OS version
- current stable Chromium version
- `docker compose` image ID
- viewport와 zoom

Production runtime은 `docker compose up --build -d`로 시작한다. Browser는
`http://127.0.0.1:8080`을 새 profile로 열고 mouse, trackpad와 pointer click 없이 Tab, Shift+Tab, arrow key,
Enter, Space와 Escape만 사용한다. Dev server나 mocked component 결과는 이 checklist의 production evidence로
대체할 수 없다.

## Checklist

| ID | Keyboard-only acceptance |
| --- | --- |
| `A11Y-KB-001` | 최초 Tab으로 `Skip to main content`가 나타나며 Enter 뒤 main landmark로 이동한다. |
| `A11Y-KB-002` | Project Home empty/list, create, rename, duplicate와 delete를 논리적인 Tab 순서로 완료할 수 있다. |
| `A11Y-KB-003` | Client-side route 전환마다 visible `h1`과 document title이 일치하고 구체적인 dialog/source focus를 덮어쓰지 않는다. |
| `A11Y-KB-004` | 모든 destructive dialog는 Cancel에 초기 focus가 있고 Tab trap, Escape와 trigger focus return이 동작한다. |
| `A11Y-KB-005` | Monaco source를 keyboard로 편집·저장하고 diagnostic range로 이동할 수 있으며 local buffer를 잃지 않는다. |
| `A11Y-KB-006` | Outline에서 table, column, reference와 group을 선택하고 diagram focus, source line과 inspector action으로 이동할 수 있다. |
| `A11Y-KB-007` | React Flow의 모든 node·edge가 Tab 순서를 점유하지 않으며 zoom, fit, collapse, view와 LOD control은 keyboard로 사용할 수 있다. |
| `A11Y-KB-008` | Inspector toolbar가 roving Tab, Left/Right, Home과 End를 지원하고 disabled action을 실행하지 않는다. |
| `A11Y-KB-009` | Current-view search가 input focus를 유지한 채 Arrow로 active option을 바꾸고 Enter로 선택하며 Escape로 닫힌다. |
| `A11Y-KB-010` | Visual form의 label, fieldset과 설명을 따라 mutation을 완료하고 validation 실패 시 입력 보존과 invalid focus를 확인한다. |
| `A11Y-KB-011` | Inspector input·textarea의 Cmd/Ctrl+Z는 native field undo로 동작하고 Monaco·diagram shortcut만 schema revision undo/redo를 실행한다. |
| `A11Y-KB-012` | Invalid draft에서 last-valid diagram과 source-navigation 차단을 이해할 수 있고 source 수정으로 valid 상태를 복구한다. |
| `A11Y-KB-013` | Layout reset/conflict와 source conflict/navigation blocker에서 상태, 선택지와 correlation ID를 color 없이 이해하고 복구한다. |
| `A11Y-KB-014` | Undo/redo와 source-free History를 keyboard로 사용하고 restore confirmation, invalid restore와 reload 뒤 session reset을 확인한다. |
| `A11Y-KB-015` | New/replace SQL import의 edit, report filter, source range, loss acknowledgement와 DML exclusion acknowledgement를 완료한다. |
| `A11Y-KB-016` | SQL export report와 download acknowledgement, bundle import/export와 retained SQL confirmation을 완료한다. |
| `A11Y-KB-017` | Save, validation, worker, import/export, conflict와 history 결과가 text와 live status로 전달되며 같은 결과를 중복 발표하지 않는다. |
| `A11Y-KB-018` | Browser 200% zoom과 320 CSS px 상당 폭에서 본질적인 2D canvas 외 core content와 action이 손실되거나 가려지지 않는다. |

## 결과 기록 규칙

각 ID는 `PASS` 또는 `FAIL`과 짧은 관찰 note를 기록한다. `FAIL`은 known issue나 외부 component 예외로
완화하지 않고 수정 후 전체 checklist를 다시 실행한다. 실행 도중 pointer를 사용했거나 production Compose가 아닌
환경으로 전환했다면 해당 실행은 evidence로 사용하지 않는다.

## 실행 결과 — 2026-09-01

- 실행 code commit: `5908beec7b00865aac7993a4b530ed9eacdc07f5`
- Tester: Codex, keyboard-only walkthrough와 automation-assisted state inspection
- OS: macOS `15.3.1` (`24D70`)
- Browser: core-flow walkthrough Chrome `151.0.7922.174`, final revalidation Chrome `152.0.7977.65`
- Production image: keyboard walkthrough
  `sha256:b75e851dc5eec266f1a14f7428c02a77ac3ffc75d1f2762aecf2740d988955fc`, final rebuilt
  container·lifecycle·zoom verification
  `sha256:32b634fce447561b21b716f0efef049a62d22901e62bd5b633f018482ac8f6e0`
- Viewport: default 1280 CSS px, actual Chrome 200% page zoom에서 640 CSS px, 640px browser window와
  200% page zoom에서 320 CSS px
- Automated evidence: `pnpm test:accessibility`, `pnpm test:e2e:security`, `pnpm test:container`,
  `pnpm test:runtime-lifecycle`, 전체 `pnpm test:e2e`

| ID | 결과 | 관찰 note |
| --- | --- | --- |
| `A11Y-KB-001` | PASS | 최초 Tab에서 skip link가 나타났고 Enter 뒤 `main#main-content`로 이동했다. |
| `A11Y-KB-002` | PASS | Project create, rename, duplicate와 Cancel-first delete를 keyboard만으로 완료했다. |
| `A11Y-KB-003` | PASS | Route별 `h1`·title이 동기화됐고 dialog/source focus가 route focus에 덮이지 않았다. |
| `A11Y-KB-004` | PASS | Destructive dialog가 Cancel-first, focus trap, Escape와 정확한 trigger focus return을 제공했다. |
| `A11Y-KB-005` | PASS | Monaco edit·save와 diagnostic range focus 뒤에도 local source buffer가 유지됐다. |
| `A11Y-KB-006` | PASS | Outline에서 table, column, reference와 group을 선택해 diagram, source와 inspector로 이동했다. |
| `A11Y-KB-007` | PASS | React Flow node·edge는 Tab 순서에서 제외됐고 view, LOD, collapse, fit과 zoom control은 keyboard로 동작했다. |
| `A11Y-KB-008` | PASS | Inspector toolbar가 roving Tab, Arrow, Home과 End를 처리하고 disabled action을 건너뛰었다. |
| `A11Y-KB-009` | PASS | Search input focus와 active descendant가 유지됐고 Arrow, Enter와 Escape가 의도대로 동작했다. |
| `A11Y-KB-010` | PASS | 대표 20-command form의 label·fieldset을 확인했고 invalid submit이 입력을 보존한 채 첫 오류로 focus했다. |
| `A11Y-KB-011` | PASS | Inspector field에서는 native undo가, Monaco와 diagram에서는 revision undo·redo가 각각 동작했다. |
| `A11Y-KB-012` | PASS | Invalid draft에서 last-valid diagram과 source-navigation 차단을 확인하고 valid source로 복구했다. |
| `A11Y-KB-013` | PASS | Layout/source conflict, reset과 navigation blocker를 color 외 text로 구분하고 keyboard로 복구했다. |
| `A11Y-KB-014` | PASS | Undo·redo, source-free History와 Cancel-first restore를 수행하고 reload 뒤 session reset을 확인했다. |
| `A11Y-KB-015` | PASS | New/replace SQL import, report range와 loss·DML acknowledgement를 서로 독립적으로 완료했다. |
| `A11Y-KB-016` | PASS | SQL export acknowledgement와 bundle import/export의 retained SQL confirmation을 완료했다. |
| `A11Y-KB-017` | PASS | Save, validation, worker, conflict, import/export와 history 결과가 text·live status로 한 번씩 전달됐다. |
| `A11Y-KB-018` | PASS | Chrome의 실제 page zoom 200%에서 640·320 CSS px 모두 `scrollWidth === clientWidth`였고 core action이 유지됐다. |

자동 axe gate는 stable core state에서 대상 WCAG tag violation 0건이었다. 이 표는 자동화할 수 없는 keyboard와
focus 흐름의 production evidence이며 screen-reader vendor별 인증이나 전체 WCAG 적합성 인증을 의미하지 않는다.
