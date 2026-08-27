import type { SchemaGraph } from "@er-diagram/core";
import type { ComponentType } from "react";

import type { DiagramSelectionStore } from "./selection-store.js";
import type { DiagramSelection } from "./source-navigation.js";
import type { DiagramProjection } from "./types.js";

export interface BaseSchemaDiagramProps {
  readonly graph: SchemaGraph;
  readonly selectionStore: DiagramSelectionStore;
  readonly sourceNavigationEnabled: boolean;
  readonly onNavigateSource: (selection: DiagramSelection) => void;
  readonly requestLayout?: (projection: DiagramProjection) => Promise<DiagramProjection>;
}

export type BaseSchemaDiagramComponent = ComponentType<BaseSchemaDiagramProps>;
