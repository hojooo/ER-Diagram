// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  it("opens the integrated right tool panel by default on wide valid workspaces", () => {
    const diagramMounts = vi.fn();
    render(<Harness diagramMounts={diagramMounts} />);

    expect(screen.getByTestId("canvas-workspace-shell")).toBeVisible();
    const commandBar = screen.getByTestId("workspace-command-bar");
    expect(within(commandBar).queryByRole("button", { name: "Source" })).toBeNull();
    expect(within(commandBar).queryByRole("button", { name: "Outline" })).toBeNull();
    expect(within(commandBar).queryByRole("button", { name: "Tools" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open source and outline" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Collapse workspace tools" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const leftTools = screen.getByRole("complementary", { name: "Source and outline" });
    expect(leftTools).toHaveClass("inset-y-0", "left-0");
    expect(leftTools).toHaveStyle({ width: "12px" });
    expect(screen.queryByTestId("workspace-left-tool-rail")).toBeNull();
    expect(document.getElementById("workspace-source-surface")).toHaveAttribute("inert");
    expect(document.getElementById("workspace-source-surface")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(document.getElementById("workspace-outline-surface")).toHaveAttribute("inert");
    expect(document.getElementById("workspace-right-panel-content")).not.toHaveAttribute("inert");
    const tools = screen.getByRole("complementary", { name: "Workspace tools" });
    expect(tools).toHaveClass("inset-y-0", "right-0");
    expect(tools).toHaveStyle({ width: "512px" });
    expect(within(tools).getByText("Editable ER diagram")).toBeVisible();
    expect(within(tools).getByText("Inspector content")).toBeVisible();
    expect(screen.queryByTestId("workspace-rail-selection")).toBeNull();
    expect(screen.getByTestId("workspace-diagram-tools")).toHaveClass(
      "max-h-[50%]",
      "overflow-y-auto",
    );
    expect(screen.getByTestId("workspace-inspector-scroll")).toHaveClass(
      "flex-1",
      "overflow-y-auto",
    );

    fireEvent.click(screen.getByRole("button", { name: "Open source and outline" }));
    expect(screen.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");
    expect(leftTools).toHaveStyle({ width: "512px" });
    expect(screen.getByRole("tabpanel", { name: "Source" })).not.toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("tab", { name: "Outline" }));
    expect(screen.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Outline" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Collapse source and outline" }));
    expect(leftTools).toHaveStyle({ width: "12px" });
    fireEvent.click(screen.getByRole("button", { name: "Open source and outline" }));
    expect(screen.getByRole("tab", { name: "Outline" })).toHaveAttribute("aria-selected", "true");
    expect(diagramMounts).toHaveBeenCalledTimes(1);
  });

  it("closes a focused surface with Escape and returns focus to its trigger", () => {
    render(<Harness />);
    const sourceTrigger = screen.getByRole("button", { name: "Open source and outline" });
    fireEvent.click(sourceTrigger);
    const source = screen.getByRole("tabpanel", { name: "Source" });

    fireEvent.keyDown(source, { key: "Escape" });

    expect(sourceTrigger).toHaveFocus();
    expect(sourceTrigger).toHaveAttribute("aria-expanded", "false");
    expect(source).toHaveAttribute("inert");
  });

  it("allows both side docks on desktop and only the latest surface on narrow screens", () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open source and outline" }));
    expect(screen.getByRole("button", { name: "Collapse source and outline" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Collapse workspace tools" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    unmount();
    render(<Harness narrow />);
    expect(screen.getByRole("button", { name: "Open workspace tools" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open source and outline" }));
    expect(screen.getByRole("dialog", { name: "Source and outline" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open workspace tools" }));
    expect(screen.getByRole("button", { name: "Open source and outline" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Collapse workspace tools" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("dialog", { name: "Workspace tools" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(screen.queryByRole("separator", { name: "Resize workspace tools" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize source and outline" })).toBeNull();
  });

  it("preserves source and inspector drafts while their mounted surfaces are off canvas", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Open source and outline" }));
    fireEvent.change(screen.getByLabelText("Source draft probe"), {
      target: { value: "Table users" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Collapse source and outline" }));

    fireEvent.change(screen.getByLabelText("Inspector draft probe"), {
      target: { value: "renamed_users" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace tools" }));

    fireEvent.click(screen.getByRole("button", { name: "Open source and outline" }));
    expect(screen.getByLabelText("Source draft probe")).toHaveValue("Table users");
    fireEvent.click(screen.getByRole("button", { name: "Open workspace tools" }));
    expect(screen.getByLabelText("Inspector draft probe")).toHaveValue("renamed_users");
  });

  it("keeps only the compact toggle visible when the panel is collapsed", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace tools" }));
    expect(screen.getByTestId("workspace-right-tool-dock")).toHaveAttribute(
      "data-panel-state",
      "collapsed",
    );
    expect(screen.getByTestId("workspace-right-tool-dock")).toHaveStyle({ width: "12px" });
    expect(document.getElementById("workspace-right-panel-content")).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Open workspace tools" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByTestId("workspace-rail-selection")).toBeNull();
  });

  it("places the left panel toggle on its centered outer edge", () => {
    render(<Harness />);

    const dock = screen.getByTestId("workspace-left-tool-dock");
    const toggle = screen.getByRole("button", { name: "Open source and outline" });

    expect(dock).toHaveStyle({ width: "12px" });
    expect(toggle).toHaveClass("absolute", "right-0", "top-1/2", "size-6");
    fireEvent.click(toggle);
    expect(dock).toHaveStyle({ width: "512px" });
    expect(screen.getByRole("tablist", { name: "Source and outline" })).toBeVisible();
  });

  it("supports roving keyboard navigation between the internal source and outline tabs", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open source and outline" }));
    const sourceTab = screen.getByRole("tab", { name: "Source" });
    const outlineTab = screen.getByRole("tab", { name: "Outline" });

    sourceTab.focus();
    fireEvent.keyDown(sourceTab, { key: "ArrowRight" });
    expect(outlineTab).toHaveFocus();
    expect(outlineTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(outlineTab, { key: "Home" });
    expect(sourceTab).toHaveFocus();
    expect(sourceTab).toHaveAttribute("aria-selected", "true");
  });

  it("places a compact toggle before the panel and supports pointer and keyboard resizing", () => {
    const { unmount } = render(<Harness />);

    const dock = screen.getByTestId("workspace-right-tool-dock");
    const toggle = screen.getByRole("button", { name: "Collapse workspace tools" });
    const resizeHandle = screen.getByRole("separator", { name: "Resize workspace tools" });

    expect(toggle).toHaveClass("absolute", "left-0", "size-6");
    expect(resizeHandle.tagName).toBe("HR");
    expect(resizeHandle).toHaveClass("h-full", "w-3", "cursor-ew-resize");
    expect(resizeHandle).toHaveAttribute("aria-valuemin", "360");
    expect(resizeHandle).toHaveAttribute("aria-valuemax", "768");
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "512");

    fireEvent.pointerDown(resizeHandle, { button: 0, clientX: 768, pointerId: 7 });
    fireEvent.pointerMove(resizeHandle, { clientX: 688, pointerId: 7 });
    fireEvent.pointerUp(resizeHandle, { clientX: 688, pointerId: 7 });

    expect(dock).toHaveStyle({ width: "592px" });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "592");

    fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });
    expect(dock).toHaveStyle({ width: "576px" });
    fireEvent.keyDown(resizeHandle, { key: "Home" });
    expect(dock).toHaveStyle({ width: "360px" });
    fireEvent.keyDown(resizeHandle, { key: "End" });
    expect(dock).toHaveStyle({ width: "768px" });

    fireEvent.click(toggle);
    expect(dock).toHaveStyle({ width: "12px" });
    expect(screen.queryByRole("separator", { name: "Resize workspace tools" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open workspace tools" }));
    expect(dock).toHaveStyle({ width: "768px" });

    unmount();
    render(<Harness />);
    expect(screen.getByTestId("workspace-right-tool-dock")).toHaveStyle({ width: "512px" });
  });

  it("resizes the left source and outline panel independently with pointer and keyboard input", () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open source and outline" }));

    const leftDock = screen.getByTestId("workspace-left-tool-dock");
    const rightDock = screen.getByTestId("workspace-right-tool-dock");
    const resizeHandle = screen.getByRole("separator", { name: "Resize source and outline" });

    expect(resizeHandle).toHaveAttribute("aria-valuemin", "360");
    expect(resizeHandle).toHaveAttribute("aria-valuemax", "768");
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "512");
    expect(resizeHandle.tagName).toBe("HR");
    expect(resizeHandle).toHaveClass("h-full", "w-3", "cursor-ew-resize");

    fireEvent.pointerDown(resizeHandle, { button: 0, clientX: 512, pointerId: 11 });
    fireEvent.pointerMove(resizeHandle, { clientX: 608, pointerId: 11 });
    fireEvent.pointerUp(resizeHandle, { clientX: 608, pointerId: 11 });

    expect(leftDock).toHaveStyle({ width: "608px" });
    expect(rightDock).toHaveStyle({ width: "512px" });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "608");

    fireEvent.keyDown(resizeHandle, { key: "ArrowLeft" });
    expect(leftDock).toHaveStyle({ width: "592px" });
    fireEvent.keyDown(resizeHandle, { key: "Home" });
    expect(leftDock).toHaveStyle({ width: "360px" });
    fireEvent.keyDown(resizeHandle, { key: "End" });
    expect(leftDock).toHaveStyle({ width: "768px" });

    fireEvent.click(screen.getByRole("button", { name: "Collapse source and outline" }));
    expect(screen.queryByRole("separator", { name: "Resize source and outline" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open source and outline" }));
    expect(leftDock).toHaveStyle({ width: "768px" });

    unmount();
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open source and outline" }));
    expect(screen.getByTestId("workspace-left-tool-dock")).toHaveStyle({ width: "512px" });
  });

  it("closes the narrow dialog with Escape and returns focus to its trigger", () => {
    render(<Harness narrow />);
    const trigger = screen.getByRole("button", { name: "Open workspace tools" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Workspace tools" });

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("returns focus to the compact toggle when the initially open desktop panel has no trigger", () => {
    render(<Harness />);
    const dock = screen.getByRole("complementary", { name: "Workspace tools" });
    const inspectorField = within(dock).getByLabelText("Inspector draft probe");
    inspectorField.focus();

    fireEvent.keyDown(dock, { key: "Escape" });

    expect(screen.getByRole("button", { name: "Open workspace tools" })).toHaveFocus();
    expect(document.getElementById("workspace-right-panel-content")).toHaveAttribute("inert");
  });

  it("keeps the panel open when a nested control consumes Escape", () => {
    render(<Harness />);

    fireEvent.keyDown(screen.getByLabelText("Inspector draft probe"), { key: "Escape" });

    expect(screen.getByRole("button", { name: "Collapse workspace tools" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("traps keyboard focus inside an open narrow tool sheet", () => {
    render(<Harness narrow />);
    fireEvent.click(screen.getByRole("button", { name: "Open workspace tools" }));
    const dialog = screen.getByRole("dialog", { name: "Workspace tools" });
    const close = within(dialog).getByRole("button", { name: "Collapse workspace tools" });
    const lastField = within(dialog).getByLabelText("Inspector draft probe");

    close.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(lastField).toHaveFocus();

    lastField.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(close).toHaveFocus();
  });

  it("traps focus in the narrow left sheet and returns it to the edge toggle", () => {
    render(<Harness narrow />);
    const sourceTrigger = screen.getByRole("button", { name: "Open source and outline" });
    fireEvent.click(sourceTrigger);
    const dialog = screen.getByRole("dialog", { name: "Source and outline" });
    const sourceField = within(dialog).getByLabelText("Source draft probe");

    sourceTrigger.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(sourceField).toHaveFocus();

    sourceField.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(sourceTrigger).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(sourceTrigger).toHaveFocus();
    expect(sourceTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens source as the explicit recovery exception", () => {
    render(<Harness initialSourceOpen />);

    expect(screen.getByRole("button", { name: "Collapse source and outline" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Source" })).not.toHaveAttribute("inert");
  });

  it("uses the opened panel or compact toggle reserve for the visible safe-area inset", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      if (this instanceof HTMLElement && this.dataset.testid === "canvas-workspace-shell") {
        return testRect(0, 720, 1_280);
      }
      if (this instanceof HTMLElement && this.dataset.testid === "workspace-right-tool-dock") {
        const expanded = this.dataset.panelState === "open";
        const width = expanded ? Number.parseFloat(this.style.width) || 512 : 12;
        return testRect(0, 720, width, 1_280 - width);
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

    expect(await screen.findByText(/"top":82/)).toBeVisible();
    expect(screen.getByText(/"right":524/)).toBeVisible();
    expect(screen.getByText(/"bottom":72/)).toBeVisible();
    expect(screen.getByText(/"left":24/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Open source and outline" }));
    expect(await screen.findByText(/"left":524/)).toBeVisible();
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize source and outline" }), {
      key: "ArrowRight",
    });
    expect(await screen.findByText(/"left":540/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Collapse source and outline" }));
    expect(await screen.findByText(/"left":24/)).toBeVisible();

    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize workspace tools" }), {
      key: "ArrowLeft",
    });
    expect(await screen.findByText(/"right":540/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace tools" }));
    expect(await screen.findByText(/"right":24/)).toBeVisible();
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
    initialLeftSurface: "SOURCE",
    initialLeftPanelOpen: initialSourceOpen,
    initialRightPanelOpen: true,
    isNarrow: narrow,
  });
  const [insets, setInsets] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  return (
    <CanvasWorkspaceShell
      surfaces={surfaces}
      commandBar={<p>Command bar</p>}
      diagram={<MountedDiagram onMount={diagramMounts} />}
      diagramTools={<h2>Editable ER diagram</h2>}
      source={<input aria-label="Source draft probe" defaultValue="" />}
      outline={<p>Outline content</p>}
      inspector={
        <div>
          <p>Inspector content</p>
          <input
            aria-label="Inspector draft probe"
            defaultValue=""
            onKeyDown={(event) => {
              if (event.key === "Escape") event.preventDefault();
            }}
          />
        </div>
      }
      status={<output>Insets {JSON.stringify(insets)}</output>}
      onViewportInsetsChange={setInsets}
    />
  );
}

function testRect(top: number, bottom: number, width: number, left = 0): DOMRect {
  return {
    x: left,
    y: top,
    top,
    right: left + width,
    bottom,
    left,
    width,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

function MountedDiagram({ onMount }: { readonly onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <div role="application">Persistent diagram</div>;
}
