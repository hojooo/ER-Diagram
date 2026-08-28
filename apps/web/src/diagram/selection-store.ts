import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";

import type { DiagramSelection } from "./source-navigation.js";

export interface DiagramSelectionState {
  selection: DiagramSelection | null;
  setSelection(selection: DiagramSelection | null): void;
}

export type DiagramSelectionStore = StoreApi<DiagramSelectionState>;

export function createDiagramSelectionStore(): DiagramSelectionStore {
  return createStore<DiagramSelectionState>((set) => ({
    selection: null,
    setSelection: (selection) => set({ selection }),
  }));
}
