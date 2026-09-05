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

export type WorkspaceLeftSurface = "SOURCE" | "OUTLINE";

const COLLAPSED_LEFT_PANEL_WIDTH_PX = 12;
const DEFAULT_LEFT_PANEL_WIDTH_PX = 512;
const COLLAPSED_RIGHT_PANEL_WIDTH_PX = 12;
const DEFAULT_RIGHT_PANEL_WIDTH_PX = 512;
const MIN_TOOL_PANEL_WIDTH_PX = 360;
const MAX_TOOL_PANEL_WIDTH_PX = 768;
const TOOL_PANEL_KEYBOARD_STEP_PX = 16;

type WorkspacePanelSide = "LEFT" | "RIGHT";

interface WorkspacePanelResize {
  readonly side: WorkspacePanelSide;
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
}

export interface CanvasWorkspaceSurfaces {
  readonly activeLeftTab: WorkspaceLeftSurface;
  readonly leftPanelOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly isNarrow: boolean;
  readonly openLeft: (surface: WorkspaceLeftSurface, trigger?: HTMLElement | null) => void;
  readonly selectLeftTab: (surface: WorkspaceLeftSurface) => void;
  readonly toggleLeftPanel: (trigger: HTMLElement) => void;
  readonly closeLeft: (returnFocus?: boolean, fallback?: HTMLElement | null) => void;
  readonly openRightPanel: (trigger?: HTMLElement | null) => void;
  readonly toggleRightPanel: (trigger: HTMLElement) => void;
  readonly closeRightPanel: (returnFocus?: boolean, fallback?: HTMLElement | null) => void;
}

export function useCanvasWorkspaceSurfaces({
  initialLeftSurface = "SOURCE",
  initialLeftPanelOpen = false,
  initialRightPanelOpen = true,
  isNarrow,
}: {
  readonly initialLeftSurface?: WorkspaceLeftSurface;
  readonly initialLeftPanelOpen?: boolean;
  readonly initialRightPanelOpen?: boolean;
  readonly isNarrow?: boolean;
} = {}): CanvasWorkspaceSurfaces {
  const narrow = useNarrowWorkspace(isNarrow);
  const [activeLeftTab, setActiveLeftTab] = useState<WorkspaceLeftSurface>(initialLeftSurface);
  const [leftPanelOpen, setLeftPanelOpen] = useState(initialLeftPanelOpen);
  const [rightPanelOpen, setRightPanelOpen] = useState(initialRightPanelOpen && !narrow);
  const leftTriggerRef = useRef<HTMLElement | null>(null);
  const rightPanelTriggerRef = useRef<HTMLElement | null>(null);
  const lastOpenedRef = useRef<"LEFT" | "RIGHT">(
    initialLeftPanelOpen ? "LEFT" : initialRightPanelOpen && !narrow ? "RIGHT" : "LEFT",
  );

  const openLeft = useCallback(
    (surface: WorkspaceLeftSurface, trigger?: HTMLElement | null) => {
      leftTriggerRef.current = trigger ?? null;
      lastOpenedRef.current = "LEFT";
      setActiveLeftTab(surface);
      setLeftPanelOpen(true);
      if (narrow) setRightPanelOpen(false);
    },
    [narrow],
  );
  const closeLeft = useCallback((returnFocus = true, fallback?: HTMLElement | null) => {
    setLeftPanelOpen(false);
    if (returnFocus) focusConnectedElement(leftTriggerRef.current, fallback);
  }, []);
  const selectLeftTab = useCallback((surface: WorkspaceLeftSurface) => {
    setActiveLeftTab(surface);
  }, []);
  const toggleLeftPanel = useCallback(
    (trigger: HTMLElement) => {
      if (leftPanelOpen) {
        leftTriggerRef.current = trigger;
        closeLeft();
        return;
      }
      openLeft(activeLeftTab, trigger);
    },
    [activeLeftTab, closeLeft, leftPanelOpen, openLeft],
  );
  const openRightPanel = useCallback(
    (trigger?: HTMLElement | null) => {
      rightPanelTriggerRef.current = trigger ?? null;
      lastOpenedRef.current = "RIGHT";
      setRightPanelOpen(true);
      if (narrow) setLeftPanelOpen(false);
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
    if (!narrow || !leftPanelOpen || !rightPanelOpen) return;
    if (lastOpenedRef.current === "LEFT") setRightPanelOpen(false);
    else setLeftPanelOpen(false);
  }, [leftPanelOpen, narrow, rightPanelOpen]);

  return {
    activeLeftTab,
    leftPanelOpen,
    rightPanelOpen,
    isNarrow: narrow,
    openLeft,
    selectLeftTab,
    toggleLeftPanel,
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
  canvasOverlay,
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
  readonly canvasOverlay?: ReactNode;
  readonly status: ReactNode;
  readonly alerts?: ReactNode;
  readonly onViewportInsetsChange?: (insets: DiagramViewportInsets) => void;
}) {
  const { messages } = useUiLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const commandBarRef = useRef<HTMLDivElement>(null);
  const leftDockRef = useRef<HTMLElement>(null);
  const leftPanelToggleRef = useRef<HTMLButtonElement>(null);
  const sourceTabRef = useRef<HTMLButtonElement>(null);
  const outlineTabRef = useRef<HTMLButtonElement>(null);
  const rightDockRef = useRef<HTMLElement>(null);
  const rightPanelToggleRef = useRef<HTMLButtonElement>(null);
  const panelResizeRef = useRef<WorkspacePanelResize | null>(null);
  const [leftPanelWidth, setLeftPanelWidth] = useState(DEFAULT_LEFT_PANEL_WIDTH_PX);
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH_PX);
  const [resizingPanel, setResizingPanel] = useState<WorkspacePanelSide | null>(null);
  const setRightDockRef = useCallback((element: HTMLElement | null) => {
    rightDockRef.current = element;
  }, []);
  const setLeftDockRef = useCallback((element: HTMLElement | null) => {
    leftDockRef.current = element;
  }, []);
  const statusRef = useRef<HTMLDivElement>(null);
  const alertsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!resizingPanel) return;
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "ew-resize";
    document.documentElement.style.userSelect = "none";
    const handlePointerMove = (event: PointerEvent) => {
      const resize = panelResizeRef.current;
      if (!resize || event.pointerId !== resize.pointerId) return;
      const horizontalDelta = event.clientX - resize.startX;
      const nextWidth =
        resize.side === "LEFT"
          ? resize.startWidth + horizontalDelta
          : resize.startWidth - horizontalDelta;
      if (resize.side === "LEFT") setLeftPanelWidth(clampToolPanelWidth(nextWidth));
      else setRightPanelWidth(clampToolPanelWidth(nextWidth));
    };
    const finishResize = (event: PointerEvent) => {
      const resize = panelResizeRef.current;
      if (!resize || event.pointerId !== resize.pointerId) return;
      panelResizeRef.current = null;
      setResizingPanel(null);
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
  }, [resizingPanel]);

  useEffect(() => {
    if (!surfaces.isNarrow || !surfaces.leftPanelOpen) return;
    const animationFrame = window.requestAnimationFrame(() => {
      leftPanelToggleRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [surfaces.isNarrow, surfaces.leftPanelOpen]);

  useEffect(() => {
    if (!surfaces.isNarrow || !surfaces.rightPanelOpen) return;
    const animationFrame = window.requestAnimationFrame(() => {
      firstFocusable(rightDockRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [surfaces.isNarrow, surfaces.rightPanelOpen]);

  const sourceActive = surfaces.activeLeftTab === "SOURCE";
  const outlineActive = surfaces.activeLeftTab === "OUTLINE";
  const effectiveLeftPanelWidth = surfaces.leftPanelOpen
    ? leftPanelWidth
    : COLLAPSED_LEFT_PANEL_WIDTH_PX;
  const leftDockWidth = surfaces.leftPanelOpen
    ? surfaces.isNarrow
      ? "100%"
      : `${leftPanelWidth}px`
    : `${COLLAPSED_LEFT_PANEL_WIDTH_PX}px`;
  const reservedLeftWidth =
    (!surfaces.isNarrow && surfaces.leftPanelOpen
      ? leftPanelWidth
      : COLLAPSED_LEFT_PANEL_WIDTH_PX) + 12;
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
    leftPanelOpen: surfaces.leftPanelOpen,
    leftPanelWidth: effectiveLeftPanelWidth,
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
      {canvasOverlay ? (
        <div
          className="pointer-events-none absolute inset-0 z-30"
          data-testid="workspace-canvas-overlay"
        >
          {canvasOverlay}
        </div>
      ) : null}
      <div
        ref={commandBarRef}
        data-testid="workspace-command-bar"
        className={`pointer-events-none absolute top-3 z-30 flex justify-center ${
          resizingPanel ? "transition-none" : "transition-[left,right] duration-200"
        }`}
        style={{ left: reservedLeftWidth, right: reservedRightWidth }}
      >
        <div
          className="pointer-events-auto min-w-0 max-w-full break-words rounded-2xl border border-slate-700/90 bg-slate-950 shadow-2xl [overflow-wrap:anywhere]"
          data-testid="workspace-command-surface"
        >
          {commandBar}
        </div>
      </div>

      <LeftToolDock
        dockRef={setLeftDockRef}
        label={messages["workspace.leftToolsPanel"]}
        dialog={surfaces.isNarrow && surfaces.leftPanelOpen}
        panelState={surfaces.leftPanelOpen ? "open" : "collapsed"}
        onKeyDown={(event) =>
          handleLeftPanelKeyDown(event, surfaces, leftDockRef.current, leftPanelToggleRef.current)
        }
        className={`absolute inset-y-0 left-0 overflow-visible border-r border-slate-700/90 bg-slate-950 shadow-2xl ${resizingPanel === "LEFT" ? "transition-none" : "transition-[width] duration-200"} ${
          surfaces.isNarrow && surfaces.leftPanelOpen ? "z-50" : "z-40"
        }`}
        style={{ width: leftDockWidth }}
      >
        <button
          ref={leftPanelToggleRef}
          type="button"
          className={`absolute z-20 grid place-items-center rounded-full border border-slate-500 bg-slate-950 text-cyan-200 shadow-xl hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 ${
            surfaces.isNarrow && surfaces.leftPanelOpen
              ? "right-3 top-3 size-8"
              : "right-0 top-1/2 size-6 translate-x-1/2 -translate-y-1/2"
          }`}
          aria-label={
            surfaces.leftPanelOpen
              ? messages["workspace.collapseLeftTools"]
              : messages["workspace.openLeftTools"]
          }
          aria-expanded={surfaces.leftPanelOpen}
          aria-controls="workspace-left-panel-content"
          onClick={(event) => surfaces.toggleLeftPanel(event.currentTarget)}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-4 fill-none stroke-current"
            strokeWidth="2"
          >
            <path d={surfaces.leftPanelOpen ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} />
          </svg>
        </button>
        {surfaces.leftPanelOpen && !surfaces.isNarrow ? (
          <hr
            aria-label={messages["workspace.resizeLeftTools"]}
            aria-orientation="vertical"
            aria-controls="workspace-left-panel-content"
            aria-valuemin={MIN_TOOL_PANEL_WIDTH_PX}
            aria-valuemax={MAX_TOOL_PANEL_WIDTH_PX}
            aria-valuenow={leftPanelWidth}
            aria-valuetext={messages["workspace.toolsWidth"](leftPanelWidth)}
            tabIndex={0}
            className="absolute inset-y-0 right-0 z-10 h-full w-3 translate-x-1/2 cursor-ew-resize touch-none before:pointer-events-none before:absolute before:left-1/2 before:top-1/2 before:h-12 before:w-0.5 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-slate-600 before:content-[''] hover:bg-cyan-300/10 hover:before:bg-cyan-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 focus-visible:before:bg-cyan-300"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              panelResizeRef.current = {
                side: "LEFT",
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: leftPanelWidth,
              };
              setResizingPanel("LEFT");
            }}
            onKeyDown={(event) => {
              let nextWidth: number | null = null;
              if (event.key === "ArrowLeft") {
                nextWidth = leftPanelWidth - TOOL_PANEL_KEYBOARD_STEP_PX;
              } else if (event.key === "ArrowRight") {
                nextWidth = leftPanelWidth + TOOL_PANEL_KEYBOARD_STEP_PX;
              } else if (event.key === "Home") {
                nextWidth = MIN_TOOL_PANEL_WIDTH_PX;
              } else if (event.key === "End") {
                nextWidth = MAX_TOOL_PANEL_WIDTH_PX;
              }
              if (nextWidth === null) return;
              event.preventDefault();
              setLeftPanelWidth(clampToolPanelWidth(nextWidth));
            }}
          />
        ) : null}
        <div
          id="workspace-left-panel-content"
          aria-hidden={!surfaces.leftPanelOpen}
          inert={!surfaces.leftPanelOpen}
          className={`h-full w-full min-w-0 overflow-hidden ${
            surfaces.leftPanelOpen ? "visible" : "invisible"
          }`}
        >
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            <div
              className="grid shrink-0 grid-cols-2 border-b border-slate-700 bg-slate-950 px-4 pt-3"
              role="tablist"
              aria-label={messages["workspace.leftToolsPanel"]}
            >
              <LeftPanelTab
                buttonRef={sourceTabRef}
                label={messages["workspace.source"]}
                controls="workspace-source-surface"
                selected={sourceActive}
                onSelect={() => surfaces.selectLeftTab("SOURCE")}
                onKeyDown={(event) =>
                  handleLeftTabKeyDown(event, "SOURCE", surfaces, sourceTabRef, outlineTabRef)
                }
              />
              <LeftPanelTab
                buttonRef={outlineTabRef}
                label={messages["workspace.outline"]}
                controls="workspace-outline-surface"
                selected={outlineActive}
                onSelect={() => surfaces.selectLeftTab("OUTLINE")}
                onKeyDown={(event) =>
                  handleLeftTabKeyDown(event, "OUTLINE", surfaces, sourceTabRef, outlineTabRef)
                }
              />
            </div>
            <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
              <section
                id="workspace-source-surface"
                role="tabpanel"
                aria-labelledby="workspace-source-tab"
                aria-label={messages["source.surface"]}
                aria-hidden={!surfaces.leftPanelOpen || !sourceActive}
                inert={!surfaces.leftPanelOpen || !sourceActive}
                className={`absolute inset-0 min-w-0 overflow-auto p-4 ${sourceActive ? "visible" : "invisible"}`}
              >
                {source}
              </section>
              <section
                id="workspace-outline-surface"
                role="tabpanel"
                aria-labelledby="workspace-outline-tab"
                aria-label={messages["outline.label"]}
                aria-hidden={!surfaces.leftPanelOpen || !outlineActive}
                inert={!surfaces.leftPanelOpen || !outlineActive}
                className={`absolute inset-0 min-w-0 overflow-auto p-4 [overflow-wrap:anywhere] ${outlineActive ? "visible" : "invisible"}`}
              >
                {outline}
              </section>
            </div>
          </div>
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
        className={`absolute inset-y-0 right-0 z-40 overflow-visible border-l border-slate-700/90 bg-slate-950 shadow-2xl ${resizingPanel === "RIGHT" ? "transition-none" : "transition-[width] duration-200"}`}
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
            aria-valuemin={MIN_TOOL_PANEL_WIDTH_PX}
            aria-valuemax={MAX_TOOL_PANEL_WIDTH_PX}
            aria-valuenow={rightPanelWidth}
            aria-valuetext={messages["workspace.toolsWidth"](rightPanelWidth)}
            tabIndex={0}
            className="absolute inset-y-0 left-0 z-10 h-full w-3 -translate-x-1/2 cursor-ew-resize touch-none before:pointer-events-none before:absolute before:left-1/2 before:top-1/2 before:h-12 before:w-0.5 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-slate-600 before:content-[''] hover:bg-cyan-300/10 hover:before:bg-cyan-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 focus-visible:before:bg-cyan-300"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              panelResizeRef.current = {
                side: "RIGHT",
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: rightPanelWidth,
              };
              setResizingPanel("RIGHT");
            }}
            onKeyDown={(event) => {
              let nextWidth: number | null = null;
              if (event.key === "ArrowLeft") {
                nextWidth = rightPanelWidth + TOOL_PANEL_KEYBOARD_STEP_PX;
              } else if (event.key === "ArrowRight") {
                nextWidth = rightPanelWidth - TOOL_PANEL_KEYBOARD_STEP_PX;
              } else if (event.key === "Home") {
                nextWidth = MIN_TOOL_PANEL_WIDTH_PX;
              } else if (event.key === "End") {
                nextWidth = MAX_TOOL_PANEL_WIDTH_PX;
              }
              if (nextWidth === null) return;
              event.preventDefault();
              setRightPanelWidth(clampToolPanelWidth(nextWidth));
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
          <div className="flex h-full min-h-0 min-w-0 flex-col break-words [overflow-wrap:anywhere]">
            <section
              className="flex min-w-0 max-h-[50%] min-h-0 shrink-0 flex-col overflow-y-auto border-b border-slate-700"
              aria-label={messages["diagram.editable"]}
              data-testid="workspace-diagram-tools"
            >
              {diagramTools}
            </section>
            <div
              className="min-h-0 min-w-0 flex-1 overflow-y-auto"
              data-testid="workspace-inspector-scroll"
            >
              {inspector}
            </div>
          </div>
        </div>
      </RightToolDock>

      <div
        className={`pointer-events-none absolute bottom-3 z-30 flex flex-col items-center gap-3 ${
          resizingPanel ? "transition-none" : "transition-[left,right] duration-200"
        }`}
        style={{ left: reservedLeftWidth, right: reservedRightWidth }}
      >
        {alerts ? (
          <div ref={alertsRef} className="flex w-full min-w-0 justify-center">
            <div
              className="pointer-events-auto min-w-0 max-w-2xl break-words [overflow-wrap:anywhere]"
              data-testid="workspace-alert-surface"
            >
              {alerts}
            </div>
          </div>
        ) : null}
        <div
          ref={statusRef}
          data-testid="workspace-status-region"
          className="flex w-full min-w-0 justify-center"
        >
          <div
            className="pointer-events-auto min-w-0 max-w-full break-words rounded-xl border border-slate-700/90 bg-slate-950 shadow-xl [overflow-wrap:anywhere]"
            data-testid="workspace-status-surface"
          >
            {status}
          </div>
        </div>
      </div>
    </div>
  );
}

function LeftPanelTab({
  buttonRef,
  label,
  controls,
  selected,
  onSelect,
  onKeyDown,
}: {
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly label: string;
  readonly controls: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      ref={buttonRef}
      id={
        controls === "workspace-source-surface" ? "workspace-source-tab" : "workspace-outline-tab"
      }
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={controls}
      tabIndex={selected ? 0 : -1}
      className={`min-w-0 whitespace-normal border-b-2 px-3 py-3 text-sm font-semibold [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 ${
        selected
          ? "border-cyan-300 text-cyan-100"
          : "border-transparent text-slate-300 hover:border-slate-500 hover:text-white"
      }`}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      {label}
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
  if (event.defaultPrevented || !surfaces.leftPanelOpen) return;
  if (event.key === "Escape") {
    event.preventDefault();
    surfaces.closeLeft(true, fallbackFocus);
    return;
  }
  if (event.key !== "Tab" || !surfaces.isNarrow || !panel) return;
  trapModalFocus(event, panel);
}

function handleLeftTabKeyDown(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  current: WorkspaceLeftSurface,
  surfaces: CanvasWorkspaceSurfaces,
  sourceTabRef: RefObject<HTMLButtonElement | null>,
  outlineTabRef: RefObject<HTMLButtonElement | null>,
): void {
  let next: WorkspaceLeftSurface | null = null;
  if (event.key === "Home") next = "SOURCE";
  else if (event.key === "End") next = "OUTLINE";
  else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    next = current === "SOURCE" ? "OUTLINE" : "SOURCE";
  }
  if (!next) return;
  event.preventDefault();
  surfaces.selectLeftTab(next);
  (next === "SOURCE" ? sourceTabRef.current : outlineTabRef.current)?.focus();
}

function clampToolPanelWidth(width: number): number {
  return Math.min(MAX_TOOL_PANEL_WIDTH_PX, Math.max(MIN_TOOL_PANEL_WIDTH_PX, width));
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
  const preferredIsFocusable = preferred?.isConnected && !preferred.closest("[inert]");
  (preferredIsFocusable ? preferred : fallback)?.focus();
}

function listFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return [
    ...container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => !element.closest("[inert]"));
}
