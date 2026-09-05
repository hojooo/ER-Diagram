// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", () => ({
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children: ReactNode }) => children,
  Handle: () => null,
  NodeResizeControl: (props: Record<string, unknown>) => {
    const onResize = props.onResize as
      | ((event: unknown, params: { x: number; y: number; width: number; height: number }) => void)
      | undefined;
    const onResizeEnd = props.onResizeEnd as
      | ((event: unknown, params: { x: number; y: number; width: number; height: number }) => void)
      | undefined;
    const params = { x: 30, y: 40, width: 420, height: 240 };
    return (
      <button
        type="button"
        aria-label={`Resize ${String(props.position)}`}
        onMouseDown={() => onResize?.({}, params)}
        onMouseUp={() => onResizeEnd?.({}, params)}
      />
    );
  },
  Position: { Left: "left", Right: "right" },
  getSmoothStepPath: () => ["", 0, 0],
  getStraightPath: () => ["", 0, 0],
}));

import {
  DiagramInteractionContext,
  TableDiagramNodeComponent,
} from "../src/diagram/diagram-components.js";

afterEach(cleanup);

describe("diagram column inline edit trigger", () => {
  it("turns a column-row double click into one anchored edit request", () => {
    const editColumn = vi.fn();
    const activateElement = vi.fn();
    const props = {
      id: 'table:["public","users"]',
      type: "table",
      data: {
        kind: "table",
        tableKey: 'table:["public","users"]',
        schemaName: "public",
        name: "users",
        columns: [
          {
            key: 'column:["public","users","id"]',
            name: "id",
            type: "bigint",
            primaryKey: true,
            foreignKey: false,
            partialName: null,
          },
        ],
        lod: "FULL",
      },
    } as unknown as ComponentProps<typeof TableDiagramNodeComponent>;

    render(
      <DiagramInteractionContext.Provider
        value={{
          toggleGroup: vi.fn(),
          activateElement,
          editColumn,
          showEdgeLabels: true,
        }}
      >
        <TableDiagramNodeComponent {...props} />
      </DiagramInteractionContext.Provider>,
    );

    const row = screen.getByRole("button", { name: /id, bigint, PK/ });
    fireEvent.doubleClick(row);

    expect(editColumn).toHaveBeenCalledOnce();
    expect(editColumn).toHaveBeenCalledWith({
      selection: {
        elementKey: 'column:["public","users","id"]',
        kind: "column",
        tableKeys: ['table:["public","users"]'],
      },
      anchor: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(row).toHaveAttribute("data-diagram-column-key", 'column:["public","users","id"]');
  });

  it("shows three handles for the selected table and commits only on resize end", () => {
    const resizeTable = vi.fn();
    const tableKey = 'table:["public","users"]';
    const props = {
      id: tableKey,
      type: "table",
      data: {
        kind: "table",
        tableKey,
        schemaName: "public",
        name: "users",
        columns: [],
        lod: "FULL",
        selectedElementKey: tableKey,
      },
    } as unknown as ComponentProps<typeof TableDiagramNodeComponent>;

    render(
      <DiagramInteractionContext.Provider
        value={{
          toggleGroup: vi.fn(),
          activateElement: vi.fn(),
          editColumn: vi.fn(),
          resizeTable,
          showEdgeLabels: true,
        }}
      >
        <TableDiagramNodeComponent {...props} />
      </DiagramInteractionContext.Provider>,
    );

    expect(screen.getByRole("button", { name: "Resize right" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Resize bottom" })).toBeVisible();
    const corner = screen.getByRole("button", { name: "Resize bottom-right" });
    fireEvent.mouseDown(corner);
    expect(resizeTable).not.toHaveBeenCalled();
    fireEvent.mouseUp(corner);
    expect(resizeTable).toHaveBeenCalledOnce();
    expect(resizeTable).toHaveBeenCalledWith({
      tableKey,
      x: 30,
      y: 40,
      width: 420,
      height: 240,
    });
  });
});
