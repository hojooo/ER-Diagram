// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { ProjectRevisionsResponse, SchemaRevisionSummary } from "@er-diagram/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SchemaHistoryControls } from "../src/history/history-controls.js";
import type {
  SchemaHistoryPoint,
  SchemaHistorySessionController,
  SchemaHistorySessionSnapshot,
  SchemaHistoryStep,
} from "../src/history/history-session.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const HASH_3 = "3".repeat(64);

afterEach(cleanup);

describe("accessible schema history controls", () => {
  it("reports undo and redo depth, disables unavailable actions, and announces work", async () => {
    const past = step(point(1, HASH_1), point(2, HASH_2));
    const future = step(point(2, HASH_2), point(3, HASH_3));
    const session = createFakeSession(
      snapshot({
        current: point(2, HASH_2),
        past: [past],
        future: [future],
      }),
    );

    render(
      <SchemaHistoryControls
        session={session.controller}
        loadRevisions={async () => ({ revisions: [] })}
      />,
    );

    const undo = screen.getByRole("button", {
      name: "Undo schema change, 1 step available",
    });
    const redo = screen.getByRole("button", {
      name: "Redo schema change, 1 step available",
    });
    expect(undo).toBeEnabled();
    expect(redo).toBeEnabled();
    expect(screen.getByText(/1 undo and 1 redo steps available/)).toBeInTheDocument();

    fireEvent.click(undo);
    expect(session.undo).toHaveBeenCalledOnce();
    await act(async () => {
      session.publish(
        snapshot({
          status: "UNDOING",
          locked: true,
          current: point(2, HASH_2),
          past: [past],
          future: [future],
        }),
      );
    });
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();
    expect(screen.getByText("Undoing the last schema revision.")).toBeInTheDocument();
  });

  it("keeps durable history readable while another workspace mutation disables history writes", async () => {
    const committed = step(point(1, HASH_1), point(2, HASH_2));
    const session = createFakeSession(snapshot({ current: point(2, HASH_2), past: [committed] }));
    render(
      <SchemaHistoryControls
        session={session.controller}
        interactionDisabled
        loadRevisions={async () => ({
          revisions: [revision(2, "VALID", HASH_2), revision(1, "VALID", HASH_1)],
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Undo schema change, 1 step available" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Revision history" }));
    const dialog = await screen.findByRole("dialog", { name: "Revision history" });
    expect(dialog).toBeVisible();
    expect(
      await within(dialog).findByRole("button", { name: "Restore revision 1" }),
    ).toBeDisabled();
  });

  it("loads source-free revision summaries newest-first and protects the current revision", async () => {
    const session = createFakeSession(snapshot({ current: point(3, HASH_3) }));
    const loadRevisions = vi.fn(
      async (): Promise<ProjectRevisionsResponse> => ({
        revisions: [
          revision(1, "VALID", HASH_3),
          revision(3, "VALID", HASH_3),
          revision(2, "INVALID", HASH_2),
        ],
      }),
    );

    render(<SchemaHistoryControls session={session.controller} loadRevisions={loadRevisions} />);
    expect(loadRevisions).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Revision history" }));
    const dialog = await screen.findByRole("dialog", { name: "Revision history" });
    const rows = await within(dialog).findAllByRole("article");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Revision 3",
      "Revision 2",
      "Revision 1",
    ]);
    const [currentRow, invalidRow, sameSourceRow] = rows;
    if (!currentRow || !invalidRow || !sameSourceRow) {
      throw new Error("Expected current, invalid, and same-source revision rows.");
    }
    expect(within(currentRow).getByRole("button", { name: "Current revision" })).toBeDisabled();
    expect(within(invalidRow).getByRole("button", { name: "Restore revision 2" })).toBeEnabled();
    expect(within(sameSourceRow).getByRole("button", { name: "Restore revision 1" })).toBeEnabled();
    expect(dialog).toHaveTextContent("1 errors · 2 warnings · 3 info");
    expect(dialog).toHaveTextContent(HASH_2);
    expect(dialog).toHaveTextContent("Parser");
    expect(dialog).toHaveTextContent("9.1.1");
    expect(dialog).not.toHaveTextContent("SECRET HISTORICAL SOURCE");
    expect(loadRevisions).toHaveBeenCalledOnce();
  });

  it("allows invalid restore, focuses Cancel first, and refreshes durable history on success", async () => {
    const session = createFakeSession(snapshot({ current: point(3, HASH_3) }));
    const initial = {
      revisions: [revision(3, "VALID", HASH_3), revision(2, "INVALID", HASH_2)],
    };
    const refreshed = {
      revisions: [
        revision(4, "INVALID", HASH_2, "RESTORE"),
        revision(3, "VALID", HASH_3),
        revision(2, "INVALID", HASH_2),
      ],
    };
    const loadRevisions = vi
      .fn<() => Promise<ProjectRevisionsResponse>>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    session.restore.mockImplementation(async (target) => {
      expect(target).toEqual({ revisionNo: 2, sourceHash: HASH_2 });
      session.publish(
        snapshot({
          status: "SUCCEEDED",
          current: point(4, HASH_2, "INVALID", "RESTORE"),
        }),
      );
    });

    render(<SchemaHistoryControls session={session.controller} loadRevisions={loadRevisions} />);
    fireEvent.click(screen.getByRole("button", { name: "Revision history" }));
    const historyDialog = await screen.findByRole("dialog", { name: "Revision history" });
    fireEvent.click(
      await within(historyDialog).findByRole("button", { name: "Restore revision 2" }),
    );

    const confirmation = await screen.findByRole("dialog", { name: "Restore revision 2?" });
    expect(confirmation).toHaveTextContent("last-valid diagram remains available");
    expect(confirmation).toHaveTextContent("Diagram layouts are not restored");
    await waitFor(() =>
      expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );

    fireEvent.click(within(confirmation).getByRole("button", { name: "Restore revision 2" }));
    await waitFor(() => expect(session.restore).toHaveBeenCalledOnce());
    await waitFor(() => expect(loadRevisions).toHaveBeenCalledTimes(2));
    expect(await within(historyDialog).findByRole("article", { name: "Revision 4" })).toBeVisible();
    expect(screen.getByText("Schema history operation completed.")).toBeInTheDocument();
  });

  it("cancels restore without a write and offers exact-request safe retry for unknown outcomes", async () => {
    const pendingStep = step(point(1, HASH_1), point(2, HASH_2));
    const session = createFakeSession(
      snapshot({
        status: "UNKNOWN_OUTCOME",
        locked: true,
        current: point(2, HASH_2),
        past: [pendingStep],
        error: {
          code: "CLIENT_HISTORY_OUTCOME_UNKNOWN",
          message: "The history outcome could not be confirmed.",
          correlationId: "550e8400-e29b-41d4-a716-446655440000",
        },
        pendingOperation: {
          kind: "UNDO",
          request: {
            projectId: PROJECT_ID,
            source: "Table public.one { id int }",
            expectedSchemaRevisionNo: 2,
            commandId: "550e8400-e29b-41d4-a716-446655440000",
          },
          step: pendingStep,
          before: point(2, HASH_2),
          targetSource: "Table public.one { id int }",
          targetSourceHash: HASH_1,
          expectedOrigin: "SOURCE_EDIT",
        },
      }),
    );
    session.retrySafely.mockImplementation(async () => {
      session.publish(snapshot({ status: "SUCCEEDED", current: point(2, HASH_2) }));
    });

    render(
      <SchemaHistoryControls
        session={session.controller}
        loadRevisions={async () => ({
          revisions: [revision(2, "VALID", HASH_2), revision(1, "VALID", HASH_1)],
        })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("550e8400-e29b-41d4-a716-446655440000");
    const retry = screen.getByRole("button", { name: "Retry safely" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(session.retrySafely).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Revision history" }));
    const dialog = await screen.findByRole("dialog", { name: "Revision history" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Restore revision 1" }));
    const confirmation = await screen.findByRole("dialog", { name: "Restore revision 1?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Restore revision 1?" })).not.toBeInTheDocument(),
    );
    expect(session.restore).not.toHaveBeenCalled();
  });
});

function createFakeSession(initial: SchemaHistorySessionSnapshot) {
  let current = initial;
  const listeners = new Set<() => void>();
  const undo = vi.fn(async () => undefined);
  const redo = vi.fn(async () => undefined);
  const restore = vi.fn(async (_target: { revisionNo: number; sourceHash: string }) => undefined);
  const retrySafely = vi.fn(async () => undefined);
  const controller: SchemaHistorySessionController = {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recordCommitted: vi.fn(),
    undo,
    redo,
    restore,
    retrySafely,
    adoptExternalState: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    controller,
    undo,
    redo,
    restore,
    retrySafely,
    publish(next: SchemaHistorySessionSnapshot) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

function snapshot(
  overrides: Partial<SchemaHistorySessionSnapshot> & {
    readonly current?: SchemaHistoryPoint;
  } = {},
): SchemaHistorySessionSnapshot {
  const past = overrides.past ?? [];
  const future = overrides.future ?? [];
  const locked = overrides.locked ?? false;
  return {
    status: overrides.status ?? "IDLE",
    locked,
    current: overrides.current ?? point(3, HASH_3),
    past,
    future,
    canUndo: overrides.canUndo ?? (!locked && past.length > 0),
    canRedo: overrides.canRedo ?? (!locked && future.length > 0),
    error: overrides.error ?? null,
    pendingOperation: overrides.pendingOperation ?? null,
  };
}

function point(
  revisionNo: number,
  sourceHash: string,
  validity: "VALID" | "INVALID" = "VALID",
  origin: SchemaHistoryPoint["origin"] = "SOURCE_EDIT",
): SchemaHistoryPoint {
  return {
    revisionNo,
    source: `Table public.revision_${revisionNo} { id int }`,
    sourceHash,
    validity,
    origin,
  };
}

function step(before: SchemaHistoryPoint, after: SchemaHistoryPoint): SchemaHistoryStep {
  return { kind: "SOURCE_EDIT", before, after };
}

function revision(
  revisionNo: number,
  validity: "VALID" | "INVALID",
  sourceHash: string,
  origin: SchemaRevisionSummary["origin"] = "SOURCE_EDIT",
): SchemaRevisionSummary {
  return {
    id: `019d3f4e-7b6c-7ab${revisionNo}-8def-0123456789ab`,
    projectId: PROJECT_ID,
    revisionNo,
    sourceHash,
    validity,
    origin,
    parserVersion: "9.1.1",
    diagnosticSummary: {
      errors: validity === "INVALID" ? 1 : 0,
      warnings: 2,
      infos: 3,
      parserVersion: "9.1.1",
    },
    createdAt: `2026-08-${String(20 + revisionNo).padStart(2, "0")}T01:02:03.004Z`,
  };
}
