import type { SchemaElementKey } from "@er-diagram/core";

export function toggleCollapsedGroup(
  current: ReadonlySet<SchemaElementKey>,
  groupKey: SchemaElementKey,
): ReadonlySet<SchemaElementKey> {
  const next = new Set(current);
  if (next.has(groupKey)) next.delete(groupKey);
  else next.add(groupKey);
  return next;
}

export function retainAvailableCollapsedGroups(
  current: ReadonlySet<SchemaElementKey>,
  availableGroupKeys: ReadonlySet<SchemaElementKey>,
): ReadonlySet<SchemaElementKey> {
  const next = new Set([...current].filter((groupKey) => availableGroupKeys.has(groupKey)));
  if (next.size === current.size && [...next].every((groupKey) => current.has(groupKey))) {
    return current;
  }
  return next;
}
