import type { DiagramNodePlacement, DiagramPosition, DiagramViewport } from "@er-diagram/contracts";
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
  readonly onActivateElement?: (selection: DiagramSelection) => void;
  readonly onEditColumn?: (request: DiagramColumnEditRequest) => void;
  readonly viewportInsets?: DiagramViewportInsets;
  readonly fillContainer?: boolean;
  readonly requestLayout?: (projection: DiagramProjection) => Promise<DiagramProjection>;
  readonly layoutPositions?: Readonly<Record<SchemaElementKey, DiagramNodePlacement>>;
  readonly layoutPending?: boolean;
  readonly layoutRequest?: DiagramLayoutRequest | null;
  readonly interactionDisabled?: boolean;
  readonly onPositionsCommit?: (
    positions: Readonly<Record<SchemaElementKey, DiagramPosition>>,
  ) => void;
  readonly onTableResizeCommit?: (
    tableKey: SchemaElementKey,
    placement: Required<DiagramNodePlacement>,
  ) => void;
  readonly onLayoutRequestReady?: (result: DiagramLayoutRequestResult) => void;
  readonly onRenderedLayoutReady?: (
    positions: Readonly<Record<SchemaElementKey, DiagramPosition>>,
    viewport: DiagramViewport,
  ) => void;
}

export interface DiagramColumnEditRequest {
  readonly selection: DiagramSelection;
  readonly anchor: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
}

export interface DiagramTableResizeRequest {
  readonly tableKey: SchemaElementKey;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DiagramViewportInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface DiagramLayoutRequest {
  readonly requestId: number;
  readonly mode: "PREVIEW" | "RESET";
}

export interface DiagramLayoutRequestResult {
  readonly requestId: number;
  readonly mode: DiagramLayoutRequest["mode"];
  readonly succeeded: boolean;
  readonly positions: Readonly<Record<SchemaElementKey, DiagramPosition>>;
  readonly viewport: DiagramViewport;
}

export type BaseSchemaDiagramComponent = ComponentType<BaseSchemaDiagramProps>;
