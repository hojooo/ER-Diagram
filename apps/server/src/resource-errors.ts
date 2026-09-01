export type ResourceOperationErrorCode =
  | "RESOURCE_COMPLEXITY_LIMIT_EXCEEDED"
  | "RESOURCE_OUTPUT_TOO_LARGE"
  | "RESOURCE_SOURCE_TOO_LARGE"
  | "RESOURCE_WORKER_BUSY"
  | "RESOURCE_WORKER_CRASHED"
  | "RESOURCE_WORKER_TIMEOUT";

export class ResourceOperationError extends Error {
  constructor(readonly code: ResourceOperationErrorCode) {
    super(publicResourceErrorMessage(code));
    this.name = "ResourceOperationError";
  }
}

export function publicResourceErrorMessage(code: ResourceOperationErrorCode): string {
  switch (code) {
    case "RESOURCE_SOURCE_TOO_LARGE":
      return "The source exceeds the configured UTF-8 byte limit.";
    case "RESOURCE_COMPLEXITY_LIMIT_EXCEEDED":
      return "The schema exceeds the configured complexity limit.";
    case "RESOURCE_OUTPUT_TOO_LARGE":
      return "Generated output exceeds the configured byte limit.";
    case "RESOURCE_WORKER_BUSY":
      return "Schema workers are busy. Retry the request shortly.";
    case "RESOURCE_WORKER_TIMEOUT":
      return "Schema processing exceeded the configured time limit.";
    case "RESOURCE_WORKER_CRASHED":
      return "Schema processing stopped unexpectedly.";
  }
}
