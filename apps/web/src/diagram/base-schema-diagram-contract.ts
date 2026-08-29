import type { SchemaElementKey, SchemaGraph } from "@er-diagram/core";
import type { ComponentType } from "react";

import type { DiagramSelectionStore } from "./selection-store.js";
import type { DiagramSelection } from "./source-navigation.js";
import type {
  DiagramFocusRequest,
  DiagramLod,
  DiagramProjection,
  DiagramViewKey,
} from "./types.js";

export interface BaseSchemaDiagramProps {
  readonly graph: SchemaGraph;
  readonly viewKey: DiagramViewKey;
  readonly detailLevel: DiagramLod;
  readonly collapsedGroupKeys: ReadonlySet<SchemaElementKey>;
  readonly focusRequest?: DiagramFocusRequest | null;
  readonly selectionStore: DiagramSelectionStore;
  readonly sourceNavigationEnabled: boolean;
  readonly onToggleGroup: (groupKey: SchemaElementKey) => void;
  readonly onNavigateSource: (selection: DiagramSelection) => void;
  readonly requestLayout?: (projection: DiagramProjection) => Promise<DiagramProjection>;
}

export type BaseSchemaDiagramComponent = ComponentType<BaseSchemaDiagramProps>;
