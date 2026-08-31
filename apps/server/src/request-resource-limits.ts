import { utf8ByteLength } from "@er-diagram/contracts";

import { ResourceOperationError } from "./resource-errors.js";
import type { ServerResourceLimits } from "./resource-limits.js";

export function assertSourceWithinLimit(source: string, limits: ServerResourceLimits): void {
  if (utf8ByteLength(source) > limits.maxSourceBytes) {
    throw new ResourceOperationError("RESOURCE_SOURCE_TOO_LARGE");
  }
}

export function assertLayoutWithinLimit(
  positions: Readonly<Record<string, unknown>>,
  limits: ServerResourceLimits,
): void {
  if (Object.keys(positions).length > limits.maxLayoutNodes) {
    throw new ResourceOperationError("RESOURCE_COMPLEXITY_LIMIT_EXCEEDED");
  }
}
