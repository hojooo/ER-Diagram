import type { PrimaryDialect, SourceRange } from "@er-diagram/contracts";
import type { SchemaGraph } from "@er-diagram/core";
import { useEffect, useRef, useSyncExternalStore } from "react";

import type {
  DiagramColumnEditRequest,
  DiagramViewportInsets,
} from "../diagram/base-schema-diagram-contract.js";
import { useUiLocale } from "../localization/ui-locale.js";
import { VisualCommandForm } from "./visual-command-form.js";
import type {
  VisualCommandDraft,
  VisualCommandSessionController,
} from "./visual-command-session.js";
import { isVisualCommandSessionBusy, VisualCommandStatusPanel } from "./visual-schema-inspector.js";

const INLINE_EDITOR_WIDTH_PX = 384;
const INLINE_EDITOR_HEIGHT_PX = 576;
const INLINE_EDITOR_GAP_PX = 8;
const INLINE_EDITOR_MARGIN_PX = 16;
const INLINE_EDITOR_MIN_SAFE_WIDTH_PX = 280;
const INLINE_EDITOR_MIN_SAFE_HEIGHT_PX = 320;

export interface CanvasColumnInlineEditorState {
  readonly request: DiagramColumnEditRequest;
  readonly initialDraft: Extract<VisualCommandDraft, { kind: "ALTER_COLUMN" }>;
  readonly openedSchemaHash: string;
  readonly switchBlocked: boolean;
}

export function CanvasColumnInlineEditor({
  state,
  graph,
  primaryDialect,
  commandSession,
  interactionDisabled,
  sourceNavigationEnabled,
  viewportInsets,
  onCancel,
  onOpenSource,
  onReloadLayouts,
  onReviewLatest,
}: {
  readonly state: CanvasColumnInlineEditorState;
  readonly graph: SchemaGraph;
  readonly primaryDialect: PrimaryDialect;
  readonly commandSession: VisualCommandSessionController;
  readonly interactionDisabled: boolean;
  readonly sourceNavigationEnabled: boolean;
  readonly viewportInsets: DiagramViewportInsets;
  readonly onCancel: () => void;
  readonly onOpenSource: (range: SourceRange | null) => void;
  readonly onReloadLayouts: () => void;
  readonly onReviewLatest: () => void;
}) {
  const { messages } = useUiLocale();
  const editorRef = useRef<HTMLElement>(null);
  const snapshot = useSyncExternalStore(
    commandSession.subscribe,
    commandSession.getSnapshot,
    commandSession.getSnapshot,
  );
  const position = positionInlineColumnEditor(state.request.anchor, {
    width: window.innerWidth,
    height: window.innerHeight,
    insets: viewportInsets,
  });
  const columnName = state.initialDraft.newName ?? state.request.selection.elementKey;
  const action = {
    id: `ALTER_COLUMN:${state.request.selection.elementKey}:canvas`,
    kind: "ALTER_COLUMN" as const,
    label: messages["visual.action.alterColumn"],
    targetElementKey: state.request.selection.elementKey,
  };

  useEffect(() => {
    editorRef.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
  }, []);

  return (
    <section
      ref={editorRef}
      className="nodrag nopan nowheel pointer-events-auto fixed z-50 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-cyan-400/40 bg-slate-950 shadow-2xl"
      style={position}
      role="dialog"
      aria-modal="false"
      aria-label={messages["visual.inlineEditorTitle"](columnName)}
      data-testid="canvas-column-inline-editor"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="text-xs text-slate-400">{messages["visual.inlineEditorShortcut"]}</p>
        {state.switchBlocked ? (
          <p
            className="mt-3 rounded-lg border border-amber-400/40 bg-amber-950/40 p-3 text-sm text-amber-100"
            role="alert"
          >
            {messages["visual.inlineEditorSwitchBlocked"]}
          </p>
        ) : null}
        <VisualCommandForm
          key={action.id}
          graph={graph}
          primaryDialect={primaryDialect}
          action={action}
          displayLabel={messages["visual.inlineEditorTitle"](columnName)}
          initialDraft={state.initialDraft}
          disabled={
            interactionDisabled ||
            isVisualCommandSessionBusy(snapshot) ||
            snapshot.status === "STALE_REVIEW"
          }
          submitOnModEnter
          onCancel={onCancel}
          onSubmit={(draft) => void commandSession.submit(draft, state.openedSchemaHash)}
        />
        <VisualCommandStatusPanel
          snapshot={snapshot}
          fallbackRange={graph.sourceMap[state.request.selection.elementKey] ?? null}
          sourceNavigationEnabled={sourceNavigationEnabled}
          onOpenSource={onOpenSource}
          onReloadLayouts={onReloadLayouts}
          onRetry={() => void commandSession.retrySafely()}
          onReview={onReviewLatest}
        />
      </div>
    </section>
  );
}

export function positionInlineColumnEditor(
  anchor: DiagramColumnEditRequest["anchor"],
  viewport: {
    readonly width: number;
    readonly height: number;
    readonly insets: DiagramViewportInsets;
  },
): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} {
  const insetLeft = Math.max(0, viewport.insets.left) + INLINE_EDITOR_MARGIN_PX;
  const insetRight = Math.max(
    insetLeft,
    viewport.width - Math.max(0, viewport.insets.right) - INLINE_EDITOR_MARGIN_PX,
  );
  const insetTop = Math.max(0, viewport.insets.top) + INLINE_EDITOR_MARGIN_PX;
  const insetBottom = Math.max(
    insetTop,
    viewport.height - Math.max(0, viewport.insets.bottom) - INLINE_EDITOR_MARGIN_PX,
  );
  const useViewportSheet =
    insetRight - insetLeft < INLINE_EDITOR_MIN_SAFE_WIDTH_PX ||
    insetBottom - insetTop < INLINE_EDITOR_MIN_SAFE_HEIGHT_PX;
  const safeLeft = useViewportSheet ? INLINE_EDITOR_MARGIN_PX : insetLeft;
  const safeRight = useViewportSheet
    ? Math.max(safeLeft, viewport.width - INLINE_EDITOR_MARGIN_PX)
    : insetRight;
  const safeTop = useViewportSheet ? INLINE_EDITOR_MARGIN_PX : insetTop;
  const safeBottom = useViewportSheet
    ? Math.max(safeTop, viewport.height - INLINE_EDITOR_MARGIN_PX)
    : insetBottom;
  const width = Math.min(INLINE_EDITOR_WIDTH_PX, Math.max(0, safeRight - safeLeft));
  const height = Math.min(INLINE_EDITOR_HEIGHT_PX, Math.max(0, safeBottom - safeTop));
  const rightCandidate = anchor.right + INLINE_EDITOR_GAP_PX;
  const leftCandidate = anchor.left - width - INLINE_EDITOR_GAP_PX;
  const maxLeft = Math.max(safeLeft, safeRight - width);
  const left =
    rightCandidate + width <= safeRight
      ? rightCandidate
      : leftCandidate >= safeLeft
        ? leftCandidate
        : Math.max(safeLeft, Math.min(anchor.left, maxLeft));
  const maxTop = Math.max(safeTop, safeBottom - height);
  const top = Math.max(safeTop, Math.min(anchor.top, maxTop));
  return { left, top, width, height };
}
