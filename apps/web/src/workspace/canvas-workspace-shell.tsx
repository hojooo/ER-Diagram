import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { DiagramViewportInsets } from "../diagram/base-schema-diagram-contract.js";
import { useUiLocale } from "../localization/ui-locale.js";

export type WorkspaceLeftSurface = "SOURCE" | "OUTLINE" | null;

const COLLAPSED_LEFT_RAIL_WIDTH_PX = 56;
const DEFAULT_LEFT_PANEL_WIDTH_PX = 512;
const COLLAPSED_RIGHT_PANEL_WIDTH_PX = 12;
const DEFAULT_RIGHT_PANEL_WIDTH_PX = 512;
const MIN_RIGHT_PANEL_WIDTH_PX = 360;
const MAX_RIGHT_PANEL_WIDTH_PX = 768;
const RIGHT_PANEL_KEYBOARD_STEP_PX = 16;

export interface CanvasWorkspaceSurfaces {
  readonly leftSurface: WorkspaceLeftSurface;
  readonly rightPanelOpen: boolean;
  readonly isNarrow: boolean;
  readonly openLeft: (
    surface: Exclude<WorkspaceLeftSurface, null>,
    trigger?: HTMLElement | null,
  ) => void;
  readonly toggleLeft: (surface: Exclude<WorkspaceLeftSurface, null>, trigger: HTMLElement) => void;
  readonly closeLeft: (returnFocus?: boolean, fallback?: HTMLElement | null) => void;
  readonly openRightPanel: (trigger?: HTMLElement | null) => void;
  readonly toggleRightPanel: (trigger: HTMLElement) => void;
  readonly closeRightPanel: (returnFocus?: boolean, fallback?: HTMLElement | null) => void;
}

export function useCanvasWorkspaceSurfaces({
  initialLeftSurface = null,
  initialRightPanelOpen = true,
  isNarrow,
}: {
  readonly initialLeftSurface?: WorkspaceLeftSurface;
  readonly initialRightPanelOpen?: boolean;
  readonly isNarrow?: boolean;
} = {}): CanvasWorkspaceSurfaces {
  const narrow = useNarrowWorkspace(isNarrow);
  const [leftSurface, setLeftSurface] = useState<WorkspaceLeftSurface>(initialLeftSurface);
  const [rightPanelOpen, setRightPanelOpen] = useState(initialRightPanelOpen && !narrow);
  const leftTriggerRef = useRef<HTMLElement | null>(null);
  const rightPanelTriggerRef = useRef<HTMLElement | null>(null);
  const lastOpenedRef = useRef<"LEFT" | "RIGHT">(
    initialRightPanelOpen && !narrow ? "RIGHT" : "LEFT",
  );

  const openLeft = useCallback(
    (surface: Exclude<WorkspaceLeftSurface, null>, trigger?: HTMLElement | null) => {
      leftTriggerRef.current = trigger ?? null;
      lastOpenedRef.current = "LEFT";
      setLeftSurface(surface);
      if (narrow) setRightPanelOpen(false);
    },
    [narrow],
  );
  const closeLeft = useCallback((returnFocus = true, fallback?: HTMLElement | null) => {
    setLeftSurface(null);
    if (returnFocus) focusConnectedElement(leftTriggerRef.current, fallback);
  }, []);
  const toggleLeft = useCallback(
    (surface: Exclude<WorkspaceLeftSurface, null>, trigger: HTMLElement) => {
      if (leftSurface === surface) {
        closeLeft();
        return;
      }
      openLeft(surface, trigger);
    },
    [closeLeft, leftSurface, openLeft],
  );
  const openRightPanel = useCallback(
    (trigger?: HTMLElement | null) => {
      rightPanelTriggerRef.current = trigger ?? null;
      lastOpenedRef.current = "RIGHT";
      setRightPanelOpen(true);
      if (narrow) setLeftSurface(null);
    },
    [narrow],
  );
  const closeRightPanel = useCallback((returnFocus = true, fallback?: HTMLElement | null) => {
    setRightPanelOpen(false);
    if (returnFocus) focusConnectedElement(rightPanelTriggerRef.current, fallback);
  }, []);
  const toggleRightPanel = useCallback(
    (trigger: HTMLElement) => {
      if (rightPanelOpen) {
        rightPanelTriggerRef.current = trigger;
        closeRightPanel();
        return;
      }
      openRightPanel(trigger);
    },
    [closeRightPanel, openRightPanel, rightPanelOpen],
  );

  useEffect(() => {
    if (!narrow || leftSurface === null || !rightPanelOpen) return;
    if (lastOpenedRef.current === "LEFT") setRightPanelOpen(false);
    else setLeftSurface(null);
  }, [leftSurface, narrow, rightPanelOpen]);

  return {
    leftSurface,
    rightPanelOpen,
    isNarrow: narrow,
    openLeft,
    toggleLeft,
    closeLeft,
    openRightPanel,
    toggleRightPanel,
    closeRightPanel,
  };
}

function useNarrowWorkspace(override: boolean | undefined): boolean {
  const [matches, setMatches] = useState(() =>
    override === undefined &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 79.999rem)").matches
      : (override ?? false),
  );
  useEffect(() => {
    if (override !== undefined) {
      setMatches(override);
      return;
    }
    if (typeof window.matchMedia !== "function") {
      setMatches(false);
      return;
    }
    const query = window.matchMedia("(max-width: 79.999rem)");
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [override]);
  return matches;
}

export function CanvasWorkspaceShell({
  surfaces,
  commandBar,
  diagram,
  diagramTools,
  source,
  outline,
  inspector,
  status,
  alerts,
  onViewportInsetsChange,
}: {
  readonly surfaces: CanvasWorkspaceSurfaces;
  readonly commandBar: ReactNode;
  readonly diagram: ReactNode;
  readonly diagramTools: ReactNode;
  readonly source: ReactNode;
  readonly outline: ReactNode;
  readonly inspector: ReactNode;
  readonly status: ReactNode;
  readonly alerts?: ReactNode;
  readonly onViewportInsetsChange?: (insets: DiagramViewportInsets) => void;
}) {
  const { messages } = useUiLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const commandBarRef = useRef<HTMLDivElement>(null);
  const leftDockRef = useRef<HTMLElement>(null);
  const sourceRailButtonRef = useRef<HTMLButtonElement>(null);
  const outlineRailButtonRef = useRef<HTMLButtonElement>(null);
  const rightDockRef = useRef<HTMLElement>(null);
  const rightPanelToggleRef = useRef<HTMLButtonElement>(null);
  const rightPanelResizeRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startWidth: number;
  } | null>(null);
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH_PX);
  const [resizingRightPanel, setResizingRightPanel] = useState(false);
  const setRightDockRef = useCallback((element: HTMLElement | null) => {
    rightDockRef.current = element;
  }, []);
  const setLeftDockRef = useCallback((element: HTMLElement | null) => {
    leftDockRef.current = element;
  }, []);
  const statusRef = useRef<HTMLDivElement>(null);
  const alertsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!resizingRightPanel) return;
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "ew-resize";
    document.documentElement.style.userSelect = "none";
    const handlePointerMove = (event: PointerEvent) => {
      const resize = rightPanelResizeRef.current;
      if (!resize || event.pointerId !== resize.pointerId) return;
      setRightPanelWidth(clampRightPanelWidth(resize.startWidth + resize.startX - event.clientX));
    };
    const finishResize = (event: PointerEvent) => {
      const resize = rightPanelResizeRef.current;
      if (!resize || event.pointerId !== resize.pointerId) return;
      rightPanelResizeRef.current = null;
      setResizingRightPanel(false);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      document.documentElement.style.cursor = previousCursor;
      document.documentElement.style.userSelect = previousUserSelect;
    };
  }, [resizingRightPanel]);

  useEffect(() => {
    if (!surfaces.isNarrow || !surfaces.rightPanelOpen) return;
    const animationFrame = window.requestAnimationFrame(() => {
      firstFocusable(rightDockRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [surfaces.isNarrow, surfaces.rightPanelOpen]);

  const sourceOpen = surfaces.leftSurface === "SOURCE";
  const outlineOpen = surfaces.leftSurface === "OUTLINE";
  const leftOpen = sourceOpen || outlineOpen;
  const leftPanelWidth = leftOpen ? DEFAULT_LEFT_PANEL_WIDTH_PX : COLLAPSED_LEFT_RAIL_WIDTH_PX;
  const leftDockWidth = leftOpen
    ? surfaces.isNarrow
      ? "100%"
      : `${DEFAULT_LEFT_PANEL_WIDTH_PX}px`
    : `${COLLAPSED_LEFT_RAIL_WIDTH_PX}px`;
  const reservedLeftWidth =
    (surfaces.isNarrow ? COLLAPSED_LEFT_RAIL_WIDTH_PX : leftPanelWidth) + 12;
  const reservedRightWidth =
    !surfaces.isNarrow && surfaces.rightPanelOpen
      ? rightPanelWidth + 12
      : COLLAPSED_RIGHT_PANEL_WIDTH_PX + 12;
  const dockWidth = surfaces.rightPanelOpen
    ? surfaces.isNarrow
      ? "100%"
      : `${rightPanelWidth}px`
    : `${COLLAPSED_RIGHT_PANEL_WIDTH_PX}px`;
  useWorkspaceInsets({
    rootRef,
    commandBarRef,
    leftDockRef,
    rightDockRef,
    statusRef,
    alertsRef,
    leftPanelOpen: leftOpen,
    leftPanelWidth,
    rightPanelOpen: surfaces.rightPanelOpen,
    rightPanelWidth,
    ...(onViewportInsetsChange ? { onChange: onViewportInsetsChange } : {}),
  });

  return (
    <div
      ref={rootRef}
      className="relative isolate h-full min-h-0 w-full overflow-hidden bg-slate-950"
      data-testid="canvas-workspace-shell"
    >
      <div className="absolute inset-0 z-0">{diagram}</div>
      <div
        ref={commandBarRef}
        data-testid="workspace-command-bar"
        className={`pointer-events-none absolute top-3 z-30 flex justify-center ${
          resizingRightPanel ? "transition-none" : "transition-[left,right] duration-200"
        }`}
        style={{ left: reservedLeftWidth, right: reservedRightWidth }}
      >
        <div className="pointer-events-auto max-w-full rounded-2xl border border-slate-700/90 bg-slate-950/90 shadow-2xl backdrop-blur-md">
          {commandBar}
        </div>
      </div>

      <LeftToolDock
        dockRef={setLeftDockRef}
        label={messages["workspace.leftToolsPanel"]}
        dialog={surfaces.isNarrow && leftOpen}
        panelState={leftOpen ? "open" : "collapsed"}
        onKeyDown={(event) =>
          handleLeftPanelKeyDown(
            event,
            surfaces,
            leftDockRef.current,
            sourceOpen ? sourceRailButtonRef.current : outlineRailButtonRef.current,
          )
        }
        className={`absolute inset-y-0 left-0 overflow-hidden border-r border-slate-700/90 bg-slate-950/90 shadow-2xl backdrop-blur-md transition-[width] duration-200 ${
          surfaces.isNarrow && leftOpen ? "z-50" : "z-40"
        }`}
        style={{ width: leftDockWidth }}
      >
        <nav
          aria-label={messages["workspace.leftToolsPanel"]}
          className="absolute inset-y-0 left-0 z-10 flex w-14 flex-col items-center gap-2 border-r border-slate-700 bg-slate-950 px-1 py-3"
          data-testid="workspace-left-tool-rail"
        >
          <LeftRailButton
            buttonRef={sourceRailButtonRef}
            label={messages["workspace.source"]}
            controls="workspace-source-surface"
            expanded={sourceOpen}
            icon="SOURCE"
            onClick={(trigger) => surfaces.toggleLeft("SOURCE", trigger)}
          />
          <LeftRailButton
            buttonRef={outlineRailButtonRef}
            label={messages["workspace.outline"]}
            controls="workspace-outline-surface"
            expanded={outlineOpen}
            icon="OUTLINE"
            onClick={(trigger) => surfaces.toggleLeft("OUTLINE", trigger)}
          />
        </nav>
        <div
          id="workspace-left-panel-content"
          aria-hidden={!leftOpen}
          inert={!leftOpen}
          className={`absolute inset-y-0 left-14 right-0 min-w-0 overflow-hidden ${
            leftOpen ? "visible" : "invisible"
          }`}
        >
          <section
            id="workspace-source-surface"
            aria-label={messages["source.surface"]}
            aria-hidden={!sourceOpen}
            inert={!sourceOpen}
            className={`absolute inset-0 overflow-auto p-4 ${sourceOpen ? "visible" : "invisible"}`}
          >
            {source}
          </section>
          <section
            id="workspace-outline-surface"
            aria-label={messages["outline.label"]}
            aria-hidden={!outlineOpen}
            inert={!outlineOpen}
            className={`absolute inset-0 overflow-auto p-4 ${outlineOpen ? "visible" : "invisible"}`}
          >
            {outline}
          </section>
        </div>
      </LeftToolDock>

      <RightToolDock
        dockRef={setRightDockRef}
        label={messages["workspace.toolsPanel"]}
        dialog={surfaces.isNarrow && surfaces.rightPanelOpen}
        panelState={surfaces.rightPanelOpen ? "open" : "collapsed"}
        onKeyDown={(event) =>
          handleRightPanelKeyDown(
            event,
            surfaces,
            rightDockRef.current,
            rightPanelToggleRef.current,
          )
        }
        className={`absolute inset-y-0 right-0 z-40 overflow-visible border-l border-slate-700/90 bg-slate-950/90 shadow-2xl backdrop-blur-md ${resizingRightPanel ? "transition-none" : "transition-[width] duration-200"}`}
        style={{ width: dockWidth }}
      >
        <button
          ref={rightPanelToggleRef}
          type="button"
          className={`absolute z-20 grid place-items-center rounded-full border border-slate-500 bg-slate-950 text-cyan-200 shadow-xl hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 ${
            surfaces.isNarrow && surfaces.rightPanelOpen
              ? "left-3 top-3 size-8"
              : "left-0 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2"
          }`}
          aria-label={
            surfaces.rightPanelOpen
              ? messages["workspace.collapseTools"]
              : messages["workspace.openTools"]
          }
          aria-expanded={surfaces.rightPanelOpen}
          aria-controls="workspace-right-panel-content"
          onClick={(event) => surfaces.toggleRightPanel(event.currentTarget)}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-4 fill-none stroke-current"
            strokeWidth="2"
          >
            <path d={surfaces.rightPanelOpen ? "m9 6 6 6-6 6" : "m15 6-6 6 6 6"} />
          </svg>
        </button>
        {surfaces.rightPanelOpen && !surfaces.isNarrow ? (
          <hr
            aria-label={messages["workspace.resizeTools"]}
            aria-orientation="vertical"
            aria-controls="workspace-right-panel-content"
            aria-valuemin={MIN_RIGHT_PANEL_WIDTH_PX}
            aria-valuemax={MAX_RIGHT_PANEL_WIDTH_PX}
            aria-valuenow={rightPanelWidth}
            aria-valuetext={messages["workspace.toolsWidth"](rightPanelWidth)}
            tabIndex={0}
            className="absolute inset-y-0 left-0 z-10 m-0 w-3 -translate-x-1/2 cursor-ew-resize touch-none border-0 before:pointer-events-none before:absolute before:left-1/2 before:top-1/2 before:h-12 before:w-0.5 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-slate-600 before:content-[''] hover:before:bg-cyan-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 focus-visible:before:bg-cyan-300"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              rightPanelResizeRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: rightPanelWidth,
              };
              setResizingRightPanel(true);
            }}
            onKeyDown={(event) => {
              let nextWidth: number | null = null;
              if (event.key === "ArrowLeft") {
                nextWidth = rightPanelWidth + RIGHT_PANEL_KEYBOARD_STEP_PX;
              } else if (event.key === "ArrowRight") {
                nextWidth = rightPanelWidth - RIGHT_PANEL_KEYBOARD_STEP_PX;
              } else if (event.key === "Home") {
                nextWidth = MIN_RIGHT_PANEL_WIDTH_PX;
              } else if (event.key === "End") {
                nextWidth = MAX_RIGHT_PANEL_WIDTH_PX;
              }
              if (nextWidth === null) return;
              event.preventDefault();
              setRightPanelWidth(clampRightPanelWidth(nextWidth));
            }}
          />
        ) : null}
        <div
          id="workspace-right-panel-content"
          aria-hidden={!surfaces.rightPanelOpen}
          inert={!surfaces.rightPanelOpen}
          className={`h-full w-full min-w-0 overflow-hidden ${
            surfaces.rightPanelOpen ? "visible" : "invisible"
          }`}
        >
          <div className="flex h-full min-h-0 flex-col">
            <section
              className="flex max-h-[50%] min-h-0 shrink-0 flex-col overflow-y-auto border-b border-slate-700"
              aria-label={messages["diagram.editable"]}
              data-testid="workspace-diagram-tools"
            >
              {diagramTools}
            </section>
            <div
              className="min-h-0 flex-1 overflow-y-auto"
              data-testid="workspace-inspector-scroll"
            >
              {inspector}
            </div>
          </div>
        </div>
      </RightToolDock>

      {alerts ? (
        <div
          ref={alertsRef}
          className={`pointer-events-none absolute bottom-16 z-30 flex justify-center ${
            resizingRightPanel ? "transition-none" : "transition-[left,right] duration-200"
          }`}
          style={{ left: reservedLeftWidth, right: reservedRightWidth }}
        >
          <div className="pointer-events-auto max-w-2xl">{alerts}</div>
        </div>
      ) : null}
      <div
        ref={statusRef}
        className={`pointer-events-none absolute bottom-3 z-30 flex justify-center ${
          resizingRightPanel ? "transition-none" : "transition-[left,right] duration-200"
        }`}
        style={{ left: reservedLeftWidth, right: reservedRightWidth }}
      >
        <div className="pointer-events-auto max-w-full rounded-xl border border-slate-700/90 bg-slate-950/90 shadow-xl backdrop-blur-md">
          {status}
        </div>
      </div>
    </div>
  );
}

function LeftRailButton({
  buttonRef,
  label,
  controls,
  expanded,
  icon,
  onClick,
}: {
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly label: string;
  readonly controls: string;
  readonly expanded: boolean;
  readonly icon: "SOURCE" | "OUTLINE";
  readonly onClick: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      className={`flex min-h-14 w-12 flex-col items-center justify-center gap-1 rounded-lg border px-1 py-2 text-[0.65rem] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 ${
        expanded
          ? "border-cyan-400/70 bg-cyan-400/15 text-cyan-100"
          : "border-transparent text-slate-300 hover:border-slate-600 hover:bg-slate-800 hover:text-white"
      }`}
      onClick={(event) => onClick(event.currentTarget)}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-4 fill-none stroke-current"
        strokeWidth="1.8"
      >
        {icon === "SOURCE" ? (
          <>
            <path d="M7 3.5h7l3 3V20.5H7z" />
            <path d="M14 3.5v3h3M9.5 11h5M9.5 14.5h5" />
          </>
        ) : (
          <>
            <path d="M5 5h4v4H5zM5 15h4v4H5zM15 5h4v4h-4zM15 15h4v4h-4z" />
            <path d="M9 7h6M7 9v6M17 9v6M9 17h6" />
          </>
        )}
      </svg>
      <span className="max-w-full truncate">{label}</span>
    </button>
  );
}

function LeftToolDock({
  dockRef,
  label,
  dialog,
  panelState,
  className,
  style,
  onKeyDown,
  children,
}: {
  readonly dockRef: (element: HTMLElement | null) => void;
  readonly label: string;
  readonly dialog: boolean;
  readonly panelState: "open" | "collapsed";
  readonly className: string;
  readonly style: CSSProperties;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly children: ReactNode;
}) {
  const dialogAttributes = dialog
    ? ({ role: "dialog", "aria-modal": true } as const)
    : ({} as const);
  const eventBoundary = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation(),
    onWheel: (event: ReactWheelEvent<HTMLElement>) => event.stopPropagation(),
  };
  return (
    <aside
      ref={dockRef}
      {...dialogAttributes}
      aria-label={label}
      data-testid="workspace-left-tool-dock"
      data-panel-state={panelState}
      className={className}
      style={style}
      onKeyDown={onKeyDown}
      {...eventBoundary}
    >
      {children}
    </aside>
  );
}

function RightToolDock({
  dockRef,
  label,
  dialog,
  panelState,
  className,
  style,
  onKeyDown,
  children,
}: {
  readonly dockRef: (element: HTMLElement | null) => void;
  readonly label: string;
  readonly dialog: boolean;
  readonly panelState: "open" | "collapsed";
  readonly className: string;
  readonly style: CSSProperties;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly children: ReactNode;
}) {
  const dialogAttributes = dialog
    ? ({ role: "dialog", "aria-modal": true } as const)
    : ({} as const);
  const eventBoundary = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation(),
    onWheel: (event: ReactWheelEvent<HTMLElement>) => event.stopPropagation(),
  };
  return (
    <aside
      ref={dockRef}
      {...dialogAttributes}
      aria-label={label}
      data-testid="workspace-right-tool-dock"
      data-panel-state={panelState}
      className={className}
      style={style}
      onKeyDown={onKeyDown}
      {...eventBoundary}
    >
      {children}
    </aside>
  );
}

function useWorkspaceInsets({
  rootRef,
  commandBarRef,
  leftDockRef,
  rightDockRef,
  statusRef,
  alertsRef,
  leftPanelOpen,
  leftPanelWidth,
  rightPanelOpen,
  rightPanelWidth,
  onChange,
}: {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly commandBarRef: RefObject<HTMLDivElement | null>;
  readonly leftDockRef: RefObject<HTMLElement | null>;
  readonly rightDockRef: RefObject<HTMLElement | null>;
  readonly statusRef: RefObject<HTMLDivElement | null>;
  readonly alertsRef: RefObject<HTMLDivElement | null>;
  readonly leftPanelOpen: boolean;
  readonly leftPanelWidth: number;
  readonly rightPanelOpen: boolean;
  readonly rightPanelWidth: number;
  readonly onChange?: (insets: DiagramViewportInsets) => void;
}) {
  const previousRef = useRef<DiagramViewportInsets | null>(null);
  useLayoutEffect(() => {
    if (!onChange) return;
    const measure = () => {
      const root = rootRef.current?.getBoundingClientRect();
      if (!root) return;
      const relativeBottom = (element: Element | null) =>
        element ? Math.max(0, element.getBoundingClientRect().bottom - root.top) : 0;
      const leftInset = (element: Element | null) =>
        element ? Math.max(0, element.getBoundingClientRect().right - root.left) : 0;
      const rightInset = (element: Element | null) =>
        element ? Math.max(0, root.right - element.getBoundingClientRect().left) : 0;
      const withSafeGap = (value: number) => (value > 0 ? value + 12 : 0);
      const leftDock = leftDockRef.current;
      const expectedLeftPanelState = leftPanelOpen ? "open" : "collapsed";
      const activeLeftDock =
        leftDock?.dataset.panelState === expectedLeftPanelState ? leftDock : null;
      const measuredLeftInset = leftInset(activeLeftDock);
      const effectiveLeftInset =
        activeLeftDock?.style.width === `${leftPanelWidth}px`
          ? Math.min(root.width, leftPanelWidth)
          : measuredLeftInset;
      const rightDock = rightDockRef.current;
      const expectedPanelState = rightPanelOpen ? "open" : "collapsed";
      const activeRightDock =
        rightDock?.dataset.panelState === expectedPanelState ? rightDock : null;
      const measuredRightInset = rightInset(activeRightDock);
      const effectiveRightInset =
        activeRightDock?.style.width === `${rightPanelWidth}px`
          ? Math.min(root.width, rightPanelWidth)
          : measuredRightInset;
      const next = {
        top: withSafeGap(relativeBottom(commandBarRef.current)),
        right: withSafeGap(effectiveRightInset),
        bottom: withSafeGap(
          Math.max(
            0,
            root.bottom - (statusRef.current?.getBoundingClientRect().top ?? root.bottom),
            root.bottom - (alertsRef.current?.getBoundingClientRect().top ?? root.bottom),
          ),
        ),
        left: withSafeGap(effectiveLeftInset),
      } satisfies DiagramViewportInsets;
      const previous = previousRef.current;
      if (
        previous &&
        previous.top === next.top &&
        previous.right === next.right &&
        previous.bottom === next.bottom &&
        previous.left === next.left
      ) {
        return;
      }
      previousRef.current = next;
      onChange(next);
    };
    measure();
    const ResizeObserverConstructor = window.ResizeObserver;
    if (!ResizeObserverConstructor) {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserverConstructor(measure);
    for (const element of [
      rootRef.current,
      commandBarRef.current,
      alertsRef.current,
      leftDockRef.current,
      rightDockRef.current,
      statusRef.current,
    ]) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [
    commandBarRef,
    alertsRef,
    rightDockRef,
    leftDockRef,
    leftPanelOpen,
    leftPanelWidth,
    rightPanelOpen,
    rightPanelWidth,
    onChange,
    rootRef,
    statusRef,
  ]);
}

function handleLeftPanelKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  surfaces: CanvasWorkspaceSurfaces,
  panel: HTMLElement | null,
  fallbackFocus: HTMLElement | null,
): void {
  if (event.defaultPrevented || surfaces.leftSurface === null) return;
  if (event.key === "Escape") {
    event.preventDefault();
    surfaces.closeLeft(true, fallbackFocus);
    return;
  }
  if (event.key !== "Tab" || !surfaces.isNarrow || !panel) return;
  trapModalFocus(event, panel);
}

function clampRightPanelWidth(width: number): number {
  return Math.min(MAX_RIGHT_PANEL_WIDTH_PX, Math.max(MIN_RIGHT_PANEL_WIDTH_PX, width));
}

function handleRightPanelKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  surfaces: CanvasWorkspaceSurfaces,
  panel: HTMLElement | null,
  fallbackFocus: HTMLElement | null,
): void {
  if (event.defaultPrevented) return;
  if (event.key === "Escape" && surfaces.rightPanelOpen) {
    event.preventDefault();
    surfaces.closeRightPanel(true, fallbackFocus);
    return;
  }
  if (event.key !== "Tab" || !surfaces.isNarrow || !surfaces.rightPanelOpen || !panel) return;
  trapModalFocus(event, panel);
}

function trapModalFocus(event: ReactKeyboardEvent<HTMLElement>, panel: HTMLElement): void {
  const focusable = listFocusable(panel);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function firstFocusable(container: HTMLElement | null): HTMLElement | null {
  return listFocusable(container)[0] ?? null;
}

function focusConnectedElement(
  preferred: HTMLElement | null,
  fallback: HTMLElement | null | undefined,
): void {
  (preferred?.isConnected ? preferred : fallback)?.focus();
}

function listFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return [
    ...container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => !element.closest("[inert]"));
}
