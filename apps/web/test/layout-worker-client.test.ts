import { describe, expect, it, vi } from "vitest";
import { requestWorkerLayout } from "../src/diagram/layout-worker-client.js";
import type {
  LayoutWorkerLike,
  LayoutWorkerResponse,
} from "../src/diagram/layout-worker-contract.js";
import type { DiagramProjection } from "../src/diagram/types.js";

const emptyProjection: DiagramProjection = {
  viewKey: "GLOBAL",
  lod: "NAME_ONLY",
  nodes: [],
  edges: [],
};

describe("layout worker client", () => {
  it("resolves the matching worker response and terminates the one-shot worker", async () => {
    const worker = new FakeWorker((requestId, emit) => {
      queueMicrotask(() => emit({ requestId, ok: true, projection: emptyProjection }));
    });

    await expect(
      requestWorkerLayout(emptyProjection, { timeoutMs: 100, workerFactory: () => worker }),
    ).resolves.toEqual(emptyProjection);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects and terminates the worker when the layout timeout expires", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(() => undefined);
    const result = requestWorkerLayout(emptyProjection, {
      timeoutMs: 10,
      workerFactory: () => worker,
    });
    const rejection = expect(result).rejects.toMatchObject({ code: "LAYOUT_TIMEOUT" });

    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("maps a browser worker error to an explicit client error", async () => {
    const worker = new FakeWorker(() => undefined);
    const result = requestWorkerLayout(emptyProjection, {
      timeoutMs: 100,
      workerFactory: () => worker,
    });

    worker.emitError("worker crashed");

    await expect(result).rejects.toMatchObject({
      code: "LAYOUT_WORKER_ERROR",
      message: "worker crashed",
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

class FakeWorker implements LayoutWorkerLike {
  readonly terminate = vi.fn();
  private messageListener: ((event: MessageEvent<LayoutWorkerResponse>) => void) | undefined;
  private errorListener: ((event: ErrorEvent) => void) | undefined;

  constructor(
    private readonly onPost: (
      requestId: string,
      emit: (response: LayoutWorkerResponse) => void,
    ) => void,
  ) {}

  postMessage(message: { requestId: string }): void {
    this.onPost(message.requestId, (response) => {
      this.messageListener?.({ data: response } as MessageEvent<LayoutWorkerResponse>);
    });
  }

  emitError(message: string): void {
    this.errorListener?.({ message } as ErrorEvent);
  }

  addEventListener(type: "message" | "error", listener: EventListener): void {
    if (type === "message") {
      this.messageListener = listener as (event: MessageEvent<LayoutWorkerResponse>) => void;
    } else {
      this.errorListener = listener as (event: ErrorEvent) => void;
    }
  }

  removeEventListener(type: "message" | "error", _listener: EventListener): void {
    if (type === "message") {
      this.messageListener = undefined;
    } else {
      this.errorListener = undefined;
    }
  }
}
