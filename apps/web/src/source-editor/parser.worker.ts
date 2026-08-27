/// <reference lib="webworker" />

import { handleDbmlParserWorkerRequest } from "./parser-worker-handler.js";

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", async (event: MessageEvent<unknown>) => {
  try {
    workerScope.postMessage(await handleDbmlParserWorkerRequest(event.data));
  } catch {
    throw new Error("The DBML parser worker could not process its request.");
  }
});
