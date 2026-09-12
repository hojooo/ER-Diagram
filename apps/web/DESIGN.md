---
name: DBML·SQL ERD Studio
description: 큰 스키마를 탐색하고 안전하게 편집하는 다크 작업 공간
colors:
  primary: "#67e8f9"
  primary-hover: "#a5f3fc"
  on-primary: "#082f49"
  page: "#07101f"
  surface: "#0f172a"
  raised: "#17243a"
  border: "#475569"
  divider: "#29364d"
  text: "#e2e8f0"
  muted: "#a8b8cc"
  selected: "#12374a"
  danger: "#fecaca"
  danger-surface: "#3f1726"
  danger-border: "#a65366"
  danger-hover: "#572235"
  warning: "#fde68a"
  success: "#a7f3d0"
typography:
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  control:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
  label:
    fontSize: "12px"
  badge:
    fontSize: "11px"
rounded:
  control: "8px"
  surface: "12px"
spacing:
  tight: "8px"
  control: "12px"
  group: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "8px 12px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "8px 12px"
---

## Overview

현재 구현의 디자인 기준이다. 제품 동작은 [PRD](../../docs/product/PRD.md)가 정본이며 이 문서는
그 범위나 계약을 변경하지 않는다. 개인 개발자·설계자의 반복 작업을 위해 기존 다크 톤과 청록색 강조를
유지한다. 새 로고, 외부 폰트, 장식 이미지나 테마 전환을 도입하지 않는다.

## Colors

본문과 조작은 text, 보조 정보는 muted, 실행할 주요 행동은 primary를 사용한다. 선택 상태와 hover를
구별한다. 오류·경고·성공은 색상과 문구로 함께 표시한다. 네이티브 입력과 스크롤바도 다크 표면을 따른다.
공통 토큰과 조작 스타일은 `src/ui.css`, 다이어그램 전용 표현은 `src/styles.css`에 있다.

## Typography

일반 본문과 입력은 body 기준, 보조 라벨·간결한 도구 버튼은 12px 이상이다. 컬럼명과 타입은 12px,
키 배지는 11px이다. SQL·DBML·타입에는 고정폭 글꼴을 사용한다. 긴 한국어·영어 문구는 줄바꿈하며,
고정 크기 테이블 노드의 이름은 말줄임하되 전체 이름을 접근성 이름·title·Outline·Inspector에서 확인한다.

## Layout

프로젝트 홈과 독립 import/export는 문서형이다. 프로젝트 열기·생성·검증 상태를 우선하고 운영 정보는
목록 다음에 둔다. 작업 화면은 캔버스와 좌우 dock을 유지한다. 패널 기본 폭 512px, 조절 범위 360–768px,
1280px 미만의 배타적 전체 화면 panel과 safe-area 계산은 PRD를 따른다.

테이블 폭 260px, 헤더 48px, 컬럼 행 28px, 그룹 헤더 56px은 projection 계산과 일치해야 한다.
글자 크기를 변경할 때 노드 크기·관계선·저장된 레이아웃을 암묵적으로 변경하지 않는다.

## Elevation & Depth

패널과 인라인 편집은 불투명 표면으로 캔버스와 구분한다. 기존 shadow와 z-index 순서를 유지한다.
CSS 전환은 짧은 상태 피드백에만 쓰며 reduced-motion 환경에서는 중단한다. 폼의 버튼은 hover 때문에 이동하지 않는다.

## Shapes

폼 조작은 control 모서리, 문서의 내용 묶음은 surface 모서리를 따른다. 상태 배지와 기존 패널 toggle은
작은 둥근 표현을 유지한다. 메타데이터마다 추가 상자를 만들지 않는다.

## Components

- 버튼: 기본·보조·위험·선택 가능한 편집 action을 구분하며 동일한 focus/disabled 규칙을 공유한다.
  일반 조작의 최소 높이는 44px, 간결한 도구 조작은 40px이다. 문구 줄바꿈에 따라 더 높아질 수 있다.
- 입력: 레이블과 오류 연결을 유지하고 네이티브 select·파일 입력을 그대로 사용한다.
- SQL 단계: 실제 입력·검토·적용 또는 다운로드 가능 상태를 표시한다. 단계 표시는 이동 버튼이 아니다.
- 다이얼로그: 기존 Radix와 focus trap·Escape·trigger focus return을 보존한다.
- 캔버스: hover·선택을 구별하고 긴 이름이 다른 컬럼 영역으로 그려지지 않게 한다.

## Do's and Don'ts

- 일반 문서 폭은 320px에서도 가로 넘침이 없어야 한다. 본질적인 2D 캔버스와 코드 원문의 스크롤은 예외다.
- 패널 열기·닫기·resize로 source/form draft, viewport나 schema revision을 바꾸지 않는다.
- invalid draft·충돌·SQL 손실 확인을 단순한 성공 상태로 표시하지 않는다.
- 원문·진단·다운로드 바이트는 표시 개선을 이유로 변경하지 않는다.
- Impeccable detector 결과는 기존 제품의 의도와 함께 판단한다. 선언된 refinement 범위를 넘는
  폰트 교체·카드 제거·색감 재설계는 자동 적용하지 않는다.
