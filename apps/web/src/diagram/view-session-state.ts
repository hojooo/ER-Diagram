import type { SchemaElementKey, SchemaGraph } from "@er-diagram/core";

import { retainAvailableCollapsedGroups } from "./collapse-state.js";
import { GLOBAL_VIEW_KEY } from "./projection.js";
import type { DiagramLod, DiagramViewKey } from "./types.js";

export interface DiagramViewSessionState {
  detailLevel: DiagramLod;
  collapsedGroupKeys: ReadonlySet<SchemaElementKey>;
}

export type DiagramViewSessions = ReadonlyMap<DiagramViewKey, DiagramViewSessionState>;

export function reconcileDiagramViewSessions(
  graph: SchemaGraph,
  current: DiagramViewSessions,
): DiagramViewSessions {
  const availableGroupKeys = new Set(graph.groups.map((group) => group.key));
  const viewKeys: DiagramViewKey[] = [GLOBAL_VIEW_KEY, ...graph.views.map((view) => view.key)];
  const next = new Map<DiagramViewKey, DiagramViewSessionState>();

  for (const viewKey of viewKeys) {
    const previous = current.get(viewKey);
    next.set(
      viewKey,
      previous
        ? {
            detailLevel: previous.detailLevel,
            collapsedGroupKeys: retainAvailableCollapsedGroups(
              previous.collapsedGroupKeys,
              availableGroupKeys,
            ),
          }
        : createDefaultDiagramViewSessionState(),
    );
  }
  return next;
}

export function updateDiagramViewSession(
  sessions: DiagramViewSessions,
  viewKey: DiagramViewKey,
  state: DiagramViewSessionState,
): DiagramViewSessions {
  const next = new Map(sessions);
  next.set(viewKey, {
    detailLevel: state.detailLevel,
    collapsedGroupKeys: new Set(state.collapsedGroupKeys),
  });
  return next;
}

export function resolveDiagramViewKey(
  graph: SchemaGraph,
  requestedViewKey: DiagramViewKey,
): DiagramViewKey {
  if (requestedViewKey === GLOBAL_VIEW_KEY) return GLOBAL_VIEW_KEY;
  return graph.views.some((view) => view.key === requestedViewKey)
    ? requestedViewKey
    : GLOBAL_VIEW_KEY;
}

export function createDefaultDiagramViewSessionState(): DiagramViewSessionState {
  return { detailLevel: "FULL", collapsedGroupKeys: new Set() };
}
