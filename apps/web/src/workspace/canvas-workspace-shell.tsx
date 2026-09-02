import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { DiagramViewportInsets } from "../diagram/base-schema-diagram-contract.js";
import { useUiLocale } from "../localization/ui-locale.js";

export type WorkspaceLeftSurface = "SOURCE" | "OUTLINE" | null;

export interface CanvasWorkspaceSurfaces {
  readonly leftSurface: WorkspaceLeftSurface;
  readonly rightPanelOpen: boolean;
  readonly isNarrow: boolean;
  readonly openLeft: (
    surface: Exclude<WorkspaceLeftSurface, null>,
    trigger?: HTMLElement | null,
  ) => void;
  readonly toggleLeft: (surface: Exclude<WorkspaceLeftSurface, null>, trigger: HTMLElement) => void;
  readonly closeLeft: (returnFocus?: boolean) => void;
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
      if (trigger) leftTriggerRef.current = trigger;
      lastOpenedRef.current = "LEFT";
      setLeftSurface(surface);
      if (narrow) setRightPanelOpen(false);
    },
    [narrow],
  );
  const closeLeft = useCallback((returnFocus = true) => {
    setLeftSurface(null);
    if (returnFocus) leftTriggerRef.current?.focus();
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
      if (trigger) rightPanelTriggerRef.current = trigger;
      lastOpenedRef.current = "RIGHT";
      setRightPanelOpen(true);
      if (narrow) setLeftSurface(null);
    },
    [narrow],
  );
  const closeRightPanel = useCallback((returnFocus = true, fallback?: HTMLElement | null) => {
    setRightPanelOpen(false);
    if (returnFocus) (rightPanelTriggerRef.current ?? fallback)?.focus();
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
  rightRailSummary,
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
  readonly rightRailSummary: ReactNode;
  readonly status: ReactNode;
  readonly alerts?: ReactNode;
  readonly onViewportInsetsChange?: (insets: DiagramViewportInsets) => void;
}) {
  const { messages } = useUiLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const commandBarRef = useRef<HTMLDivElement>(null);
  const leftDockRef = useRef<HTMLDivElement>(null);
  const rightDockRef = useRef<HTMLElement>(null);
  const rightRailButtonRef = useRef<HTMLButtonElement>(null);
  const setRightDockRef = useCallback((element: HTMLElement | null) => {
    rightDockRef.current = element;
  }, []);
  const statusRef = useRef<HTMLDivElement>(null);
  const alertsRef = useRef<HTMLDivElement>(null);
  useWorkspaceInsets({
    rootRef,
    commandBarRef,
    leftDockRef,
    rightDockRef,
    statusRef,
    alertsRef,
    leftOpen: surfaces.leftSurface !== null,
    rightPanelOpen: surfaces.rightPanelOpen,
    ...(onViewportInsetsChange ? { onChange: onViewportInsetsChange } : {}),
  });

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

  return (
    <div
      ref={rootRef}
      className="relative isolate h-full min-h-0 w-full overflow-hidden bg-slate-950"
      data-testid="canvas-workspace-shell"
    >
      <div className="absolute inset-0 z-0">{diagram}</div>
      <div
        ref={commandBarRef}
        className={`pointer-events-none absolute left-3 top-3 z-30 flex justify-center transition-[right] duration-200 sm:left-5 ${
          !surfaces.isNarrow && surfaces.rightPanelOpen ? "right-[32.75rem]" : "right-[4.25rem]"
        }`}
      >
        <div className="pointer-events-auto max-w-full rounded-2xl border border-slate-700/90 bg-slate-950/90 shadow-2xl backdrop-blur-md">
          {commandBar}
        </div>
      </div>

      <div
        ref={leftDockRef}
        className={`absolute bottom-16 left-3 top-24 z-20 w-[min(48rem,calc(100vw-1.5rem))] transition duration-200 sm:left-5 sm:w-[min(48rem,calc(100vw-2.5rem))] ${
          leftOpen
            ? "translate-x-0 opacity-100"
            : "pointer-events-none -translate-x-[110%] opacity-0"
        }`}
      >
        <section
          id="workspace-source-surface"
          aria-label={messages["source.surface"]}
          aria-hidden={!sourceOpen}
          inert={!sourceOpen}
          onKeyDown={(event) => {
            if (event.key === "Escape") surfaces.closeLeft();
          }}
          className={`absolute inset-0 overflow-auto rounded-2xl border border-slate-700/90 bg-slate-950/90 p-4 shadow-2xl backdrop-blur-md ${
            sourceOpen ? "visible" : "invisible"
          }`}
        >
          {source}
        </section>
        <section
          id="workspace-outline-surface"
          aria-label={messages["outline.label"]}
          aria-hidden={!outlineOpen}
          inert={!outlineOpen}
          onKeyDown={(event) => {
            if (event.key === "Escape") surfaces.closeLeft();
          }}
          className={`absolute inset-0 overflow-auto rounded-2xl border border-slate-700/90 bg-slate-950/90 p-4 shadow-2xl backdrop-blur-md ${
            outlineOpen ? "visible" : "invisible"
          }`}
        >
          {outline}
        </section>
      </div>

      <RightToolDock
        dockRef={setRightDockRef}
        label={messages["workspace.toolsPanel"]}
        dialog={surfaces.isNarrow && surfaces.rightPanelOpen}
        panelState={surfaces.rightPanelOpen ? "open" : "collapsed"}
        onKeyDown={(event) =>
          handleRightPanelKeyDown(event, surfaces, rightDockRef.current, rightRailButtonRef.current)
        }
        className={`absolute inset-y-0 right-0 z-40 flex flex-row-reverse overflow-hidden border-l border-slate-700/90 bg-slate-950/90 shadow-2xl backdrop-blur-md transition-[width] duration-200 ${
          surfaces.rightPanelOpen ? (surfaces.isNarrow ? "w-full" : "w-[min(32rem,100vw)]") : "w-14"
        }`}
      >
        <div className="flex w-14 shrink-0 flex-col items-center gap-3 border-l border-slate-700/80 bg-slate-950 px-2 py-3">
          <button
            ref={rightRailButtonRef}
            type="button"
            className="grid size-10 place-items-center rounded-xl border border-slate-600 bg-slate-900 text-cyan-200 shadow-lg hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
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
              className="size-5 fill-none stroke-current"
              strokeWidth="2"
            >
              <path d={surfaces.rightPanelOpen ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} />
            </svg>
          </button>
          <div className="min-h-0 flex-1 overflow-hidden text-xs text-slate-300">
            {rightRailSummary}
          </div>
        </div>
        <div
          id="workspace-right-panel-content"
          aria-hidden={!surfaces.rightPanelOpen}
          inert={!surfaces.rightPanelOpen}
          className={`min-w-0 flex-1 ${surfaces.rightPanelOpen ? "visible" : "invisible"}`}
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
          className={`pointer-events-none absolute bottom-16 left-3 z-30 flex justify-center transition-[right] sm:left-5 ${
            !surfaces.isNarrow && surfaces.rightPanelOpen ? "right-[32.75rem]" : "right-[4.25rem]"
          }`}
        >
          <div className="pointer-events-auto max-w-2xl">{alerts}</div>
        </div>
      ) : null}
      <div
        ref={statusRef}
        className={`pointer-events-none absolute bottom-3 left-3 z-30 flex justify-center transition-[right] sm:left-5 ${
          !surfaces.isNarrow && surfaces.rightPanelOpen ? "right-[32.75rem]" : "right-[4.25rem]"
        }`}
      >
        <div className="pointer-events-auto max-w-full rounded-xl border border-slate-700/90 bg-slate-950/90 shadow-xl backdrop-blur-md">
          {status}
        </div>
      </div>
    </div>
  );
}

function RightToolDock({
  dockRef,
  label,
  dialog,
  panelState,
  className,
  onKeyDown,
  children,
}: {
  readonly dockRef: (element: HTMLElement | null) => void;
  readonly label: string;
  readonly dialog: boolean;
  readonly panelState: "open" | "collapsed";
  readonly className: string;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly children: ReactNode;
}) {
  const eventBoundary = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation(),
    onWheel: (event: ReactWheelEvent<HTMLElement>) => event.stopPropagation(),
  };
  if (dialog) {
    return (
      <div
        ref={dockRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid="workspace-right-tool-dock"
        data-panel-state={panelState}
        className={className}
        onKeyDown={onKeyDown}
        {...eventBoundary}
      >
        {children}
      </div>
    );
  }
  return (
    <aside
      ref={dockRef}
      aria-label={label}
      data-testid="workspace-right-tool-dock"
      data-panel-state={panelState}
      className={className}
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
  leftOpen,
  rightPanelOpen,
  onChange,
}: {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly commandBarRef: RefObject<HTMLDivElement | null>;
  readonly leftDockRef: RefObject<HTMLDivElement | null>;
  readonly rightDockRef: RefObject<HTMLElement | null>;
  readonly statusRef: RefObject<HTMLDivElement | null>;
  readonly alertsRef: RefObject<HTMLDivElement | null>;
  readonly leftOpen: boolean;
  readonly rightPanelOpen: boolean;
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
      const rightDock = rightDockRef.current;
      const expectedPanelState = rightPanelOpen ? "open" : "collapsed";
      const next = {
        top: withSafeGap(relativeBottom(commandBarRef.current)),
        right: withSafeGap(
          rightInset(rightDock?.dataset.panelState === expectedPanelState ? rightDock : null),
        ),
        bottom: withSafeGap(
          Math.max(
            0,
            root.bottom - (statusRef.current?.getBoundingClientRect().top ?? root.bottom),
            root.bottom - (alertsRef.current?.getBoundingClientRect().top ?? root.bottom),
          ),
        ),
        left: leftOpen ? withSafeGap(leftInset(leftDockRef.current)) : 0,
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
    leftOpen,
    rightPanelOpen,
    onChange,
    rootRef,
    statusRef,
  ]);
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

function listFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return [
    ...container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => !element.closest("[inert]"));
}
