import type {
  DiagramLayoutDirection,
  LayoutWorkerErrorListener,
  LayoutWorkerLike,
  LayoutWorkerMessageListener,
  LayoutWorkerRequest,
} from "./layout-worker-contract.js";
import { DEFAULT_LAYOUT_TIMEOUT_MS } from "./layout-worker-contract.js";
import type { DiagramProjection } from "./types.js";

export class LayoutClientError extends Error {
  constructor(
    readonly code: "LAYOUT_ERROR" | "LAYOUT_TIMEOUT" | "LAYOUT_WORKER_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "LayoutClientError";
  }
}

export interface WorkerLayoutOptions {
  direction?: DiagramLayoutDirection;
  timeoutMs?: number;
  workerFactory?: () => LayoutWorkerLike;
}

let nextRequestNumber = 1;

export function requestWorkerLayout(
  projection: DiagramProjection,
  options: WorkerLayoutOptions = {},
): Promise<DiagramProjection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LAYOUT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError("layout worker timeout must be a finite positive number"));
  }

  const worker = (options.workerFactory ?? createBrowserLayoutWorker)();
  const requestId = `layout-${nextRequestNumber}`;
  nextRequestNumber += 1;

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.terminate();
    };
    const handleMessage: LayoutWorkerMessageListener = (event) => {
      if (event.data.requestId !== requestId) return;
      cleanup();
      if (event.data.ok) {
        resolve(event.data.projection);
      } else {
        reject(new LayoutClientError(event.data.error.code, event.data.error.message));
      }
    };
    const handleError: LayoutWorkerErrorListener = (event) => {
      cleanup();
      reject(
        new LayoutClientError("LAYOUT_WORKER_ERROR", event.message || "The layout worker failed."),
      );
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new LayoutClientError(
          "LAYOUT_TIMEOUT",
          `Diagram layout exceeded the ${timeoutMs} ms limit.`,
        ),
      );
    }, timeoutMs);
    const request: LayoutWorkerRequest = {
      requestId,
      projection,
      ...(options.direction ? { options: { direction: options.direction } } : {}),
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage(request);
  });
}

function createBrowserLayoutWorker(): LayoutWorkerLike {
  const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
  return {
    postMessage: (message) => worker.postMessage(message),
    addEventListener: (type, listener) => worker.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) =>
      worker.removeEventListener(type, listener as EventListener),
    terminate: () => worker.terminate(),
  } as LayoutWorkerLike;
}
