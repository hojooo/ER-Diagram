// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CanvasWorkspaceShell,
  useCanvasWorkspaceSurfaces,
} from "../src/workspace/canvas-workspace-shell.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("canvas workspace shell", () => {
  it("starts with every surface closed and keeps the diagram mounted while toggling docks", () => {
    const diagramMounts = vi.fn();
    render(<Harness diagramMounts={diagramMounts} />);

    expect(screen.getByTestId("canvas-workspace-shell")).toBeVisible();
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Outline" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Inspector" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(document.getElementById("workspace-source-surface")).toHaveAttribute("inert");
    expect(document.getElementById("workspace-source-surface")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(document.getElementById("workspace-outline-surface")).toHaveAttribute("inert");
    expect(document.getElementById("workspace-inspector-surface")).toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "DBML source" })).not.toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Outline" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(diagramMounts).toHaveBeenCalledTimes(1);
  });

  it("closes a focused surface with Escape and returns focus to its trigger", () => {
    render(<Harness />);
    const sourceTrigger = screen.getByRole("button", { name: "Source" });
    fireEvent.click(sourceTrigger);
    const source = screen.getByRole("region", { name: "DBML source" });

    fireEvent.keyDown(source, { key: "Escape" });

    expect(sourceTrigger).toHaveFocus();
    expect(sourceTrigger).toHaveAttribute("aria-expanded", "false");
    expect(source).toHaveAttribute("inert");
  });

  it("allows both side docks on desktop and only the latest dock on narrow screens", () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspector" }));
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Inspector" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    rerender(<Harness narrow />);
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspector" }));
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Inspector" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("preserves source and inspector drafts while their mounted surfaces are off canvas", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    fireEvent.change(screen.getByLabelText("Source draft probe"), {
      target: { value: "Table users" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Source" }));

    fireEvent.click(screen.getByRole("button", { name: "Inspector" }));
    fireEvent.change(screen.getByLabelText("Inspector draft probe"), {
      target: { value: "renamed_users" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inspector" }));

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByLabelText("Source draft probe")).toHaveValue("Table users");
    fireEvent.click(screen.getByRole("button", { name: "Inspector" }));
    expect(screen.getByLabelText("Inspector draft probe")).toHaveValue("renamed_users");
  });

  it("opens source as the explicit recovery exception", () => {
    render(<Harness initialSourceOpen />);

    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "DBML source" })).not.toHaveAttribute("inert");
  });

  it("includes the diagram control overlay in the visible safe-area inset", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      if (this instanceof HTMLElement && this.dataset.testid === "canvas-workspace-shell") {
        return testRect(0, 720, 1_280);
      }
      if (this instanceof HTMLElement && this.dataset.testid === "diagram-controls") {
        return testRect(96, 310, 800);
      }
      if (this instanceof HTMLElement && this.classList.contains("top-3")) {
        return testRect(12, 70, 1_120);
      }
      if (this instanceof HTMLElement && this.classList.contains("bottom-3")) {
        return testRect(660, 708, 460);
      }
      return testRect(0, 0, 0);
    });

    render(<Harness />);

    expect(await screen.findByText(/"top":322/)).toBeVisible();
    expect(screen.getByText(/"bottom":72/)).toBeVisible();
  });
});

function Harness({
  narrow = false,
  initialSourceOpen = false,
  diagramMounts = vi.fn(),
}: {
  readonly narrow?: boolean;
  readonly initialSourceOpen?: boolean;
  readonly diagramMounts?: () => void;
}) {
  const surfaces = useCanvasWorkspaceSurfaces({
    initialLeftSurface: initialSourceOpen ? "SOURCE" : null,
    isNarrow: narrow,
  });
  const [diagramControlsElement, setDiagramControlsElement] = useState<HTMLDivElement | null>(null);
  const [insets, setInsets] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  return (
    <CanvasWorkspaceShell
      surfaces={surfaces}
      diagramControlsElement={diagramControlsElement}
      commandBar={
        <div>
          <button
            type="button"
            aria-expanded={surfaces.leftSurface === "SOURCE"}
            aria-controls="workspace-source-surface"
            onClick={(event) => surfaces.toggleLeft("SOURCE", event.currentTarget)}
          >
            Source
          </button>
          <button
            type="button"
            aria-expanded={surfaces.leftSurface === "OUTLINE"}
            aria-controls="workspace-outline-surface"
            onClick={(event) => surfaces.toggleLeft("OUTLINE", event.currentTarget)}
          >
            Outline
          </button>
          <button
            type="button"
            aria-expanded={surfaces.inspectorOpen}
            aria-controls="workspace-inspector-surface"
            onClick={(event) => surfaces.toggleInspector(event.currentTarget)}
          >
            Inspector
          </button>
        </div>
      }
      diagram={
        <>
          <div ref={setDiagramControlsElement} data-testid="diagram-controls" />
          <MountedDiagram onMount={diagramMounts} />
        </>
      }
      source={<input aria-label="Source draft probe" defaultValue="" />}
      outline={<p>Outline content</p>}
      inspector={<input aria-label="Inspector draft probe" defaultValue="" />}
      status={<output>Insets {JSON.stringify(insets)}</output>}
      onViewportInsetsChange={setInsets}
    />
  );
}

function testRect(top: number, bottom: number, width: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: width,
    bottom,
    left: 0,
    width,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

function MountedDiagram({ onMount }: { readonly onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <div role="application">Persistent diagram</div>;
}
