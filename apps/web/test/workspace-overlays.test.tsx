// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoSchemaGraph } from "../src/diagram/demo-schema.js";
import { DiagramWorkspaceControls } from "../src/diagram/diagram-workspace-controls.js";
import { createDiagramVisibility, GLOBAL_VIEW_KEY } from "../src/diagram/projection.js";
import {
  CanvasWorkspaceShell,
  useCanvasWorkspaceSurfaces,
} from "../src/workspace/canvas-workspace-shell.js";

afterEach(cleanup);

describe("workspace overlay system", () => {
  it("keeps sidebar search results in panel flow under long view names", () => {
    const template = demoSchemaGraph.views[0];
    if (!template) throw new Error("Expected a demo DiagramView fixture.");
    const longView = {
      ...template,
      key: 'view:[null,"아주 긴 다이어그램 뷰 이름 that stays inside the tool panel"]',
      schemaName: null,
      name: "아주 긴 다이어그램 뷰 이름 that stays inside the tool panel",
    };
    const graph = { ...demoSchemaGraph, views: [...demoSchemaGraph.views, longView] };

    render(
      <DiagramWorkspaceControls
        layout="SIDEBAR"
        graph={graph}
        visibility={createDiagramVisibility(graph, GLOBAL_VIEW_KEY)}
        viewKey={longView.key}
        detailLevel="FULL"
        searchQuery="user"
        onSearchQueryChange={vi.fn()}
        onActivateSearchResult={vi.fn()}
        onViewChange={vi.fn()}
        onDetailLevelChange={vi.fn()}
      />,
    );

    const controls = screen.getByTestId("diagram-workspace-controls");
    expect(controls).toHaveAttribute("data-layout", "sidebar");
    expect(controls).toHaveClass("grid-cols-2");
    expect(screen.getByRole("combobox", { name: "Diagram view" })).toHaveClass("truncate");

    fireEvent.focus(screen.getByRole("combobox", { name: "Search current view" }));
    const results = screen.getByRole("listbox", { name: "Current view search results" });
    expect(results).toHaveClass("relative");
    expect(results).not.toHaveClass("absolute");
  });

  it("contains dock pointer and wheel events instead of forwarding them to the canvas", () => {
    const onWheel = vi.fn();
    const onPointerDown = vi.fn();

    render(
      <div onWheel={onWheel} onPointerDown={onPointerDown}>
        <OverlayHarness />
      </div>,
    );

    for (const dock of [
      screen.getByTestId("workspace-left-tool-dock"),
      screen.getByTestId("workspace-right-tool-dock"),
    ]) {
      fireEvent.wheel(dock);
      fireEvent.pointerDown(dock);
    }

    expect(onWheel).not.toHaveBeenCalled();
    expect(onPointerDown).not.toHaveBeenCalled();
  });
});

function OverlayHarness() {
  const surfaces = useCanvasWorkspaceSurfaces({ initialRightPanelOpen: true, isNarrow: false });
  return (
    <CanvasWorkspaceShell
      surfaces={surfaces}
      commandBar={<p>Command bar</p>}
      diagram={<p>Diagram</p>}
      diagramTools={<p>Diagram tools</p>}
      source={<p>Source</p>}
      outline={<p>Outline</p>}
      inspector={<p>Inspector</p>}
      status={<p>Status</p>}
    />
  );
}
