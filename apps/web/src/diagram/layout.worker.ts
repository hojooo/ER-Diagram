/// <reference lib="webworker" />

import ElkApi from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import { layoutDiagram } from "./elk-layout.js";
import type { LayoutWorkerRequest, LayoutWorkerResponse } from "./layout-worker-contract.js";

const workerScope = self as DedicatedWorkerGlobalScope;
const engine = new ElkApi({ workerUrl: elkWorkerUrl });

workerScope.addEventListener("message", async (event: MessageEvent<LayoutWorkerRequest>) => {
  const { requestId, projection, options } = event.data;
  let response: LayoutWorkerResponse;
  try {
    response = {
      requestId,
      ok: true,
      projection: await layoutDiagram(projection, { ...options, engine }),
    };
  } catch (error) {
    response = {
      requestId,
      ok: false,
      error: {
        code: "LAYOUT_ERROR",
        message: error instanceof Error ? error.message : "Diagram layout failed.",
      },
    };
  }
  workerScope.postMessage(response);
});
