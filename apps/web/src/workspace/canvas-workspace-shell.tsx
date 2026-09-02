import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { DiagramViewportInsets } from "../diagram/base-schema-diagram-contract.js";

export type WorkspaceLeftSurface = "SOURCE" | "OUTLINE" | null;

export interface CanvasWorkspaceSurfaces {
  readonly leftSurface: WorkspaceLeftSurface;
  readonly inspectorOpen: boolean;
  readonly openLeft: (
    surface: Exclude<WorkspaceLeftSurface, null>,
    trigger?: HTMLElement | null,
  ) => void;
  readonly toggleLeft: (surface: Exclude<WorkspaceLeftSurface, null>, trigger: HTMLElement) => void;
  readonly closeLeft: (returnFocus?: boolean) => void;
  readonly openInspector: (trigger?: HTMLElement | null) => void;
  readonly toggleInspector: (trigger: HTMLElement) => void;
  readonly closeInspector: (returnFocus?: boolean) => void;
}

export function useCanvasWorkspaceSurfaces({
  initialLeftSurface = null,
  initialInspectorOpen = false,
  isNarrow,
}: {
  readonly initialLeftSurface?: WorkspaceLeftSurface;
  readonly initialInspectorOpen?: boolean;
  readonly isNarrow?: boolean;
} = {}): CanvasWorkspaceSurfaces {
  const narrow = useNarrowWorkspace(isNarrow);
  const [leftSurface, setLeftSurface] = useState<WorkspaceLeftSurface>(initialLeftSurface);
  const [inspectorOpen, setInspectorOpen] = useState(initialInspectorOpen);
  const leftTriggerRef = useRef<HTMLElement | null>(null);
  const inspectorTriggerRef = useRef<HTMLElement | null>(null);
  const lastOpenedRef = useRef<"LEFT" | "INSPECTOR">(initialInspectorOpen ? "INSPECTOR" : "LEFT");

  const openLeft = useCallback(
    (surface: Exclude<WorkspaceLeftSurface, null>, trigger?: HTMLElement | null) => {
      if (trigger) leftTriggerRef.current = trigger;
      lastOpenedRef.current = "LEFT";
      setLeftSurface(surface);
      if (narrow) setInspectorOpen(false);
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
  const openInspector = useCallback(
    (trigger?: HTMLElement | null) => {
      if (trigger) inspectorTriggerRef.current = trigger;
      lastOpenedRef.current = "INSPECTOR";
      setInspectorOpen(true);
      if (narrow) setLeftSurface(null);
    },
    [narrow],
  );
  const closeInspector = useCallback((returnFocus = true) => {
    setInspectorOpen(false);
    if (returnFocus) inspectorTriggerRef.current?.focus();
  }, []);
  const toggleInspector = useCallback(
    (trigger: HTMLElement) => {
      if (inspectorOpen) {
        closeInspector();
        return;
      }
      openInspector(trigger);
    },
    [closeInspector, inspectorOpen, openInspector],
  );

  useEffect(() => {
    if (!narrow || leftSurface === null || !inspectorOpen) return;
    if (lastOpenedRef.current === "LEFT") setInspectorOpen(false);
    else setLeftSurface(null);
  }, [inspectorOpen, leftSurface, narrow]);

  return {
    leftSurface,
    inspectorOpen,
    openLeft,
    toggleLeft,
    closeLeft,
    openInspector,
    toggleInspector,
    closeInspector,
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
  source,
  outline,
  inspector,
  status,
  alerts,
  diagramControlsElement,
  onViewportInsetsChange,
}: {
  readonly surfaces: CanvasWorkspaceSurfaces;
  readonly commandBar: ReactNode;
  readonly diagram: ReactNode;
  readonly source: ReactNode;
  readonly outline: ReactNode;
  readonly inspector: ReactNode;
  readonly status: ReactNode;
  readonly alerts?: ReactNode;
  readonly diagramControlsElement?: HTMLElement | null;
  readonly onViewportInsetsChange?: (insets: DiagramViewportInsets) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const commandBarRef = useRef<HTMLDivElement>(null);
  const leftDockRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const alertsRef = useRef<HTMLDivElement>(null);
  useWorkspaceInsets({
    rootRef,
    commandBarRef,
    leftDockRef,
    inspectorRef,
    statusRef,
    alertsRef,
    ...(diagramControlsElement ? { diagramControlsElement } : {}),
    leftOpen: surfaces.leftSurface !== null,
    inspectorOpen: surfaces.inspectorOpen,
    ...(onViewportInsetsChange ? { onChange: onViewportInsetsChange } : {}),
  });

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
        className="pointer-events-none absolute inset-x-3 top-3 z-30 flex justify-center sm:inset-x-5"
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
          aria-label="DBML source"
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
          aria-label="Schema outline"
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

      <aside
        ref={inspectorRef}
        id="workspace-inspector-surface"
        aria-label="Visual schema inspector"
        aria-hidden={!surfaces.inspectorOpen}
        inert={!surfaces.inspectorOpen}
        onKeyDown={(event) => {
          if (event.key === "Escape") surfaces.closeInspector();
        }}
        className={`absolute bottom-16 right-3 top-24 z-20 w-[min(30rem,calc(100vw-1.5rem))] overflow-auto rounded-2xl border border-slate-700/90 bg-slate-950/90 p-4 shadow-2xl backdrop-blur-md transition duration-200 sm:right-5 sm:w-[min(30rem,calc(100vw-2.5rem))] ${
          surfaces.inspectorOpen
            ? "translate-x-0 opacity-100"
            : "pointer-events-none translate-x-[110%] opacity-0"
        }`}
      >
        {inspector}
      </aside>

      {alerts ? (
        <div
          ref={alertsRef}
          className="pointer-events-none absolute inset-x-3 bottom-16 z-40 flex justify-center sm:inset-x-5"
        >
          <div className="pointer-events-auto max-w-2xl">{alerts}</div>
        </div>
      ) : null}
      <div
        ref={statusRef}
        className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center sm:inset-x-5"
      >
        <div className="pointer-events-auto max-w-full rounded-xl border border-slate-700/90 bg-slate-950/90 shadow-xl backdrop-blur-md">
          {status}
        </div>
      </div>
    </div>
  );
}

function useWorkspaceInsets({
  rootRef,
  commandBarRef,
  leftDockRef,
  inspectorRef,
  statusRef,
  alertsRef,
  diagramControlsElement,
  leftOpen,
  inspectorOpen,
  onChange,
}: {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly commandBarRef: RefObject<HTMLDivElement | null>;
  readonly leftDockRef: RefObject<HTMLDivElement | null>;
  readonly inspectorRef: RefObject<HTMLElement | null>;
  readonly statusRef: RefObject<HTMLDivElement | null>;
  readonly alertsRef: RefObject<HTMLDivElement | null>;
  readonly diagramControlsElement?: HTMLElement | null;
  readonly leftOpen: boolean;
  readonly inspectorOpen: boolean;
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
      const next = {
        top: withSafeGap(
          Math.max(
            relativeBottom(commandBarRef.current),
            relativeBottom(diagramControlsElement ?? null),
          ),
        ),
        right: inspectorOpen ? withSafeGap(rightInset(inspectorRef.current)) : 0,
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
      diagramControlsElement,
      alertsRef.current,
      leftDockRef.current,
      inspectorRef.current,
      statusRef.current,
    ]) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [
    commandBarRef,
    diagramControlsElement,
    alertsRef,
    inspectorOpen,
    inspectorRef,
    leftDockRef,
    leftOpen,
    onChange,
    rootRef,
    statusRef,
  ]);
}
