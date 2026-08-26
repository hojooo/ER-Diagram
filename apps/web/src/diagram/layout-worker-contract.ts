import type { DiagramProjection } from "./types.js";

export const DEFAULT_LAYOUT_TIMEOUT_MS = 10_000;
export type DiagramLayoutDirection = "DOWN" | "LEFT" | "RIGHT" | "UP";

export interface SerializableDiagramLayoutOptions {
  direction?: DiagramLayoutDirection;
}

export interface LayoutWorkerRequest {
  requestId: string;
  projection: DiagramProjection;
  options?: SerializableDiagramLayoutOptions;
}

export type LayoutWorkerResponse =
  | {
      requestId: string;
      ok: true;
      projection: DiagramProjection;
    }
  | {
      requestId: string;
      ok: false;
      error: {
        code: "LAYOUT_ERROR";
        message: string;
      };
    };

export type LayoutWorkerMessageListener = (event: MessageEvent<LayoutWorkerResponse>) => void;
export type LayoutWorkerErrorListener = (event: ErrorEvent) => void;

export interface LayoutWorkerLike {
  postMessage(message: LayoutWorkerRequest): void;
  addEventListener(type: "message", listener: LayoutWorkerMessageListener): void;
  addEventListener(type: "error", listener: LayoutWorkerErrorListener): void;
  removeEventListener(type: "message", listener: LayoutWorkerMessageListener): void;
  removeEventListener(type: "error", listener: LayoutWorkerErrorListener): void;
  terminate(): void;
}
